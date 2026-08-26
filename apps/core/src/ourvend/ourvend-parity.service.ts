import { Inject, Injectable, Logger, type OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { event, machineStock, ourvendSaleSnapshot, ourvendStockSnapshot, sale } from "@mydon/db";
import {
  machineSerialSql,
  normalizeProductName,
  parityStreak,
  tashkentDay,
  tashkentDayStartOf,
  type ParityStreak,
} from "@mydon/shared";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { Cron } from "croner";
import { DB, type Db } from "../db/db.module";
import { accountingSource } from "../sales/accounting-source";
import { VendingService } from "../vending/vending.service";
import { cutoverThreshold } from "./sync-runs";

/**
 * Паритет собственного снапшота OurVend со stock-дорожкой — гейт П2.
 *
 * Пока `sale` наполняется чтением БД mydon-stock, а наш снапшот пишется в
 * тень, этот сервис ежедневно сверяет их по (день, автомат): суммы штук и
 * денег. 7 подряд зелёных дней = разрешение переключить
 * OURVEND_ACCOUNTING_SOURCE=own и погасить чтение чужой базы.
 * Серийники сравниваются каноном (у сторон разные формы: «c…» и голая).
 */

/** Тип ежедневного вердикта сверки — им же ключуется счёт серии. */
export const PARITY_EVENT = "ourvend.parity";

/** Тип сигнала «порог взят, можно переключать учёт» — им же ключуется дедуп по суткам. */
export const CUTOVER_READY_EVENT = "ourvend.cutover_ready";

/**
 * Сколько событий паритета читаем ради счёта серии.
 *
 * 14 суток окна показа плюс запас на ПОВТОРНЫЕ прогоны в одни сутки: ручной
 * `daily()` после починки — это уточнение вердикта дня, а не новый день, но
 * строку в журнале он занимает. Считать серию по обрезанному списку значило бы
 * занижать её ровно в тот день, когда сверку чинили руками.
 */
export const PARITY_SCAN_LIMIT = 60;

export interface ParityDayRow {
  dt: string;
  serial: string;
  qty: number;
  amount: number;
}

export interface ParityMismatch {
  dt: string;
  serial: string;
  ownQty: number;
  stockQty: number;
  ownAmount: number;
  stockAmount: number;
  reason: string;
}

/** exported для тестов: чистое сравнение двух агрегатов. */
export function computeParity(
  own: ParityDayRow[],
  stockSide: ParityDayRow[],
): { checked: number; mismatches: ParityMismatch[] } {
  const key = (r: { dt: string; serial: string }) => `${r.dt}|${r.serial}`;
  const stockMap = new Map(stockSide.map((r) => [key(r), r]));
  const seen = new Set<string>();
  const mismatches: ParityMismatch[] = [];
  let checked = 0;
  const close = (a: number, b: number) => Math.abs(a - b) < 0.01;
  for (const o of own) {
    checked += 1;
    seen.add(key(o));
    const s = stockMap.get(key(o));
    if (!s) {
      mismatches.push({
        dt: o.dt,
        serial: o.serial,
        ownQty: o.qty,
        stockQty: 0,
        ownAmount: o.amount,
        stockAmount: 0,
        reason: "у stock-дорожки нет этого дня/автомата",
      });
      continue;
    }
    if (!close(o.qty, s.qty) || !close(o.amount, s.amount)) {
      mismatches.push({
        dt: o.dt,
        serial: o.serial,
        ownQty: o.qty,
        stockQty: s.qty,
        ownAmount: o.amount,
        stockAmount: s.amount,
        reason: "суммы расходятся",
      });
    }
  }
  for (const s of stockSide) {
    if (seen.has(key(s))) continue;
    mismatches.push({
      dt: s.dt,
      serial: s.serial,
      ownQty: 0,
      stockQty: s.qty,
      ownAmount: 0,
      stockAmount: s.amount,
      reason: "в нашем снапшоте нет этого дня/автомата",
    });
  }
  return { checked, mismatches };
}

/** Остаток автомата строкой: день, автомат, товар, штуки. */
export interface ParityStockRow {
  dt: string;
  serial: string;
  product: string;
  qty: number;
}

export interface ParityStockMismatch {
  dt: string;
  serial: string;
  product: string;
  own: number;
  stock: number;
  reason: string;
}

/**
 * Сверка остатков автоматов (гашение связи №1, П4/R-P4-6) — чистое сравнение,
 * exported для тестов.
 *
 * СРАВНИВАЮТСЯ ТОЛЬКО АВТОМАТЫ, КОТОРЫЕ ЕСТЬ У ОБЕИХ СТОРОН. Аппарат,
 * заведённый у нас и ещё не появившийся в stock-дорожке (или наоборот),
 * красил бы гейт каждый день — и семь зелёных подряд не наступили бы никогда,
 * хотя расхождения по существу нет.
 *
 * Имя товара сравнивается НОРМАЛИЗОВАННЫМ: стороны пишут «Red  Bull» и
 * «red bull», и посимвольное сравнение объявило бы расхождением опечатку в
 * пробеле. Показываем при этом имя как есть — владельцу нужно то написание,
 * которое он увидит в кабинете.
 */
export function computeStockParity(
  own: ParityStockRow[],
  stockSide: ParityStockRow[],
  /**
   * Серийники не в строю (склад, ремонт) — вон с ОБЕИХ сторон и явно, а не
   * через пересечение. SKLAD 4S отдаёт заглушку 199 по всем слотам и в
   * `machine_stock` уже бывал: вернувшись, он дал бы гейту три десятка
   * расхождений из мусора, и переключение источника учёта не открылось бы
   * никогда.
   */
  notInService: Set<string> = new Set(),
): { checked: number; mismatches: ParityStockMismatch[] } {
  own = own.filter((r) => !notInService.has(r.serial));
  stockSide = stockSide.filter((r) => !notInService.has(r.serial));
  const общие = new Set(
    [...new Set(own.map((r) => r.serial))].filter((s) => stockSide.some((r) => r.serial === s)),
  );
  const key = (r: ParityStockRow) => `${r.dt}|${r.serial}|${normalizeProductName(r.product)}`;
  const ourOwn = own.filter((r) => общие.has(r.serial));
  const ourStock = stockSide.filter((r) => общие.has(r.serial));
  const stockMap = new Map(ourStock.map((r) => [key(r), r]));
  const seen = new Set<string>();
  const mismatches: ParityStockMismatch[] = [];
  let checked = 0;

  for (const o of ourOwn) {
    checked += 1;
    seen.add(key(o));
    const s = stockMap.get(key(o));
    if (!s) {
      mismatches.push({
        dt: o.dt,
        serial: o.serial,
        product: o.product,
        own: o.qty,
        stock: 0,
        reason: "у stock-дорожки нет этой позиции",
      });
      continue;
    }
    if (Math.abs(o.qty - s.qty) >= 0.01) {
      mismatches.push({ dt: o.dt, serial: o.serial, product: o.product, own: o.qty, stock: s.qty, reason: "остатки расходятся" });
    }
  }
  for (const s of ourStock) {
    if (seen.has(key(s))) continue;
    mismatches.push({
      dt: s.dt,
      serial: s.serial,
      product: s.product,
      own: 0,
      stock: s.qty,
      reason: "в нашем снапшоте нет этой позиции",
    });
  }
  return { checked, mismatches };
}

@Injectable()
export class OurvendParityService implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(OurvendParityService.name);
  private cron: Cron | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    /** Реестр автоматов — тот же источник правды о «не в строю», что у плана закупа. */
    private readonly vending: VendingService,
  ) {}

  onModuleInit(): void {
    // Утром, после и снапшота stock (07:50), и нашего (08:05): обе стороны
    // уже отработали за вчера.
    this.cron = new Cron("40 8 * * *", { timezone: "Asia/Tashkent" }, () => {
      void this.daily().catch((e: unknown) =>
        this.log.warn(`Паритет OurVend не посчитался: ${e instanceof Error ? e.message : String(e)}`),
      );
    });
  }

  onApplicationShutdown(): void {
    this.cron?.stop();
    this.cron = null;
  }

  /**
   * Сверка последних N дней, где у нашего снапшота есть данные. Сегодняшний
   * день не сверяется: stock-дорожка снимает «вчера», у сегодняшнего дня обе
   * стороны заведомо неполные.
   */
  async parity(days = 7): Promise<{
    days: number;
    checked: number;
    ok: boolean;
    mismatches: ParityMismatch[];
    ownRows: number;
    note: string | null;
    /** Вторая половина гейта: остатки автоматов (связь №1, П4). */
    stock: { days: number; checked: number; ok: boolean; mismatches: ParityStockMismatch[]; note: string | null };
  }> {
    const n = Math.min(Math.max(Math.trunc(days) || 7, 1), 30);
    // Канон серийника — общий SQL-хелпер (@mydon/shared), тот же, что в
    // синках: у сторон разные формы («c…» и голая), сравнивать можно только
    // приведённые.
    const canon = (col: string) => sql.raw(machineSerialSql(col));

    const ownRaw = (await this.db.execute(sql`
      select dt::text as dt, ${canon("machine_serial")} as serial,
             sum(qty)::float as qty, sum(amount)::float as amount
      from ${ourvendSaleSnapshot}
      where dt >= (current_date - ${sql.raw(String(n))}::int)
        and dt < current_date
      group by 1, 2
    `)) as unknown as ParityDayRow[];
    // Stock-сторона НЕ фильтруется по дням снапшота: день, выпавший из
    // снапшота (сбой агента, пустая перезапись), обязан всплыть расхождением
    // «в нашем снапшоте нет», а не исчезнуть из сверки. Дни до внедрения
    // снапшота отсекаются его минимальной датой — иначе вся история до
    // старта была бы вечным красным.
    const stockRaw = (await this.db.execute(sql`
      select dt::text as dt, ${canon("machine_serial")} as serial,
             sum(qty)::float as qty, sum(amount)::float as amount
      from ${sale}
      where source = 'ourvend'
        and dt >= (current_date - ${sql.raw(String(n))}::int)
        and dt < current_date
        and dt >= (select min(dt) from ${ourvendSaleSnapshot})
      group by 1, 2
    `)) as unknown as ParityDayRow[];

    // ── Вторая половина гейта: остатки автоматов (связь №1, R-P4-6) ──
    // Сравниваются те же дни и тем же каноном серийника, но ключ на разряд
    // подробнее: (день, автомат, ТОВАР). Суммы по автомату сошлись бы и при
    // перепутанных товарах, а после флипа планограмму и закуп мы будем строить
    // именно по товарам.
    const ownStockRaw = (await this.db.execute(sql`
      select dt::text as dt, ${canon("machine_serial")} as serial, product,
             sum(qty)::float as qty
      from ${ourvendStockSnapshot}
      where dt >= (current_date - ${sql.raw(String(n))}::int)
        and dt < current_date
      group by 1, 2, 3
    `)) as unknown as ParityStockRow[];
    const stockStockRaw = (await this.db.execute(sql`
      select dt::text as dt, ${canon("machine_serial")} as serial, product,
             sum(qty)::float as qty
      from ${machineStock}
      where dt >= (current_date - ${sql.raw(String(n))}::int)
        and dt < current_date
        and dt >= (select min(dt) from ${ourvendStockSnapshot})
      group by 1, 2, 3
    `)) as unknown as ParityStockRow[];

    const own = ownRaw.map((r) => ({ ...r, qty: Number(r.qty), amount: Number(r.amount) }));
    const stockSide = stockRaw.map((r) => ({ ...r, qty: Number(r.qty), amount: Number(r.amount) }));
    const { checked, mismatches } = computeParity(own, stockSide);

    const { notInService } = await this.vending.machineRegistry();
    const ownStock = ownStockRaw.map((r) => ({ ...r, qty: Number(r.qty) }));
    const stockStock = stockStockRaw.map((r) => ({ ...r, qty: Number(r.qty) }));
    const остатки = computeStockParity(ownStock, stockStock, new Set(notInService.keys()));
    // НЕ СВЕРИЛИ НИ ОДНОЙ ПАРЫ — ЭТО НЕ «ОК». Гейт открывает переключение
    // источника учёта, и «зелёный» без единой сравненной строки — ровно тот
    // случай «заглушка врёт», ради которого заводили смоук против живого
    // Postgres: прод держал снимки остатков только за СЕГОДНЯ, фильтр
    // `dt < current_date` выбрасывал их целиком, и половина гейта отчитывалась
    // «ok» ни о чём. Цвет теперь красный, а причина сказана словами — чинить
    // будут сбор остатков, а не паритет продаж.
    const stockNote =
      ownStock.length === 0
        ? "снимков остатков OurVend за период нет — сверять не по чему"
        : остатки.checked === 0
          ? "нет автоматов, общих со stock-дорожкой, — сверять не с чем"
          : null;
    const stock = {
      days: n,
      checked: остатки.checked,
      ok: остатки.mismatches.length === 0 && остатки.checked > 0,
      mismatches: остатки.mismatches,
      note: stockNote,
    };

    const salesNote =
      own.length === 0 ? "собственный снапшот продаж ещё пуст — сверять нечего (агент ещё не отработал?)" : null;
    const note = [salesNote, stockNote && `остатки: ${stockNote}`].filter((x): x is string => Boolean(x)).join("; ") || null;
    return {
      days: n,
      checked,
      // Вердикт — И по продажам, И по остаткам: флаг переключения один
      // (`OURVEND_ACCOUNTING_SOURCE`), значит и разрешение на него одно.
      ok: mismatches.length === 0 && own.length > 0 && stock.ok,
      mismatches,
      ownRows: own.length,
      note,
      stock,
    };
  }

  /**
   * Серия зелёных дней паритета и порог, по которому её судят (R-P8b-2).
   *
   * Читает СВОЙ ЖЕ журнал: единственный источник правды о том, каким был
   * вердикт вчера, — событие, которое вчера и записали. Пересчитывать историю
   * заново нельзя: `parity()` смотрит на СЕГОДНЯШНЕЕ содержимое таблиц, а
   * снапшоты дозаливаются задним числом, и «семь зелёных подряд» задним числом
   * нарисовались бы там, где в те дни гейт был красным.
   *
   * `now` — параметр: иначе «серия до сегодняшнего дня» проверялась бы датой
   * прогона тестов.
   */
  async streak(now = new Date()): Promise<ParityStreak> {
    const [строки, порог] = await Promise.all([
      this.db
        .select({ occurredAt: event.occurredAt, payload: event.payload })
        .from(event)
        .where(eq(event.type, PARITY_EVENT))
        .orderBy(desc(event.occurredAt))
        .limit(PARITY_SCAN_LIMIT),
      cutoverThreshold(this.db, this.log),
    ]);
    return parityStreak(
      строки.map((r) => ({
        occurredAt: r.occurredAt,
        // jsonb приходит как `unknown`; форма payload проверяется в чистой
        // функции по ключам, а не типом столбца.
        payload: (r.payload ?? {}) as Record<string, unknown>,
      })),
      порог,
      tashkentDay(now),
    );
  }

  /**
   * Ежедневный вердикт — событием: N зелёных подряд открывают переключение.
   *
   * `now` — параметр по той же причине, что у `streak`: и счёт серии, и дедуп
   * сигнала считаются ташкентскими сутками ЭТОГО момента, а не датой прогона
   * тестов.
   */
  async daily(now = new Date()): Promise<void> {
    const p = await this.parity(7);
    // Событие пишем ВСЕГДА, даже когда одна половина пуста. Прежний ранний
    // выход из-за пустого снапшота продаж уносил с собой и половину по
    // остаткам: в журнале не оставалось ни строки, и «гейт молчит» было не
    // отличить от «гейт не запускался».
    await this.db.insert(event).values({
      source: "ourvend-accounting",
      type: PARITY_EVENT,
      // Момент прогона, а не `now()` базы: серия считается ташкентскими
      // сутками ЭТОГО момента, и расхождение часов процесса с базой иначе
      // растащило бы вердикт и его же счёт по разным дням.
      occurredAt: now,
      payload: {
        ok: p.ok,
        дней: p.days,
        сверено_пар: p.checked,
        расхождений: p.mismatches.length,
        расхождения: p.mismatches.slice(0, 50),
        // Обе половины гейта в ОДНОЙ сводке: два отдельных события владелец
        // читал бы как два независимых вердикта, а переключение одно.
        остатки_сверено: p.stock.checked,
        остатки_расхождений: p.stock.mismatches.length,
        остатки_расхождения: p.stock.mismatches.slice(0, 50),
        примечание: p.note,
      },
    });
    this.log.log(
      `Паритет OurVend: ${p.ok ? "ОК" : "расхождения"} — продажи ${p.mismatches.length} из ${p.checked} пар, ` +
        `остатки ${p.stock.mismatches.length} из ${p.stock.checked}.` +
        (p.note ? ` (${p.note})` : ""),
    );

    await this.сигналКатовера(now);
  }

  /**
   * «Порог взят — можно переключать учёт» (R-P8b-2).
   *
   * ЗОВЁТСЯ ПОСЛЕ ЗАПИСИ ВЕРДИКТА, а не вместо: сегодняшний день входит в
   * серию, и считать её до вставки значило бы вечно отставать на сутки.
   *
   * ТРИ УСЛОВИЯ, И КАЖДОЕ ЗАЩИЩАЕТ ОТ СВОЕГО.
   * 1. `readyForCutover` — собственно гейт.
   * 2. ИСТОЧНИК ВСЁ ЕЩЁ `stock`. После флипа звать переключать УЖЕ НЕКУДА:
   *    серия в режиме `own` продолжает расти (паритет считается и там), и без
   *    этого условия владелец получал бы «можно переключать» каждый день до
   *    конца времён — ровно тот способ научить его не читать тревоги.
   * 3. ДЕДУП ПО ТАШКЕНТСКИМ СУТКАМ — тем же приёмом, что у `SyncStaleService`
   *    (select→insert, принятая гонка при одной реплике Core): ручной прогон
   *    `daily()` после починки не должен давать второе «можно переключать» в
   *    те же сутки.
   */
  private async сигналКатовера(now: Date): Promise<void> {
    const серия = await this.streak(now);
    if (!серия.readyForCutover) return;
    if ((await accountingSource(this.db, now)) !== "stock") return;

    const сутки = tashkentDayStartOf(now);
    const [было] = await this.db
      .select({ id: event.id })
      .from(event)
      .where(and(eq(event.type, CUTOVER_READY_EVENT), gte(event.occurredAt, сутки)))
      .limit(1);
    if (было) return;

    await this.db.insert(event).values({
      source: "ourvend-accounting",
      type: CUTOVER_READY_EVENT,
      occurredAt: now,
      payload: { greenDays: серия.greenDays, since: серия.since },
    });
    this.log.log(
      `Паритет OurVend зелёный ${серия.greenDays} дн. подряд (с ${серия.since ?? "?"}) при пороге ` +
        `${серия.threshold} — можно переключать OURVEND_ACCOUNTING_SOURCE на own.`,
    );
  }
}
