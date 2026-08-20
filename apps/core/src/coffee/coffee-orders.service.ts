import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { coffeeOrder, entity } from "@mydon/db";
import { machineSerialKeys, normalizeMachineSerial, orderIsCountable, orderIsDelivered } from "@mydon/shared";
import { DB, type Db } from "../db/db.module";

/**
 * Проданные чашки кофе как ФАКТ.
 *
 * До этой службы выручка кофе не участвовала в аналитике вовсе: заказы лежали
 * в сыром слое распечаткой источника, а панель показывала только снек — 9,5 млн
 * в месяц при фактических ~50. Здесь сырьё превращается в строки, по которым
 * можно считать: выручку по периодам, выработку по автоматам, спрос по товарам
 * и — дальше — расход сырья за период работы бункера.
 *
 * Правило «что считать продажей» не живёт здесь: оно в `@mydon/shared`
 * (`orderIsCountable`), общее с отчётами, иначе дашборд и расход разошлись бы.
 */

/** Заказ, приведённый к общему виду: обе выгрузки источника сводятся сюда. */
export interface CoffeeOrderInput {
  extId: string;
  /** ISO-время создания заказа. */
  ts: string;
  brewedAt?: string | null;
  machineSerial: string;
  address?: string | null;
  goodsName: string;
  flavourName?: string | null;
  amount?: number | string | null;
  paymentStatus?: string | null;
  brewStatus?: string | null;
  orderResource?: string | null;
}

export interface IngestResult {
  принято: number;
  вставлено: number;
  обновлено: number;
  вВыручке: number;
  безАвтомата: number;
  битыхСтрок: number;
  /** Повторы одного заказа внутри запроса, схлопнутые перед записью. */
  дублейВПачке: number;
}

