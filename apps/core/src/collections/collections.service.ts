import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { auditLog, coffeeOrder, collection, entity, person, sale } from "@mydon/db";
import { cashInMachines, orderIsCash, parseDenominations, type DenominationCounts } from "@mydon/shared";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";

type CollectionRow = typeof collection.$inferSelect;

type РезультатОценки = { всего: number; поАвтоматам: { machineId: string; имя: string | null; сумма: number; с: string | null }[] };

/** Строка сверки: итог по автомату за весь запрошенный период (R-K11). */
export interface РезультатСверкиСтрока {
  machineId: string;
  имя: string | null;
  выручка: number;
  изъято: number;
  разница: number;
  /** Доля расхождения от выручки, % (изъято меньше выручки — отрицательная). null, если выручки не было. */
  доля: number | null;
  инкассаций: number;
  медианныйИнтервалДней: number | null;
  медианныйЛагДней: number | null;
  /**
   * Статус строки — та же логика, что у intervals.статус: длинное молчание
   * данных не значит недостачу.
   * «Инкассаций нет вовсе» (выручка есть, ни одной инкассации за всю
   * историю) — пробел ввода, а не воровство: сложенный в общий итог, он даёт
   * -100% и топит здоровый сигнал (проверено на проде — 3 автомата, 17 061 000
   * никогда не собиравшейся выручки).
   * «Выручки нет» — обратный случай (собирали, а продаж в данных нет) —
   * тоже не норма, но по другой причине (пробел данных о продажах).
   * «Ждёт приёма» — ВСЕ инкассации автомата за период уже собраны, но ни одна
   * ещё не принята (сумма не введена): без этого статуса `инкассаций` считал
   * бы их за 0 и строка ложно получала бы «инкассаций нет вовсе» — ровно то же
   * штатное окно 2–7 дней, что и у intervals (срез К, ревью 1.2).
   */
  статус: "обычный" | "инкассаций нет вовсе" | "выручки нет" | "ждёт приёма";
}

/** Один период между двумя соседними инкассациями на одном автомате (R-K11). */
export interface ИнтервалСверки {
  id: string;
  machineId: string;
  имя: string | null;
  с: string;
  по: string;
  дней: number;
  ожидалось: number;
  /**
   * null — инкассация, ЗАКРЫВАЮЩАЯ этот период, ещё «ждёт приёма» (этап 2 не
   * пройден, суммы в БД нет): это штатное окно 2–7 дней между сбором и
   * приёмом, а не 0 изъятых денег (срез К, ревью 1.2).
   */
  изъято: number | null;
  /** null — как и `изъято`: делить не на что, раз само изъятое неизвестно, а не ноль. */
  разница: number | null;
  /** Доля расхождения от ожидаемого, % (изъято меньше ожидаемого — отрицательная). null, если ожидание было нулевым (делить не на что) либо изъятое ещё не известно. */
  доля: number | null;
  /**
   * «Пробел в журнале» — период длиннее удвоенной медианы для ЭТОГО автомата:
   * не недостача, а дисциплина ввода. «Ждёт приёма» — сумма закрывающей
   * инкассации ещё не введена: период не читается как недостача 100%
   * (`Number(null)` дало бы именно это до фикса).
   */
  статус: "обычный" | "пробел в журнале" | "ждёт приёма";
}

/** Агрегат сверки — ТОЛЬКО по строкам со статусом «обычный» (правило считать сходимость живёт здесь, не на витрине). */
export interface ИтогСверки {
  выручка: number;
  изъято: number;
  разница: number;
  доля: number | null;
  автоматов: number;
}

/** Что исключено из `итог` и почему — видно числом, а не молчанием. */
export interface ВнеИтогаСверки {
  автоматов: number;
  выручка: number;
}

