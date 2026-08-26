import { Inject, Injectable, Logger, type OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { event, machineStock, ourvendSaleSnapshot, ourvendStockSnapshot, sale } from "@mydon/db";
import {
  machineSerialSql,
  normalizeProductName,
  parityStreak,
  PARITY_STREAK_WINDOW,
  tashkentDay,
  tashkentDayStartOf,
  type ParityMode,
  type ParityStreak,
} from "@mydon/shared";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { Cron } from "croner";
import { DB, type Db } from "../db/db.module";
import { accountingSource } from "../sales/accounting-source";
import { openStockDb, type StockDb } from "../supply/stock-db";
import { VendingService } from "../vending/vending.service";
import { cutoverThreshold, stockParityTolerance } from "./sync-runs";

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

/**
 * Источник событий паритета — ОДНА константа у эмитента и у читателя серии.
 *
 * `POST /events` принимает любой `type` от носителя сервисного токена (бот,
 * панель, любой агент), а гейт катовера читается ИМЕННО из журнала: без
 * фильтра по источнику семь подделанных «зелёных» строк открывали бы
 * переключение учёта. Фильтр стоит в SQL рядом с фильтром по типу, и обе
 * стороны берут это же имя, чтобы переименование не осиротило запрос молча.
 */
export const PARITY_EVENT_SOURCE = "ourvend-accounting";

/** Тип сигнала «порог взят, можно переключать учёт» — им же ключуется дедуп по суткам. */
export const CUTOVER_READY_EVENT = "ourvend.cutover_ready";

/**
 * НИЖНИЙ ПОЛ окна чтения событий паритета — 60 строк.
 *
 * 14 суток окна показа плюс запас на ПОВТОРНЫЕ прогоны в одни сутки: ручной
 * `daily()` после починки — это уточнение вердикта дня, а не новый день, но
 * строку в журнале он занимает. Считать серию по обрезанному списку значило бы
 * занижать её ровно в тот день, когда сверку чинили руками.
 */
export const PARITY_SCAN_LIMIT = 60;

/**
 * Сколько строк журнала читать при данном пороге.
 *
 * ОКНО ЧТЕНИЯ ОБЯЗАНО ЗАВИСЕТЬ ОТ ПОРОГА. `CUTOVER_GREEN_DAYS` правится в
 * панели «Система»: поставь владелец 60 — при фиксированных 60 строках серия
 * упёрлась бы в лимит и
 * гейт не открылся бы НИКОГДА, причём молча. Берём порог плюс окно показа
 * (`PARITY_STREAK_WINDOW`), но не меньше пола: `days` обязаны заполниться даже
 * при пороге в один день.
 *
 * И НЕ БОЛЬШЕ ПОТОЛКА (R-FW-S1). Порог правится в панели, а `streak()` зовут
 * без авторизации (`GET /ourvend/parity/streak`, троттл 12/мин), из отчёта о
 * здоровье и из крона. `CUTOVER_GREEN_DAYS = 1000000` без потолка означал бы
 * `limit 1000014` по общей таблице `event` с разбором jsonb на каждый такой
 * вызов — не гейт, а способ положить Core одной настройкой. Валидатор ключа
 * держит ту же границу сверху (60 суток), потолок здесь — вторая линия: env
 * мимо валидатора проходит.
 */
export const PARITY_SCAN_LIMIT_MAX = 400;

export function parityScanLimit(threshold: number): number {
  return Math.min(PARITY_SCAN_LIMIT_MAX, Math.max(PARITY_SCAN_LIMIT, Math.trunc(threshold) + PARITY_STREAK_WINDOW));
}

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
 *
 * ДОПУСК ОДНОСТОРОННИЙ, И ЭТО ГЛАВНОЕ ЗДЕСЬ РЕШЕНИЕ (R-FW-P1a).
 *
 * Обе стороны — точечные чтения ОДНОГО ЖИВОГО ЭКРАНА кабинета: зеркало снимает
 * в 07:50, наш агент — в 08:05 (прод-замер: разрыв стабильно 15 минут). Фид
 * вендора реального времени, доказано третьим источником — `slot_snapshot`
 * 06:00 → чтение зеркала 07:50 → `slot_snapshot` 09:00 даёт убывающую
 * последовательность, где 07:50 лежит строго между. Значит, продажа в
 * пятнадцатиминутном окне — это ЗАКОННОЕ расхождение сверки, и стоило оно
 * (до этой правки) семи вердиктов подряд: окно `parity(7)` тянет грязный день
 * неделю.
 *
 * Направление безопасно: остаток между двумя снимками может только УБЫВАТЬ.
 * Заливки на проде идут в 17:30 и 21:00 Ташкента и в окно 07:50–08:05 не
 * попадают, поэтому:
 *  • `own > stock` (наш, ПОЗДНИЙ снимок больше раннего) — расхождение ВСЕГДА:
 *    дрейфом от продаж это невозможно, значит ошибка данных;
 *  • `stock − own > tolerance` — расхождение: убыло больше, чем объясняет
 *    четверть часа торговли;
 *  • `0 < stock − own ≤ tolerance` — «в допуске»: считается ОТДЕЛЬНО от
 *    «совпало» и уезжает в payload и в записку, иначе допуск стал бы способом
 *    не заметить настоящую убыль.
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
  /**
   * Допуск в ШТУКАХ, односторонний (R-FW-P1a). Ноль — прежнее посимвольное
   * сравнение, и это осознанное значение, а не «выключено».
   */
  tolerance = 0,
): { checked: number; mismatches: ParityStockMismatch[]; withinTolerance: number } {
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
  let withinTolerance = 0;
  const допуск = Math.max(0, tolerance);

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
    // Дельта СО ЗНАКОМ: направление и есть весь смысл допуска (см. шапку).
    const дельта = o.qty - s.qty;
    if (дельта >= 0.01) {
      mismatches.push({
        dt: o.dt,
        serial: o.serial,
        product: o.product,
        own: o.qty,
        stock: s.qty,
        reason: "у нас остаток БОЛЬШЕ — разрывом между снимками это не объясняется",
      });
    } else if (-дельта - допуск >= 0.01) {
      mismatches.push({ dt: o.dt, serial: o.serial, product: o.product, own: o.qty, stock: s.qty, reason: "остатки расходятся" });
    } else if (-дельта >= 0.01) {
      withinTolerance += 1;
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
  return { checked, mismatches, withinTolerance };
}

// Тип режима живёт в `@mydon/shared` рядом с `OurvendHealth`: его читают бот и
// панель, и вторая копия union'а разошлась бы с ответом Core в первый же день.
export type { ParityMode };

/** Ежедневный вердикт сверки целиком — обе половины и режим. */
export interface ParityReport {
  days: number;
  checked: number;
  ok: boolean;
  mismatches: ParityMismatch[];
  ownRows: number;
  mode: ParityMode;
  note: string | null;
  /** Вторая половина гейта: остатки автоматов (связь №1, П4). */
  stock: {
    days: number;
    checked: number;
    ok: boolean;
    mismatches: ParityStockMismatch[];
    /** Пар, разошедшихся В ПРЕДЕЛАХ допуска, — отдельно от «совпало» (R-FW-P1a). */
    withinTolerance: number;
    /** Действующий допуск в штуках — витрине, чтобы не держать свою копию числа. */
    tolerance: number;
    note: string | null;
  };
}

@Injectable()
export class OurvendParityService implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(OurvendParityService.name);
  private cron: Cron | null = null;

  /**
   * Заменяемо тестом (прецедент — `clock` в `RetentionService`): подключение к
   * донору открывается ЧЕРЕЗ ЭТО ПОЛЕ, иначе сверка после флипа — единственная
   * половина гейта, которую нельзя проверить без чужой живой базы.
   */
  private открытьДонора: (url: string) => Promise<StockDb> = openStockDb;

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
   *
   * С ЧЕМ СВЕРЯЕМ — РЕШАЕТ РЕЖИМ (R-FW-P3), И ЭТО НЕ КОСМЕТИКА.
   *
   * • `mirror` (источник `stock`) — свой снапшот против `sale`/`machine_stock`,
   *   которые наполняет зеркало. Это исходный гейт: «сходятся ли две дорожки».
   * • `own-vs-donor` (источник `own`, зеркало ещё живо) — свой снапшот против
   *   ТАБЛИЦ ДОНОРА напрямую. После флипа `sale` и `machine_stock` наполняются
   *   ИЗ ЭТОГО ЖЕ СНАПШОТА, и сверка с ними доказывала бы идемпотентность
   *   upsert-а, а не правильность чисел: растущая серия зелёных дней на шаге 2
   *   рунбука была бы самообманом. Донор при этом продолжает снимать кабинет
   *   независимо — значит независимая сторона есть, пока не погашена
   *   переменная.
   * • `retired` (источник `own`, `STOCK_DATABASE_URL` погашен, шаг 3 рунбука) —
   *   сверять НЕ С ЧЕМ, и сказать это надо прямо. Молчаливый «зелёный» здесь
   *   был бы худшим из исходов: гейт, который больше ничего не проверяет, но
   *   выглядит как проверяющий.
   */
  async parity(days = 7, now = new Date()): Promise<ParityReport> {
    const n = Math.min(Math.max(Math.trunc(days) || 7, 1), 30);
    // `now` — параметр по той же причине, что у `streak()`: кеш источника учёта
    // ключуется временем, и вызов без момента считал бы его срок по стенным
    // часам там, где вызывающий уже держит свой момент.
    const источник = await accountingSource(this.db, now);
    const url = (process.env.STOCK_DATABASE_URL ?? "").trim();
    const mode: ParityMode = источник === "own" ? (url === "" ? "retired" : "own-vs-donor") : "mirror";
    const допуск = await stockParityTolerance(this.db, this.log);

    if (mode === "retired") {
      const записка = "зеркала нет — сверять не с чем: учёт свой, донор погашен";
      return {
        days: n,
        checked: 0,
        ok: false,
        mismatches: [],
        ownRows: 0,
        mode,
        note: записка,
        stock: { days: n, checked: 0, ok: false, mismatches: [], withinTolerance: 0, tolerance: допуск, note: записка },
      };
    }

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

    const другая = mode === "mirror" ? await this.сторонаЗеркала(n) : await this.сторонаДонора(n, url);

    const own = ownRaw.map((r) => ({ ...r, qty: Number(r.qty), amount: Number(r.amount) }));
    const stockSide = другая.sales.map((r) => ({ ...r, qty: Number(r.qty), amount: Number(r.amount) }));
    const { checked, mismatches } = computeParity(own, stockSide);

    const { notInService } = await this.vending.machineRegistry();
    const ownStock = ownStockRaw.map((r) => ({ ...r, qty: Number(r.qty) }));
    const stockStock = другая.stock.map((r) => ({ ...r, qty: Number(r.qty) }));
    const остатки = computeStockParity(ownStock, stockStock, new Set(notInService.keys()), допуск);
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
          : остатки.withinTolerance > 0
            ? // Число «в допуске» — ОТДЕЛЬНО от «совпало»: допуск, о котором
              // молчат, превращается в способ не заметить убыль.
              `${остатки.withinTolerance} поз. в допуске ±${допуск} шт (снимки сняты с разницей ~15 мин)`
            : null;
    const stock = {
      days: n,
      checked: остатки.checked,
      ok: остатки.mismatches.length === 0 && остатки.checked > 0,
      mismatches: остатки.mismatches,
      withinTolerance: остатки.withinTolerance,
      tolerance: допуск,
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
      mode,
      note,
      stock,
    };
  }

  /**
   * Сторона ЗЕРКАЛА — наши же `sale`/`machine_stock`, наполненные из mydon-stock.
   *
   * Stock-сторона НЕ фильтруется по дням снапшота: день, выпавший из снапшота
   * (сбой агента, пустая перезапись), обязан всплыть расхождением «в нашем
   * снапшоте нет», а не исчезнуть из сверки. Дни до внедрения снапшота
   * отсекаются его минимальной датой — иначе вся история до старта была бы
   * вечным красным.
   */
  private async сторонаЗеркала(n: number): Promise<{ sales: ParityDayRow[]; stock: ParityStockRow[] }> {
    const canon = (col: string) => sql.raw(machineSerialSql(col));
    const sales = (await this.db.execute(sql`
      select dt::text as dt, ${canon("machine_serial")} as serial,
             sum(qty)::float as qty, sum(amount)::float as amount
      from ${sale}
      where source = 'ourvend'
        and dt >= (current_date - ${sql.raw(String(n))}::int)
        and dt < current_date
        and dt >= (select min(dt) from ${ourvendSaleSnapshot})
      group by 1, 2
    `)) as unknown as ParityDayRow[];
    const stock = (await this.db.execute(sql`
      select dt::text as dt, ${canon("machine_serial")} as serial, product,
             sum(qty)::float as qty
      from ${machineStock}
      where dt >= (current_date - ${sql.raw(String(n))}::int)
        and dt < current_date
        and dt >= (select min(dt) from ${ourvendStockSnapshot})
      group by 1, 2, 3
    `)) as unknown as ParityStockRow[];
    return { sales, stock };
  }

  /**
   * Сторона ДОНОРА — таблицы `ourvend_sales`/`ourvend_machine_stock` в БД
   * mydon-stock, ЧИТАЕМЫЕ НАПРЯМУЮ (R-FW-P3).
   *
   * Только `select`, тем же подключением и с теми же параметрами, что у синков
   * (`supply/stock-db.ts`), и закрывается оно здесь же в `finally`: чужая база
   * не должна держать наше соединение дольше запроса.
   *
   * Нижняя граница по дате приезжает ПАРАМЕТРОМ, а не подзапросом: минимальная
   * дата снапшота лежит в НАШЕЙ базе, и повторить `(select min(dt) …)` на
   * стороне донора нечем. Смысл границы тот же, что у зеркальной стороны —
   * история до внедрения снапшота не должна быть вечным красным.
   *
   * `unsafe` — потому что канон серийника это выражение SQL (общий хелпер
   * `machineSerialSql`), а тегированный шаблон `postgres` подставил бы его
   * строкой-параметром. Внутрь текста запроса не попадает НИЧЕГО от
   * пользователя: `n` — зажатое целое, даты — параметры `$1`/`$2`.
   */
  private async сторонаДонора(n: number, url: string): Promise<{ sales: ParityDayRow[]; stock: ParityStockRow[] }> {
    const [границы] = (await this.db.execute(sql`
      select (select min(dt)::text from ${ourvendSaleSnapshot}) as sale_min,
             (select min(dt)::text from ${ourvendStockSnapshot}) as stock_min
    `)) as unknown as { sale_min: string | null; stock_min: string | null }[];

    const донор = await this.открытьДонора(url);
    try {
      const sales = (await донор.unsafe(
        `select dt::text as dt, ${machineSerialSql("machine_serial")} as serial,
                sum(qty)::float as qty, sum(amount)::float as amount
           from ourvend_sales
          where dt >= (current_date - $1::int) and dt < current_date
            and ($2::date is null or dt >= $2::date)
          group by 1, 2`,
        [n, границы?.sale_min ?? null],
      )) as unknown as ParityDayRow[];
      const stock = (await донор.unsafe(
        `select dt::text as dt, ${machineSerialSql("machine_serial")} as serial,
                ourvend_name as product, sum(qty)::float as qty
           from ourvend_machine_stock
          where dt >= (current_date - $1::int) and dt < current_date
            and ($2::date is null or dt >= $2::date)
          group by 1, 2, 3`,
        [n, границы?.stock_min ?? null],
      )) as unknown as ParityStockRow[];
      return { sales, stock };
    } finally {
      await донор.end({ timeout: 5 });
    }
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
    // Порог читается ПЕРВЫМ, а не рядом в `Promise.all`: от него зависит,
    // сколько строк журнала вообще имеет смысл читать (см. `parityScanLimit`).
    // Один лишний round-trip к `system_config` раз в сутки дешевле, чем гейт,
    // который молча не открывается при пороге больше окна.
    const порог = await cutoverThreshold(this.db, this.log);
    const строки = await this.db
      .select({ occurredAt: event.occurredAt, payload: event.payload })
      .from(event)
      // Фильтр по ТИПУ — в SQL, а не в памяти: `event` общая на весь Core
      // (`sales.sync` один даёт ~150 строк в сутки), и чтение «свежих N любых»
      // с отсевом после забило бы окно чужими событиями, а серия навсегда
      // встала бы в ноль. Индекс `event_type_time_idx` ровно под это.
      //
      // И ПО ИСТОЧНИКУ (R-FW-S6). `POST /events` под сервисным токеном
      // принимает любой `type` и любую дату: носитель токена (бот, панель,
      // агент) без этого фильтра писал бы семь «зелёных» `ourvend.parity` и
      // открывал гейт переключения учёта, а датами из будущего забивал окно
      // чтения. Источник пишет только `daily()` — тем же именем.
      .where(and(eq(event.type, PARITY_EVENT), eq(event.source, PARITY_EVENT_SOURCE)))
      .orderBy(desc(event.occurredAt))
      .limit(parityScanLimit(порог));
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
    const p = await this.parity(7, now);
    // ВТОРОЙ ПРОГОН — НА ОДИН ДЕНЬ, И ОН ЖЕ СУДИТ ГЕЙТ (P1b, уточнение
    // R-P8b-1). Окно `parity(7)` берёт `dt >= current_date - 7`, то есть день
    // X входит в вердикты X+1…X+7: одна продажа в пятнадцатиминутном разрыве
    // между съёмами красила бы гейт НЕДЕЛЮ, и «семь зелёных подряд» на
    // прод-данных выпадали бы примерно в 9 % месяцев. Грязный день обязан
    // стоить одни сутки — поэтому серия считается по полям `день_*`, а
    // семидневка остаётся витриной. Второй прогон стоит четырёх запросов раз в
    // сутки; неоткрывшийся гейт стоил бы недель ожидания.
    const день = await this.parity(1, now);
    // Событие пишем ВСЕГДА, даже когда одна половина пуста. Прежний ранний
    // выход из-за пустого снапшота продаж уносил с собой и половину по
    // остаткам: в журнале не оставалось ни строки, и «гейт молчит» было не
    // отличить от «гейт не запускался».
    await this.db.insert(event).values({
      source: PARITY_EVENT_SOURCE,
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
        остатки_в_допуске: p.stock.withinTolerance,
        примечание: p.note,
        // С ЧЕМ сверяли — в журнал: через месяц по строке должно быть понятно,
        // была ли эта «зелень» сверкой с независимой стороной или сверкой
        // снапшота с самим собой.
        режим: p.mode,
        // ── ВЕРДИКТ ЗА ОДИН ПОСЛЕДНИЙ ПОЛНЫЙ ДЕНЬ — по нему и только по нему
        // считается серия (`parityStreak` в @mydon/shared).
        день_ok: день.ok,
        день_продаж_сверено: день.checked,
        день_остатков_сверено: день.stock.checked,
        // ОДНО число на обе половины: серия зелёная, когда за день не разошлось
        // НИЧЕГО, и разбирать чьи именно расхождения ей незачем — подробности
        // лежат рядом, в недельных списках.
        день_расхождений: день.mismatches.length + день.stock.mismatches.length,
        день_остатков_в_допуске: день.stock.withinTolerance,
        день_примечание: день.note,
      },
    });
    this.log.log(
      `Паритет OurVend (${p.mode}): ${p.ok ? "ОК" : "расхождения"} — продажи ${p.mismatches.length} из ${p.checked} пар, ` +
        `остатки ${p.stock.mismatches.length} из ${p.stock.checked}` +
        (p.stock.withinTolerance > 0 ? `, в допуске ${p.stock.withinTolerance}` : "") +
        `. Вердикт за день: ${день.ok ? "зелёный" : "красный"} ` +
        `(продажи ${день.checked}, остатки ${день.stock.checked}, расхождений ` +
        `${день.mismatches.length + день.stock.mismatches.length}).` +
        (p.note ? ` (${p.note})` : ""),
    );

    // СВОЙ catch: вердикт уже записан и красным не стал. Упади сигнал под общим
    // ловцом крона, в логе осталось бы «Паритет OurVend не посчитался» — то
    // есть неправда о сверке вместо правды о сигнале, и чинить пошли бы не то.
    try {
      await this.сигналКатовера(now);
    } catch (e: unknown) {
      this.log.warn(
        `Сигнал готовности к катоверу не отработал (сам паритет посчитан и записан): ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
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
