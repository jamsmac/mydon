import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { Cron } from "croner";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { event, machineSlot, sale, slotSnapshot, vendingRefill, vendingRefillEvent } from "@mydon/db";
import {
  deadMachine,
  hasProduct,
  normalizeMachineSerial,
  shrinkageByDay,
  slotValid,
  TZ,
  type MachineSnapshot,
  type ShrinkDayInput,
  type ShrinkSummary,
  type Slot,
  type SnapshotSlot,
} from "@mydon/shared";
import { DB, type Db } from "../db/db.module";
import { readIntSetting } from "../system/settings";
import { skipReasonOf, type SkipReason } from "./refill-events.service";
import { VendingService } from "./vending.service";

/** Дни отчёта по умолчанию — окно, на котором порог 30 000 сум уже бьёт (донор mydon-stock). */
export const SHRINK_DAYS_DEFAULT = 14;
/**
 * Потолок окна: снимки читаются по автомату, но 60 суток парка — это уже
 * полмиллиона строк за прогон. Глубже — разовый разбор выгрузкой, не отчётом.
 */
export const SHRINK_DAYS_MAX = 60;
/** Порог алерта, если настройки нет (донор mydon-stock, `SHRINK_ALERT_UZS`). */
export const SHRINK_ALERT_FALLBACK = 30_000;
/** Окно суточного алерта: неделя — столько владелец держит в голове. */
export const ALERT_DAYS = 7;
/**
 * Насколько далеко от границы суток может стоять снимок, чтобы считаться
 * «границей дня». Снимки идут раз в 3 ч, поэтому 6 ч — это пропущенный сбор,
 * а не смещение расписания: считать по нему значит приписать автомату чужие
 * продажи соседних суток.
 */
export const SNAPSHOT_STALE_MS = 6 * 3_600_000;
/** «Заканчивается»: столько штук осталось по товару. */
export const LOW_STOCK_LEFT = 1;
/**
 * Ниже этой суммарной ёмкости «остался один» — не новость: одинокая пружина
 * на 4 позиции пустеет каждый день и превратила бы брифинг в шум.
 */
export const LOW_STOCK_MIN_CAPACITY = 5;

export const SHRINK_EVENT = "vending.shrinkage_alert";
export const LOW_STOCK_EVENT = "machine.low_stock";

/** Ташкент без перехода на летнее время: смещение постоянное. */
const TZ_OFFSET_MS = 5 * 3_600_000;
const DAY_MS = 86_400_000;

export interface ShrinkRefillDay {
  /** Дата по Ташкенту, YYYY-MM-DD. */
  date: string;
  /** Приход по снимкам (детектор). */
  detectedUnits: number;
  /** Записано оператором в боте за эти сутки. */
  recordedUnits: number;
}

export interface ShrinkMachine {
  /** Серийник в каноне (без приставки «c»). */
  serial: string;
  name: string;
  summary: ShrinkSummary;
  /** Дни заливок: из расчёта усушки они выкинуты, но владельцу нужны. */
  refillDays: ShrinkRefillDay[];
}

/**
 * Почему в отчёте чего-то нет. Ровно три причины, потому что чинятся они в
 * разных местах: снимки (сбор), продажи (синк), автомат (источник).
 */
export type ShrinkWarningCode = "snapshots_stale" | "no_sales_day" | "machine_dead";

export interface ShrinkWarning {
  code: ShrinkWarningCode;
  message: string;
}

export interface ShrinkReport {
  /** Первый день периода по Ташкенту, YYYY-MM-DD. */
  from: string;
  /** Последний день — ВЧЕРА: у сегодняшних суток нет снимка на конец. */
  to: string;
  threshold: number;
  machines: ShrinkMachine[];
  warnings: ShrinkWarning[];
}

/** Человеческая причина молчания источника по автомату. */
const ПРИЧИНА: Record<SkipReason, string> = {
  dead: "источник отдаёт ёмкости вне диапазона (заглушка)",
  uncalibrated: "ёмкости слотов не откалиброваны",
  no_slots: "в автомате нет назначенных слотов",
};