export interface РезультатСверки {
  from: string;
  to: string;
  rows: РезультатСверкиСтрока[];
  intervals: ИнтервалСверки[];
  /** Сколько первых инкассаций автоматов не вошли ни в один интервал — у них нет известного начала периода. */
  первыхИсключено: number;
  итог: ИтогСверки;
  внеИтога: ВнеИтогаСверки;
}

/** Медиана числового набора. Пустой набор обрабатывает вызывающий — здесь не определена. */
function медиана(значения: number[]): number {
  const s = [...значения].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

export interface CreateCollectionInput {
  machineId: string;
  operatorId?: string;
  collectedAt?: string;
  source?: "realtime" | "manual_history" | "import";
  notes?: string;
  /** Ключ идемпотентности ОТ КЛИЕНТА. Нет ключа — нет дедупа, и это законно (R-I-2). */
  clientKey?: string;
}

/** Строка списка: с именами автомата и оператора — панель и бот не делают лишних запросов. */
export interface CollectionListRow extends CollectionRow {
  machineName: string | null;
  operatorName: string | null;
}

/**
 * Инкассация (перенос VendCash внутрь MYDON, спецификация vendcash-specification.md).
 *
 * Двухэтапность — суть системы: оператор фиксирует ФАКТ и ВРЕМЯ сбора (до
 * секунды), деньги едут к менеджеру, менеджер пересчитывает и вводит СУММУ.
 * Пока сумма не введена — инкассация «ожидает приёма», и это видно владельцу.
 */
@Injectable()
export class CollectionsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Этап 1: оператор собрал деньги. Время фиксируется сейчас, если не передано. */
  async create(input: CreateCollectionInput, actorRef = "bot"): Promise<CollectionRow> {
    return this.db.transaction(async (tx) => {
      const [machine] = await tx.select().from(entity).where(eq(entity.id, input.machineId)).limit(1);
      if (!machine) throw new NotFoundException(`Автомат ${input.machineId} не найден`);
      if (machine.type !== "machine") {
        throw new BadRequestException("Инкассация возможна только по автомату");
      }

      const [created] = await tx
        .insert(collection)
        .values({
          machineId: input.machineId,
          operatorId: input.operatorId ?? null,
          collectedAt: input.collectedAt ? new Date(input.collectedAt) : new Date(),
          source: input.source ?? "realtime",
          notes: input.notes ?? null,
          clientKey: input.clientKey ?? null,
        })
        .onConflictDoNothing({ target: collection.clientKey })
        .returning();

      // Повтор по clientKey: сбор уже записан первой попыткой — возвращаем ту
      // же строку и НЕ пишем второй `audit_log`. Бот покажет момент ПЕРВОГО
      // сбора: человеку важно увидеть, что записано, а не когда он нажал ещё раз.
      if (!created) {
        const [existing] = await tx
          .select()
          .from(collection)
          .where(eq(collection.clientKey, input.clientKey!))
          .limit(1);
        if (!existing) throw new BadRequestException("Повтор инкассации ещё сохраняется — нажми ещё раз");
        return existing;
      }

      await tx.insert(auditLog).values({
        actorKind: input.operatorId ? "human" : "system",
        actorRef,
        action: "collection.collected",
        target: created.id,
        after: created,
      });
      return created;
    });
  }

  /**
   * Этап 2: менеджер принял и пересчитал. Сумма обязательна, разбивка по
   * купюрам — нет (386 исторических приёмов её не знают, и это законно).
   *
   * Если разбивку передали, её сумма ОБЯЗАНА совпасть с `amount` — сверка
   * живёт в ядре, а не только на форме, потому что форму можно обойти.
   * DTO проверяет только тип входа (объект); номиналы, отрицательные и
   * дробные количества, и само совпадение сумм — семантика, и её место
   * здесь, с отказом, который называет ОБЕ цифры и разницу (см. срез D,
   * где @IsPositive() на DTO отбивал весь запрос из-за одной плохой строки).
   */
  async receive(
    id: string,
    amount: number,
    managerRef = "owner",
    denominationsInput?: Record<string, unknown>,
  ): Promise<CollectionRow> {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new BadRequestException("Сумма должна быть числом не меньше нуля");
    }

    let denominations: DenominationCounts | null = null;
    if (denominationsInput != null) {
      const parsed = parseDenominations(denominationsInput);
      if ("error" in parsed) throw new BadRequestException(parsed.error);
      if (parsed.total !== amount) {
        throw new BadRequestException(
          `Сумма купюр не сошлась с заявленной: по купюрам ${parsed.total}, заявлено ${amount}, разница ${parsed.total - amount}`,
        );
      }
      denominations = parsed.counts;
    }

    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(collection).where(eq(collection.id, id)).for("update");
      if (!row) throw new NotFoundException(`Инкассация ${id} не найдена`);
      if (row.status !== "collected") {
        throw new BadRequestException(`Инкассация уже закрыта (${row.status})`);
      }
      const [updated] = await tx
        .update(collection)
        .set({ status: "received", amount: String(amount), receivedAt: new Date(), managerRef, denominations })
        .where(eq(collection.id, id))
        .returning();

      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef: managerRef,
        action: "collection.received",
        target: id,
        before: row,
        after: updated,
      });
      return updated;
    });
  }

  /** Отмена (ошибочная фиксация). След остаётся — строка не удаляется. */
  async cancel(id: string, managerRef = "owner"): Promise<CollectionRow> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(collection).where(eq(collection.id, id)).for("update");
      if (!row) throw new NotFoundException(`Инкассация ${id} не найдена`);
      if (row.status !== "collected") {
        throw new BadRequestException(`Инкассация уже закрыта (${row.status})`);
      }
      const [updated] = await tx
        .update(collection)
        .set({ status: "cancelled", managerRef })
        .where(eq(collection.id, id))
        .returning();
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef: managerRef,
        action: "collection.cancelled",
        target: id,
        before: row,
        after: updated,
      });
      return updated;
    });
  }

  /** Список с именами: ожидающие приёма или принятые за период. */
  async list(opts: { status?: "collected" | "received" | "cancelled"; days?: number; limit?: number } = {}): Promise<CollectionListRow[]> {
    const conditions = [];
    if (opts.status) conditions.push(eq(collection.status, opts.status));
    if (opts.days) {
      conditions.push(gte(collection.collectedAt, new Date(Date.now() - opts.days * 24 * 3600_000)));
    }
    const rows = await this.db
      .select({
        row: collection,
        machineName: entity.name,
        operatorName: person.name,
      })
      .from(collection)
      .leftJoin(entity, eq(entity.id, collection.machineId))
      .leftJoin(person, eq(person.id, collection.operatorId))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(collection.collectedAt))
      .limit(opts.limit ?? 200);

    return rows.map((r) => ({ ...r.row, machineName: r.machineName, operatorName: r.operatorName }));
  }

  /** Итоги для дашборда: сколько ждёт приёма, сколько принято и на какую сумму. */
  async summary(days = 30): Promise<{
    pending: number;
    receivedCount: number;
    receivedSum: number;
    days: number;
  }> {
    const since = new Date(Date.now() - days * 24 * 3600_000);
    const [row] = await this.db
      .select({
        pending: sql<number>`count(*) filter (where ${collection.status} = 'collected')`,
        receivedCount: sql<number>`count(*) filter (where ${collection.status} = 'received' and ${collection.collectedAt} >= ${since.toISOString()}::timestamptz)`,
        receivedSum: sql<string>`coalesce(sum(${collection.amount}) filter (where ${collection.status} = 'received' and ${collection.collectedAt} >= ${since.toISOString()}::timestamptz), 0)::text`,
      })
      .from(collection);
    return {
      pending: Number(row?.pending ?? 0),
      receivedCount: Number(row?.receivedCount ?? 0),
      receivedSum: Number(row?.receivedSum ?? 0),
      days,
    };
  }

  /**
   * Кэш последней оценки. Дашборд дёргает cashEstimate() на каждый рендер,
   * а под капотом — четыре полных скана (collection/coffeeOrder/sale/entity);
   * SQL-окно «только записи после последней инкассации по автомату» решило бы
   * честнее, но это отдельный леджер-план, отложенный до реального роста
   * объёмов. Пока объём небольшой — достаточно 60-секундного кэша в памяти
   * процесса.
   */
  private кэшОценки: { до: number; данные: РезультатОценки } | null = null;

  /** Оценка наличных в автоматах: продажи cash после последней ПРИНЯТОЙ инкассации. */
  async cashEstimate(): Promise<РезультатОценки> {
    if (this.кэшОценки && this.кэшОценки.до > Date.now()) return this.кэшОценки.данные;

    const [принятые, кофе, снек, имена] = await Promise.all([
      this.db
        .select({ machineId: collection.machineId, receivedAt: collection.receivedAt })
        .from(collection)
        .where(sql`${collection.receivedAt} is not null`),
      this.db
        .select({ machineId: coffeeOrder.machineId, ts: coffeeOrder.ts, amount: coffeeOrder.amount, res: coffeeOrder.orderResource })
        .from(coffeeOrder)
        .where(and(eq(coffeeOrder.countable, true), sql`${coffeeOrder.machineId} is not null`)),
      this.db
        .select({ machineId: sale.machineId, dt: sale.dt, amount: sale.amount })
        .from(sale)
        .where(sql`${sale.machineId} is not null`),
      this.db.select({ id: entity.id, name: entity.name }).from(entity),
    ]);

    const продажи = [
      ...кофе.map((r) => ({ machineId: r.machineId as string, ts: (r.ts as Date).toISOString(), amount: Number(r.amount), cash: orderIsCash({ orderResource: r.res }) })),
      // Снек: платёжного канала в источнике нет — считаем наличными и честно
      // помечаем «≈» на витрине.
      // Тайминг тоже компромисс, не оплошность: у снека есть только дата
      // (без часов внутри дня), поэтому вся дневная сумма ставится на конец
      // суток (23:59:59). Если инкассация того же автомата прошла В ТОТ ЖЕ
      // календарный день, эта дневная сумма целиком попадает «после сбора»
      // и может пересекаться с деньгами, уже увезёнными утром или днём —
      // оценка в день инкассации систематически чуть завышена.
      ...снек.map((r) => ({ machineId: r.machineId as string, ts: `${r.dt}T23:59:59+05:00`, amount: Number(r.amount), cash: true })),
    ];
    const метки = принятые.map((c) => ({ machineId: c.machineId, receivedAt: (c.receivedAt as Date).toISOString() }));
    const итог = cashInMachines(продажи, метки);
    const имёнаМап = new Map(имена.map((e) => [e.id, e.name]));
    const данные: РезультатОценки = {
      всего: Math.round(итог.total),
      поАвтоматам: итог.perMachine.map((m) => ({ machineId: m.machineId, имя: имёнаМап.get(m.machineId) ?? null, сумма: Math.round(m.amount), с: m.since })),
    };
    this.кэшОценки = { до: Date.now() + 60_000, данные };
    return данные;
  }

  private static readonly ДАТА_RE = /^\d{4}-\d{2}-\d{2}$/;

  /**
   * Сверка по автоматам за период (R-K11). Владелец просил ДВА разреза, не
   * один: агрегат за окно усредняет и прячет провалы — именно построчный
   * разбор вскрыл дыру в журнале инкассаций (см. факт 11 плана среза К).
   *
   * `rows` — итог по автомату ВНУТРИ [from, to]: выручка (наличные заказы
   * кофе, то же правило orderIsCash, что у cashEstimate, плюс снек — он весь
   * наличный, т.к. канала оплаты в источнике нет вовсе), изъято по системе,
   * разница, доля, число инкассаций и медианные интервал/лаг ЭТОГО автомата
   * (по всей его истории — дисциплина сборов не свойство окна, которое
   * запросили).
   *
   * `intervals` — построчно по КАЖДОЙ инкассации за ВСЮ историю (не только
   * за запрошенный период: длина периода между сборами — свойство самой
   * инкассации). Запрос перенесён с прода дословно (донор VendCash,
   * sales.service.ts:583): первая инкассация автомата не имеет предыдущей
   * границы и выброшена (`prev IS NOT NULL`), границы строго `>`/`<=`, чтобы
   * заказ в момент сбора не попал в два периода, сопоставление — по
   * machine_id. Период длиннее удвоенной медианы ЭТОГО автомата помечается
   * «пробел в журнале», а не голым минусом: это дисциплина ввода, а не
   * недостача (проверено на проде: 14 таких окон дают −92,6% просто потому,
   * что инкассации туда не заносили).
   */
  async reconcile(from: string, to: string): Promise<РезультатСверки> {
    if (!CollectionsService.ДАТА_RE.test(from) || !CollectionsService.ДАТА_RE.test(to)) {
      throw new BadRequestException("Период задаётся датами вида ГГГГ-ММ-ДД: ?from=2026-03-01&to=2026-06-24");
    }
    if (from > to) {
      throw new BadRequestException(`Начало периода (${from}) позже конца (${to})`);
    }
    const fromTs = new Date(`${from}T00:00:00+05:00`);
    const toTs = new Date(`${to}T23:59:59.999+05:00`);

    const [коллекции, кофе, снек, имена, интервалыRaw] = await Promise.all([
      // Полная история, не только период: первая-инкассация-на-автомате,
      // медианный интервал и лаг — свойства всей истории автомата.
      this.db
        .select({ machineId: collection.machineId, collectedAt: collection.collectedAt, receivedAt: collection.receivedAt, amount: collection.amount })
        .from(collection)
        .where(sql`${collection.status} <> 'cancelled'`),
      this.db
        .select({ machineId: coffeeOrder.machineId, ts: coffeeOrder.ts, amount: coffeeOrder.amount, res: coffeeOrder.orderResource })
        .from(coffeeOrder)
        .where(and(eq(coffeeOrder.countable, true), sql`${coffeeOrder.machineId} is not null`, gte(coffeeOrder.ts, fromTs), lte(coffeeOrder.ts, toTs))),
      this.db
        .select({ machineId: sale.machineId, dt: sale.dt, amount: sale.amount })
        .from(sale)
        .where(and(sql`${sale.machineId} is not null`, gte(sale.dt, from), lte(sale.dt, to))),
      this.db.select({ id: entity.id, name: entity.name }).from(entity),
      this.db.execute(sql`
        WITH pairs AS (
          SELECT c.id, c.machine_id, c.amount::numeric amt, c.collected_at,
                 LAG(c.collected_at) OVER (
                   PARTITION BY c.machine_id ORDER BY c.collected_at
                 ) prev
          FROM collection c WHERE c.status <> 'cancelled'
        )
        SELECT p.id, p.machine_id "machineId", p.prev, p.collected_at "collectedAt", p.amt "amount",
               COALESCE(SUM(o.amount::numeric), 0) expected
        FROM pairs p
        LEFT JOIN coffee_order o
          ON o.machine_id = p.machine_id AND o.countable
         AND lower(o.order_resource) IN ('cash','cash0','cash payment','credit')
         AND o.ts > p.prev AND o.ts <= p.collected_at
        WHERE p.prev IS NOT NULL
        GROUP BY 1,2,3,4,5
      `),
    ]);

    const имёнаМап = new Map(имена.map((e) => [e.id, e.name]));

    // --- intervals: построчно, кроме первой инкассации на каждом автомате ---
    const интервалыRows = интервалыRaw as unknown as Array<{
      id: string;
      machineId: string;
      prev: Date | string;
      collectedAt: Date | string;
      /** null — инкассация, закрывающая период, ещё «ждёт приёма» (этап 2 не пройден). */
      amount: string | number | null;
      expected: string | number;
    }>;

    const длительностиПоАвтомату = new Map<string, number[]>();
    const сырыеИнтервалы = интервалыRows.map((r) => {
      const с = new Date(r.prev);
      const по = new Date(r.collectedAt);
      const дней = (по.getTime() - с.getTime()) / 86_400_000;
      const список = длительностиПоАвтомату.get(r.machineId) ?? [];
      список.push(дней);
      длительностиПоАвтомату.set(r.machineId, список);
      return { ...r, с, по, дней };
    });

    const intervals: ИнтервалСверки[] = сырыеИнтервалы.map((r) => {
      const медианаАвтомата = медиана(длительностиПоАвтомату.get(r.machineId) ?? [r.дней]);
      // Инкассация, ЗАКРЫВАЮЩАЯ этот период, ещё «ждёт приёма» — `amount` в БД
      // NULL, и это штатное окно 2–7 дней между сбором и приёмом, а не 0
      // изъятых денег. `Number(null)` даёт 0 молча — отсюда ложная «недостача
      // 100%» на свежем сборе (срез К, ревью 1.2): изъято/разница остаются
      // null, а не выдуманным нулём, статус называет причину явно.
      const ждётПриёма = r.amount == null;
      const изъято = ждётПриёма ? null : Math.round(Number(r.amount));
      const ожидалось = Math.round(Number(r.expected));
      const разница = изъято === null ? null : изъято - ожидалось;
      return {
        id: r.id,
        machineId: r.machineId,
        имя: имёнаМап.get(r.machineId) ?? null,
        с: r.с.toISOString(),
        по: r.по.toISOString(),
        дней: Math.round(r.дней * 100) / 100,
        ожидалось,
        изъято,
        разница,
        // null при нулевом ожидании ИЛИ неизвестном изъятом — делить не на что
        // (та же логика, что у rows.доля).
        доля: разница !== null && ожидалось > 0 ? Math.round((разница / ожидалось) * 10000) / 100 : null,
        статус: ждётПриёма ? "ждёт приёма" : r.дней > 2 * медианаАвтомата ? "пробел в журнале" : "обычный",
      };
    });

    // Первая инкассация КАЖДОГО автомата не входит ни в один период — у неё
    // нет известного начала, и приписывать ей «всё с начала времён» нечестно
    // (см. WHERE prev IS NOT NULL выше). Считается словами, а не молча.
    const первыхИсключено = new Set(коллекции.map((c) => c.machineId)).size;

    // --- rows: по автомату за окно [from, to] ---
    const лагПоАвтомату = new Map<string, number[]>();
    for (const c of коллекции) {
      if (!c.receivedAt) continue;
      const лагДней = (new Date(c.receivedAt).getTime() - new Date(c.collectedAt).getTime()) / 86_400_000;
      const список = лагПоАвтомату.get(c.machineId) ?? [];
      список.push(лагДней);
      лагПоАвтомату.set(c.machineId, список);
    }

    const выручкаПоАвтомату = new Map<string, number>();
    for (const o of кофе) {
      if (!orderIsCash({ orderResource: o.res })) continue;
      const machineId = o.machineId as string;
      выручкаПоАвтомату.set(machineId, (выручкаПоАвтомату.get(machineId) ?? 0) + Number(o.amount));
    }
    for (const s of снек) {
      const machineId = s.machineId as string;
      выручкаПоАвтомату.set(machineId, (выручкаПоАвтомату.get(machineId) ?? 0) + Number(s.amount));
    }

    const изъятоПоАвтомату = new Map<string, { сумма: number; штук: number; ждутПриёма: number }>();
    for (const c of коллекции) {
      const collectedAt = new Date(c.collectedAt);
      if (collectedAt < fromTs || collectedAt > toTs) continue;
      const запись = изъятоПоАвтомату.get(c.machineId) ?? { сумма: 0, штук: 0, ждутПриёма: 0 };
      if (c.amount == null) {
        // Ждёт приёма — сумма ещё не известна, но СБОР БЫЛ: если считать
        // `инкассаций` нулём здесь, автомат, у которого все сборы периода ещё
        // не приняты, получит статус «инкассаций нет вовсе» — ложь (срез К,
        // ревью 1.2, симптом 2). Сумма в общий счёт не идёт (неизвестна), счётчик — идёт.
        запись.ждутПриёма += 1;
      } else {
        запись.сумма += Number(c.amount);
        запись.штук += 1;
      }
      изъятоПоАвтомату.set(c.machineId, запись);
    }

    const machineIds = new Set([...выручкаПоАвтомату.keys(), ...изъятоПоАвтомату.keys()]);
    const rows: РезультатСверкиСтрока[] = [...machineIds]
      .map((machineId) => {
        const выручка = Math.round(выручкаПоАвтомату.get(machineId) ?? 0);
        const запись = изъятоПоАвтомату.get(machineId);
        const изъято = Math.round(запись?.сумма ?? 0);
        const разница = изъято - выручка;
        const интервалы = длительностиПоАвтомату.get(machineId);
        const лаги = лагПоАвтомату.get(machineId);
        const принятых = запись?.штук ?? 0;
        const ждущих = запись?.ждутПриёма ?? 0;
        const инкассаций = принятых + ждущих;
        const статус: РезультатСверкиСтрока["статус"] =
          инкассаций === 0 && выручка > 0
            ? "инкассаций нет вовсе"
            : принятых === 0 && ждущих > 0
              ? "ждёт приёма"
              : выручка === 0 && инкассаций > 0
                ? "выручки нет"
                : "обычный";
        return {
          machineId,
          имя: имёнаМап.get(machineId) ?? null,
          выручка,
          изъято,
          разница,
          доля: выручка > 0 ? Math.round((разница / выручка) * 10000) / 100 : null,
          инкассаций,
          медианныйИнтервалДней: интервалы && интервалы.length ? Math.round(медиана(интервалы) * 100) / 100 : null,
          медианныйЛагДней: лаги && лаги.length ? Math.round(медиана(лаги) * 100) / 100 : null,
          статус,
        };
      })
      .sort((a, b) => b.выручка - a.выручка);

    // Правило «что считать сходимостью» живёт здесь, одним местом (как
    // orderIsCash), а не на витрине: аномальные строки («инкассаций нет
    // вовсе» / «выручки нет») искажают итог сильнее, чем стоит, — их
    // выручка/недостача не измеряет реальную сходимость сборов, только
    // пробел ввода или пробел данных.
    const обычные = rows.filter((r) => r.статус === "обычный");
    const внеИтогаRows = rows.filter((r) => r.статус !== "обычный");
    const итогВыручка = обычные.reduce((s, r) => s + r.выручка, 0);
    const итогИзъято = обычные.reduce((s, r) => s + r.изъято, 0);
    const итогРазница = итогИзъято - итогВыручка;
    const итог: ИтогСверки = {
      выручка: итогВыручка,
      изъято: итогИзъято,
      разница: итогРазница,
      доля: итогВыручка > 0 ? Math.round((итогРазница / итогВыручка) * 10000) / 100 : null,
      автоматов: обычные.length,
    };
    const внеИтога: ВнеИтогаСверки = {
      автоматов: внеИтогаRows.length,
      выручка: внеИтогаRows.reduce((s, r) => s + r.выручка, 0),
    };

    return { from, to, rows, intervals, первыхИсключено, итог, внеИтога };
  }
}