@Injectable()
export class CoffeeOrdersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Загрузить заказы. Идемпотентно по паре (источник, номер заказа): повторная
   * выгрузка не двоит строки, но ОБНОВЛЯЕТ статусы — заказ, оплаченный вчера и
   * возвращённый сегодня, обязан перестать считаться продажей.
   *
   * Пишем пачками: выгрузка приходит десятками тысяч строк, а один оператор
   * INSERT на такую длину упирается в предел параметров запроса.
   */
  async ingest(source: string, rows: readonly CoffeeOrderInput[]): Promise<IngestResult> {
    const итог: IngestResult = {
      принято: rows.length,
      вставлено: 0,
      обновлено: 0,
      вВыручке: 0,
      безАвтомата: 0,
      битыхСтрок: 0,
      дублейВПачке: 0,
    };
    if (rows.length === 0) return итог;

    // Карта «серийник → карточка». Обе формы написания, как в разборе источников:
    // канон и то, что реально лежит в externalRef.
    const машины = await this.db
      .select({ id: entity.id, ref: entity.externalRef })
      .from(entity)
      .where(eq(entity.type, "machine"));
    const поСерийнику = new Map<string, string>();
    for (const m of машины) {
      for (const k of machineSerialKeys(m.ref)) if (k) поСерийнику.set(k, m.id);
    }

    const значения: (typeof coffeeOrder.$inferInsert)[] = [];
    for (const r of rows) {
      const ts = new Date(r.ts);
      if (!r.extId || !r.machineSerial || !r.goodsName || Number.isNaN(ts.getTime())) {
        итог.битыхСтрок += 1;
        continue;
      }
      const brewed = r.brewedAt ? new Date(r.brewedAt) : null;
      // Сумма считается ДО правила: нулевая цена — признак бесплатной выдачи,
      // и правило обязано её видеть.
      const сумма = Number(r.amount ?? 0);
      const считается = orderIsCountable({ ...r, amount: сумма });
      const ключ = String(r.machineSerial).trim().toLowerCase();
      const machineId = поСерийнику.get(ключ) ?? поСерийнику.get(normalizeMachineSerial(ключ)) ?? null;
      значения.push({
        extId: r.extId,
        source,
        ts,
        brewedAt: brewed && !Number.isNaN(brewed.getTime()) ? brewed : null,
        machineSerial: String(r.machineSerial).trim(),
        machineId,
        address: r.address ?? null,
        goodsName: String(r.goodsName).trim(),
        flavourName: r.flavourName ?? null,
        amount: String(Number.isFinite(сумма) ? сумма : 0),
        paymentStatus: r.paymentStatus ?? null,
        brewStatus: r.brewStatus ?? null,
        orderResource: r.orderResource ?? null,
        countable: считается,
      });
    }

    // Один заказ может лежать в выгрузке несколькими одинаковыми строками —
    // в живом снимке заказ vip1760347… повторён четыре раза подряд. Два
    // одинаковых ключа В ОДНОМ операторе INSERT Postgres не принимает
    // («cannot affect row a second time»), поэтому схлопываем до пачек:
    // побеждает последняя строка — ровно как вёл бы себя onConflictDoUpdate.
    const поКлючу = new Map<string, (typeof coffeeOrder.$inferInsert)>();
    for (const v of значения) поКлючу.set(v.extId, v);
    const уникальные = [...поКлючу.values()];
    итог.дублейВПачке = значения.length - уникальные.length;
    for (const v of уникальные) {
      if (v.machineId === null) итог.безАвтомата += 1;
      if (v.countable) итог.вВыручке += 1;
    }

    const ПАЧКА = 500;
    for (let i = 0; i < уникальные.length; i += ПАЧКА) {
      const кусок = уникальные.slice(i, i + ПАЧКА);
      const записано = await this.db
        .insert(coffeeOrder)
        .values(кусок)
        .onConflictDoUpdate({
          target: [coffeeOrder.source, coffeeOrder.extId],
          set: {
            amount: sql`excluded.amount`,
            paymentStatus: sql`excluded.payment_status`,
            brewStatus: sql`excluded.brew_status`,
            orderResource: sql`excluded.order_resource`,
            countable: sql`excluded.countable`,
            machineId: sql`coalesce(excluded.machine_id, ${coffeeOrder.machineId})`,
            brewedAt: sql`coalesce(excluded.brewed_at, ${coffeeOrder.brewedAt})`,
          },
        })
        .returning({ id: coffeeOrder.id, imported: coffeeOrder.importedAt });
      итог.вставлено += записано.length;
    }
    // Вставленные и обновлённые здесь неразличимы: onConflictDoUpdate возвращает
    // и те и другие. Честнее назвать это «записано», чем гадать.
    итог.обновлено = 0;
    return итог;
  }

  /** Сводка выручки: всего, по месяцам, по автоматам, по товарам. */
  async summary(from?: string, to?: string): Promise<{
    период: { from: string | null; to: string | null };
    всего: { чашек: number; выручка: number; среднийЧек: number };
    /** Доля VIP-карт внутри «всего» — владелец решает, служебные они или клиентские. */
    vip: { чашек: number; выручка: number };
    неВыдано: number;
    поМесяцам: { месяц: string; чашек: number; выручка: number }[];
    поАвтоматам: { машина: string; чашек: number; выручка: number }[];
    поТоварам: { товар: string; чашек: number; выручка: number }[];
  }> {
    const усл = [eq(coffeeOrder.countable, true)];
    // Голая дата «2026-08-01» — календарный день по Ташкенту, а не полночь UTC:
    // new Date() на такой строке дал бы мгновение на пять часов раньше, и в
    // сводку заезжал бы хвост чужих суток. Невалидная строка — ошибка запроса,
    // а не «фильтр молча исчез» и не 500 из недр драйвера.
    const мгновение = (v: string, конецСуток: boolean): Date => {
      const голаяДата = /^\d{4}-\d{2}-\d{2}$/.test(v.trim());
      const d = new Date(голаяДата ? `${v.trim()}T${конецСуток ? "23:59:59.999" : "00:00:00"}+05:00` : v);
      if (Number.isNaN(d.getTime())) throw new BadRequestException(`Дата не разобрана: «${v}»`);
      return d;
    };
    if (from) усл.push(gte(coffeeOrder.ts, мгновение(from, false)));
    if (to) усл.push(lte(coffeeOrder.ts, мгновение(to, true)));
    const где = and(...усл);

    const [всего] = await this.db
      .select({
        чашек: sql<number>`count(*)::int`,
        выручка: sql<number>`coalesce(sum(${coffeeOrder.amount}), 0)::float8`,
      })
      .from(coffeeOrder)
      .where(где);

    // VIP отдельной строкой: 70% vip-выручки дают три кочующие карты, и
    // владелец должен видеть эту долю на экране, а не искать её в константах.
    const [vip] = await this.db
      .select({
        чашек: sql<number>`count(*) filter (where lower(${coffeeOrder.orderResource}) = 'vip')::int`,
        выручка: sql<number>`coalesce(sum(${coffeeOrder.amount}) filter (where lower(${coffeeOrder.orderResource}) = 'vip'), 0)::float8`,
      })
      .from(coffeeOrder)
      .where(где);

    const [{ неВыдано }] = await this.db
      .select({ неВыдано: sql<number>`count(*)::int` })
      .from(coffeeOrder)
      .where(and(где, sql`${coffeeOrder.brewStatus} is not null and ${coffeeOrder.brewStatus} not in ('2','10','Delivered','Delivery confirmed')`));

    const поМесяцам = await this.db
      .select({
        // Месяц считается по Ташкенту, а не по UTC: заказ в 02:00 первого числа —
        // это 21:00 предыдущих суток по UTC, и он уехал бы в прошлый месяц.
        месяц: sql<string>`to_char(${coffeeOrder.ts} at time zone 'Asia/Tashkent', 'YYYY-MM')`,
        чашек: sql<number>`count(*)::int`,
        выручка: sql<number>`coalesce(sum(${coffeeOrder.amount}), 0)::float8`,
      })
      .from(coffeeOrder)
      .where(где)
      .groupBy(sql`to_char(${coffeeOrder.ts} at time zone 'Asia/Tashkent', 'YYYY-MM')`)
      .orderBy(sql`to_char(${coffeeOrder.ts} at time zone 'Asia/Tashkent', 'YYYY-MM')`);

    const поАвтоматам = await this.db
      .select({
        машина: sql<string>`coalesce(${entity.name}, ${coffeeOrder.machineSerial})`,
        чашек: sql<number>`count(*)::int`,
        выручка: sql<number>`coalesce(sum(${coffeeOrder.amount}), 0)::float8`,
      })
      .from(coffeeOrder)
      .leftJoin(entity, eq(entity.id, coffeeOrder.machineId))
      .where(где)
      .groupBy(sql`1`)
      .orderBy(desc(sql`2`));

    const поТоварам = await this.db
      .select({
        товар: coffeeOrder.goodsName,
        чашек: sql<number>`count(*)::int`,
        выручка: sql<number>`coalesce(sum(${coffeeOrder.amount}), 0)::float8`,
      })
      .from(coffeeOrder)
      .where(где)
      .groupBy(coffeeOrder.goodsName)
      .orderBy(desc(sql`2`));

    const чашек = Number(всего?.чашек ?? 0);
    const выручка = Number(всего?.выручка ?? 0);
    return {
      период: { from: from ?? null, to: to ?? null },
      всего: { чашек, выручка, среднийЧек: чашек > 0 ? Math.round(выручка / чашек) : 0 },
      vip: { чашек: Number(vip?.чашек ?? 0), выручка: Number(vip?.выручка ?? 0) },
      неВыдано: Number(неВыдано ?? 0),
      поМесяцам,
      поАвтоматам,
      поТоварам,
    };
  }

  /** Сколько заказов уже лежит и до какой даты — чтобы видеть свежесть. */
  async status(): Promise<{ всего: number; вВыручке: number; первый: string | null; последний: string | null }> {
    const [r] = await this.db
      .select({
        всего: sql<number>`count(*)::int`,
        вВыручке: sql<number>`count(*) filter (where ${coffeeOrder.countable})::int`,
        первый: sql<string | null>`min(${coffeeOrder.ts})`,
        последний: sql<string | null>`max(${coffeeOrder.ts})`,
      })
      .from(coffeeOrder);
    return {
      всего: Number(r?.всего ?? 0),
      вВыручке: Number(r?.вВыручке ?? 0),
      первый: r?.первый ?? null,
      последний: r?.последний ?? null,
    };
  }
}

/** Заказ выдан — по таким считается расход сырья (не по оплате). */
export const заказВыдан = orderIsDelivered;