/**
 * Усушка автомата по дням (П4, R-P4-3).
 *
 * ЗАЧЕМ. Между «сколько стояло», «сколько продано» и «сколько осталось» на
 * снеке regularly не сходится, и до этого среза расхождение не видел никто:
 * ручной инвентаризации автомата нет и не будет (снимок раз в 3 ч точнее
 * пересчёта руками), а продажи и остатки лежали в разных отчётах.
 *
 * ПОЧЕМУ ПО ДНЯМ БЕЗ ЗАЛИВОК. В сутки заливки приход и продажи гасятся внутри
 * одного 3-часового окна, и сходимость искажается — на живых данных дни без
 * заливки сходятся ровно в ноль, а дни заливки «шумят» десятками штук.
 * Поэтому день с приходом выкидывается ЦЕЛИКОМ (не по позиции), а владельцу
 * показывается отдельной строкой: «приход N ед по снимку, записано M».
 *
 * ЧЕГО СЕРВИС НЕ ДЕЛАЕТ: не правит остатки и не списывает склад. Усушка —
 * наблюдение, а не проводка; списывать по ней значит закрепить догадку.
 */
@Injectable()
export class ShrinkageService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ShrinkageService.name);
  private cron: Cron | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly vending: VendingService,
  ) {}

  /**
   * 08:35 по Ташкенту — после утреннего сбора слотов и синка продаж, но до
   * брифинга: событие должно успеть попасть в утреннюю сводку владельца.
   */
  onModuleInit(): void {
    this.cron = new Cron("35 8 * * *", { timezone: TZ }, () => {
      void this.alertDaily().catch((e: unknown) =>
        this.logger.warn(`Алерты усушки не посчитались: ${e instanceof Error ? e.message : String(e)}`),
      );
    });
  }

  onApplicationShutdown(): void {
    this.cron?.stop();
    this.cron = null;
  }

  /**
   * Отчёт об усушке за `days` полных суток по Ташкенту.
   *
   * Период кончается ВЧЕРА: у сегодняшних суток нет снимка на 24:00, и
   * включать их значило бы каждый день показывать «недостачу», которая на
   * самом деле ещё не проданный товар.
   */
  async report(days = SHRINK_DAYS_DEFAULT): Promise<ShrinkReport> {
    const dates = периодДней(зажать(days, SHRINK_DAYS_DEFAULT, SHRINK_DAYS_MAX));
    const from = dates[0]!;
    const to = dates[dates.length - 1]!;
    // Снимки читаем с запасом на допуск: снимок «начала суток» законно стоит
    // за несколько часов ДО полуночи.
    const since = new Date(началоСуток(from) - SNAPSHOT_STALE_MS);
    const периодОт = new Date(началоСуток(from));

    const [threshold, { canonOf, priceByName }, registry, серии, продажи, события, записи] = await Promise.all([
      readIntSetting(this.db, "SHRINK_ALERT_UZS", SHRINK_ALERT_FALLBACK, this.logger),
      this.vending.priceIndex(),
      this.vending.machineRegistry(),
      // Сначала СПИСОК автоматов окна: снимки по одному автомату читаются
      // ниже, иначе 60 суток парка легли бы в память разом (тот же приём, что
      // в детекторе заливок).
      this.db
        .select({ serial: slotSnapshot.machineSerial })
        .from(slotSnapshot)
        .where(gte(slotSnapshot.capturedAt, since))
        .groupBy(slotSnapshot.machineSerial),
      // Продажи — из `sale` (день + автомат + товар): это единственная
      // таблица, где продажи разложены ПО ДНЯМ. `product_sale` хранит
      // последний 7-дневный батч без разбивки по суткам и для усушки не
      // годится. Источник не фильтруем: писателя у `sale` один
      // (`SalesService`), и жёсткое `source = 'ourvend'` тихо обнулило бы
      // продажи в день, когда источник переименуют, — а нулевые продажи
      // выглядят как недостача во весь остаток.
      this.db
        .select({ dt: sale.dt, machineSerial: sale.machineSerial, product: sale.product, qty: sale.qty })
        .from(sale)
        .where(and(gte(sale.dt, from), lte(sale.dt, to))),
      this.db
        .select({
          machineSerial: vendingRefillEvent.machineSerial,
          windowTo: vendingRefillEvent.windowTo,
          units: vendingRefillEvent.units,
        })
        .from(vendingRefillEvent)
        .where(gte(vendingRefillEvent.windowTo, периодОт)),
      this.db
        .select({ machineSerial: vendingRefill.machineSerial, performedAt: vendingRefill.performedAt, qty: vendingRefill.qty })
        .from(vendingRefill)
        .where(gte(vendingRefill.performedAt, периодОт)),
    ]);

    // Продажи по (автомат, сутки) → товар в каноне. Отсутствие ключа и пустая
    // карта — РАЗНЫЕ вещи: первое значит «продажи за день не собраны» (день
    // не считаем), второе невозможно, потому что ключ рождается из строки.
    const продажиПоДням = new Map<string, Map<string, number>>();
    for (const r of продажи) {
      const ключ = `${normalizeMachineSerial(r.machineSerial)}|${r.dt}`;
      const карта = продажиПоДням.get(ключ) ?? new Map<string, number>();
      const name = canonOf(r.product);
      карта.set(name, (карта.get(name) ?? 0) + Number(r.qty));
      продажиПоДням.set(ключ, карта);
    }

    const приходПоДням = сумма(события, (r) => `${normalizeMachineSerial(r.machineSerial)}|${деньТашкента(r.windowTo)}`, (r) => r.units);
    const записаноПоДням = сумма(записи, (r) => `${normalizeMachineSerial(r.machineSerial)}|${деньТашкента(r.performedAt)}`, (r) => r.qty);

    const machines: ShrinkMachine[] = [];
    const warnings: ShrinkWarning[] = [];
    const учтённые = new Set<string>();

    for (const { serial } of серии) {
      const canon = normalizeMachineSerial(serial);
      // Автомат не в строю в усушку не идёт: у склада-«автомата» и машины в
      // ремонте расхождение остатка — норма, и тревожить им владельца значит
      // приучить его пролистывать отчёт. Про них говорит план закупа.
      if (registry.notInService.has(canon)) continue;
      if (учтённые.has(canon)) continue;
      учтённые.add(canon);
      const name = registry.nameBySerial.get(canon) ?? serial;

      const снимки = await this.снимкиАвтомата(serial, since, canonOf);
      if (снимки.length === 0) continue;

      // Мёртвый автомат — вон, но С ПРИЧИНОЙ. Причины «источник врёт» и
      // «слоты не откалиброваны» чинятся в разных местах, поэтому текст
      // предупреждения у них разный, хотя код один: для читателя отчёта это
      // одно и то же — «по автомату сказать нечего».
      const причина = skipReasonOf(снимки);
      if (причина) {
        warnings.push({ code: "machine_dead", message: `${name}: ${ПРИЧИНА[причина]} — усушка не считается` });
        continue;
      }

      const дни: ShrinkDayInput[] = [];
      const refillDays: ShrinkRefillDay[] = [];
      const староСнимков: string[] = [];
      const безПродаж: string[] = [];

      for (const date of dates) {
        const приход = приходПоДням.get(`${canon}|${date}`) ?? 0;
        if (приход > 0) {
          refillDays.push({ date, detectedUnits: приход, recordedUnits: записаноПоДням.get(`${canon}|${date}`) ?? 0 });
        }
        const начало = ближайший(снимки, началоСуток(date));
        const конец = ближайший(снимки, началоСуток(date) + DAY_MS);
        if (!начало || !конец) {
          староСнимков.push(date);
          continue;
        }
        const продажиДня = продажиПоДням.get(`${canon}|${date}`);
        if (!продажиДня && приход === 0) {
          // Несобранные продажи выглядят как недостача во весь дневной расход —
          // самый громкий ложный алерт, какой этот отчёт может выдать.
          безПродаж.push(date);
          continue;
        }
        дни.push({
          date,
          startSlots: начало.slots,
          endSlots: конец.slots,
          sales: продажиДня ?? new Map<string, number>(),
          refillUnits: приход,
        });
      }

      machines.push({ serial: canon, name, summary: shrinkageByDay(дни, priceByName, threshold), refillDays });
      // Одна строка на автомат, а не на день: 26 автоматов × 14 дней дали бы
      // триста предупреждений, среди которых не видно ни одного.
      if (староСнимков.length > 0) {
        warnings.push({
          code: "snapshots_stale",
          message: `${name}: нет снимков у границ суток — пропущены дни ${староСнимков.join(", ")}`,
        });
      }
      if (безПродаж.length > 0) {
        warnings.push({
          code: "no_sales_day",
          message: `${name}: нет продаж за ${безПродаж.join(", ")} — дни не считались`,
        });
      }
    }

    machines.sort((a, b) => b.summary.lossValue - a.summary.lossValue || a.name.localeCompare(b.name, "ru"));
    warnings.sort((a, b) => a.code.localeCompare(b.code) || a.message.localeCompare(b.message, "ru"));
    return { from, to, threshold, machines, warnings };
  }

  /**
   * Суточные алерты: усушка за порогом и «заканчивается товар».
   *
   * ДЕДУП ПО СУТКАМ, а не по факту: усушка за 7 дней держится за порогом всю
   * неделю, и без него владелец получал бы одну и ту же строку семь утр
   * подряд, пока не перестал бы читать брифинг целиком.
   */
  async alertDaily(): Promise<{ alerts: number }> {
    const отчёт = await this.report(ALERT_DAYS);
    const сутки = new Date(началоСуток(деньТашкента(new Date())));

    const [написанное, слоты, registry, { canonOf }] = await Promise.all([
      this.db
        .select({ type: event.type, payload: event.payload })
        .from(event)
        .where(and(inArray(event.type, [SHRINK_EVENT, LOW_STOCK_EVENT]), gte(event.occurredAt, сутки))),
      this.db
        .select({
          machineSerial: machineSlot.machineSerial,
          coilId: machineSlot.coilId,
          productName: machineSlot.productName,
          capacity: machineSlot.capacity,
          quantity: machineSlot.quantity,
        })
        .from(machineSlot),
      this.vending.machineRegistry(),
      this.vending.priceIndex(),
    ]);

    const занято = new Set<string>();
    for (const e of написанное) {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      if (e.type === SHRINK_EVENT) занято.add(`${SHRINK_EVENT}|${String(p.serial)}|${String(p.product)}`);
      else занято.add(`${LOW_STOCK_EVENT}|${String(p.machine)}|${String(p.product)}`);
    }

    const строки: { source: string; type: string; payload: Record<string, unknown> }[] = [];
    const добавить = (type: string, ключ: string, payload: Record<string, unknown>): void => {
      if (занято.has(ключ)) return;
      занято.add(ключ);
      строки.push({ source: "system", type, payload });
    };

    for (const m of отчёт.machines) {
      for (const item of m.summary.items) {
        if (!item.alert) continue;
        добавить(SHRINK_EVENT, `${SHRINK_EVENT}|${m.serial}|${item.product}`, {
          serial: m.serial,
          name: m.name,
          product: item.product,
          lossUnits: item.lossUnits,
          lossValue: item.lossValue,
          days: ALERT_DAYS,
        });
      }
    }

    // «Заканчивается» считается по ПЛАНОГРАММЕ (`machine_slot`), а не по
    // усушке: это разные вопросы. Товар может не усыхать вовсе и при этом
    // кончиться, и наоборот.
    const поАвтоматам = new Map<string, Slot[]>();
    for (const r of слоты) {
      const список = поАвтоматам.get(r.machineSerial) ?? [];
      список.push({ coilId: r.coilId, product: r.productName, capacity: r.capacity, quantity: r.quantity });
      поАвтоматам.set(r.machineSerial, список);
    }
    for (const [serial, список] of поАвтоматам) {
      const canon = normalizeMachineSerial(serial);
      if (registry.notInService.has(canon) || deadMachine(список)) continue;
      const name = registry.nameBySerial.get(canon) ?? serial;
      const поТовару = new Map<string, { qty: number; cap: number }>();
      for (const s of список) {
        if (!hasProduct(s) || !slotValid(s)) continue;
        const product = canonOf(s.product!);
        const a = поТовару.get(product) ?? { qty: 0, cap: 0 };
        a.qty += Math.min(s.quantity, s.capacity);
        a.cap += s.capacity;
        поТовару.set(product, a);
      }
      for (const [product, a] of поТовару) {
        if (a.cap < LOW_STOCK_MIN_CAPACITY || a.qty > LOW_STOCK_LEFT) continue;
        добавить(LOW_STOCK_EVENT, `${LOW_STOCK_EVENT}|${name}|${product}`, { machine: name, product, left: a.qty });
      }
    }

    if (строки.length > 0) await this.db.insert(event).values(строки);
    return { alerts: строки.length };
  }

  /**
   * Снимки одного автомата за окно, ОДНИМ запросом на автомат (осознанный
   * N+1 при парке ≤ ~30 машин — см. детектор заливок). Имя товара приводится
   * к канону ДО расчёта: тот же товар приезжает из Ourvend под разными
   * именами, и без канона он не сошёлся бы ни с продажами, ни с ценой.
   */
  private async снимкиАвтомата(serial: string, since: Date, canonOf: (raw: string) => string): Promise<MachineSnapshot[]> {
    const строки = await this.db
      .select({
        coilId: slotSnapshot.coilId,
        productName: slotSnapshot.productName,
        capacity: slotSnapshot.capacity,
        quantity: slotSnapshot.quantity,
        capturedAt: slotSnapshot.capturedAt,
      })
      .from(slotSnapshot)
      .where(and(eq(slotSnapshot.machineSerial, serial), gte(slotSnapshot.capturedAt, since)));

    const поМоменту = new Map<number, MachineSnapshot>();
    for (const r of строки) {
      const t = r.capturedAt.getTime();
      let снимок = поМоменту.get(t);
      if (!снимок) {
        снимок = { serial, capturedAt: r.capturedAt, slots: [] };
        поМоменту.set(t, снимок);
      }
      const имя = r.productName?.trim();
      const слот: SnapshotSlot = {
        coilId: r.coilId,
        product: имя ? canonOf(имя) : null,
        capacity: r.capacity,
        quantity: r.quantity,
      };
      снимок.slots.push(слот);
    }
    return [...поМоменту.values()].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
  }
}

/** Дни периода по Ташкенту: `days` полных суток, последние — вчерашние. */
function периодДней(days: number): string[] {
  const сегодня = деньТашкента(new Date());
  const out: string[] = [];
  for (let i = days; i >= 1; i--) out.push(деньТашкента(new Date(началоСуток(сегодня) - i * DAY_MS)));
  return out;
}

/** YYYY-MM-DD суток по Ташкенту для момента. */
function деньТашкента(at: Date): string {
  return new Date(at.getTime() + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

/** UTC-момент 00:00 Ташкента для даты YYYY-MM-DD. */
function началоСуток(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`) - TZ_OFFSET_MS;
}

/**
 * Снимок, ближайший к границе суток, — или `null`, если ближайший дальше
 * допуска. Молча взять снимок суточной давности значит приписать автомату
 * продажи соседнего дня.
 */
function ближайший(снимки: MachineSnapshot[], граница: number): MachineSnapshot | null {
  let лучший: MachineSnapshot | null = null;
  let дистанция = Number.POSITIVE_INFINITY;
  for (const s of снимки) {
    const d = Math.abs(s.capturedAt.getTime() - граница);
    if (d < дистанция) {
      дистанция = d;
      лучший = s;
    }
  }
  return дистанция <= SNAPSHOT_STALE_MS ? лучший : null;
}

function сумма<T>(rows: T[], ключ: (r: T) => string, значение: (r: T) => number): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const k = ключ(r);
    out.set(k, (out.get(k) ?? 0) + значение(r));
  }
  return out;
}

function зажать(days: number, дефолт: number, потолок: number): number {
  const n = Math.trunc(days);
  if (!Number.isFinite(n) || n <= 0) return дефолт;
  return Math.min(n, потолок);
}
