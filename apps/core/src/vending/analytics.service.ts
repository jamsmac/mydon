import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, gt, gte, inArray, lte } from "drizzle-orm";
import { event, machineStock, sale, vendingPurchaseOrder, vendingRefillEvent, vendingStock } from "@mydon/db";
import {
  deadStock,
  machineMovementKey,
  marginByMachine,
  normalizeMachineSerial,
  normalizeProductName,
  priceChanges,
  priceGap,
  retailDaily,
  tashkentDay,
  tashkentDayStart,
  tashkentDayStartOf,
  weightedCost,
  type CostIndex,
  type DeadStockReport,
  type MarginReport,
  type PriceChangesReport,
  type PriceGapReport,
  type PurchasePriceEvent,
  type SaleRow,
  type StockPosition,
} from "@mydon/shared";
import { DB, type Db } from "../db/db.module";
import { readIntSetting } from "../system/settings";
import { REPORT_CACHE_MS } from "./shrinkage.service";
import { VendingService } from "./vending.service";

/**
 * Аналитика снек-контура (П5b): маржа, мёртвый сток, изменения цен, разрыв
 * витрины с эталоном.
 *
 * ЧТО ЗДЕСЬ ЕСТЬ И ЧЕГО НЕТ. Считают чистые функции `@mydon/shared`
 * (`vending-reports.ts`) — они же считают у бота и панели, поэтому число у
 * владельца везде одно (R-P5b-10). Этот сервис отвечает за другое: какие
 * СТРОКИ базы попадают в расчёт, из какого справочника берутся имена и пороги,
 * и что сказать владельцу, когда строк нет. Арифметики маржи и цен здесь быть
 * не должно — вторая реализация неизбежно разойдётся с первой.
 *
 * ЧЕТЫРЕ ПРАВИЛА ВЫБОРКИ, КОТОРЫЕ НЕЛЬЗЯ «УПРОСТИТЬ».
 *
 * 1. Деньги — только из `sale` (R-P5b-1). `product_sale`/`machine_sale` — это
 *    скользящее семидневное окно кабинета: сумма по `captured_at` даёт 37 613
 *    штук за 30 дней против честных 1047 в `sale`, то есть завышение в 36 раз.
 *    Ни один отчёт этого модуля их не читает.
 *
 * 2. Автоматы — только `machine_card.status = 'in_service'`. На проде склады
 *    SKLAD 4S/5S/6S отдают слоты-заглушки (7 960 «единиц», 45 млн сум остатка),
 *    а один раз SKLAD 4S ещё и «продал» 1 шт Moxito на 12 000 сум. Без фильтра
 *    мёртвый сток врёт на порядки, а витринная цена дня получает выброс.
 *    Выброшенные продажи не теряются молча: маржа называет их в `excluded`,
 *    а предупреждение `excluded_sales` говорит об этом словами.
 *
 * 3. Окно — ташкентские сутки, последний закрытый день ВЧЕРА. `sale.dt` — это
 *    закрытый бизнес-день Ташкента, а база живёт в UTC: `date_trunc` резал бы
 *    по UTC и уводил границу на пять часов. Исключение — мёртвый сток: там
 *    окно кончается СЕГОДНЯ, потому что товар, проданный сегодня утром,
 *    «мёртвым» назвать нельзя.
 *
 * 4. Имена товаров приводятся к канону ОДНИМ резолвером `VendingService`
 *    (алиасы `vending_alias`), а серийники — `normalizeMachineSerial`. Свой
 *    канон здесь завёлся бы вторым и разошёлся бы с закупом: «Moxito клуб» и
 *    «Moxito Klubnika» стали бы двумя товарами с разной маржой.
 *
 * ПУСТОТА ГОВОРИТ ВСЛУХ. Ноль в отчёте читается как «всё хорошо», хотя чаще
 * означает «данных нет»: не приехали продажи, не собран остаток, не задан
 * эталон. Поэтому у каждого отчёта есть `warnings` с кодом причины — и каждая
 * причина чинится в своём месте (синк, сбор, прайс, слово владельца).
 */

/** Окно маржи: 30 суток — то же, что у донора; глубже 90 — разовый разбор, не отчёт. */
export const MARGIN_DAYS_DEFAULT = 30;
export const MARGIN_DAYS_MAX = 90;
/** Окно мёртвого стока (боевое значение — настройка `DEAD_STOCK_DAYS`). */
export const DEAD_STOCK_DAYS_FALLBACK = 21;
export const DEAD_STOCK_DAYS_MAX = 180;
/** Окно лент изменения цен: пол-года хватает, чтобы увидеть сезонный подъём. */
export const PRICE_CHANGES_DAYS_DEFAULT = 30;
export const PRICE_CHANGES_DAYS_MAX = 180;
/** Окно факта витрины — то же, что у гейта команды «цена продажи» (R-P5b-6). */
export const PRICE_GAP_DAYS_DEFAULT = 14;
export const PRICE_GAP_DAYS_MAX = 90;
/** Пороги и окна из настроек (R-P5b-11); числа повторяют `config-spec.ts`. */
export const PRICE_CHANGE_PCT_FALLBACK = 5;
export const PRICE_GAP_PCT_FALLBACK = 5;
export const COST_WINDOW_DAYS_FALLBACK = 90;
export const MARGIN_LOW_PCT_FALLBACK = 15;

/** События, из которых собирается лента ЗАКУПОЧНЫХ цен (R-P5b-5). */
export const PRICE_EVENT_TYPES = ["vending.price_changed", "vending.purchase_price_observed"] as const;

const DAY_MS = 86_400_000;

/**
 * Почему в отчёте чего-то нет. Коды не сводятся к одному «нет данных»: каждый
 * чинится В СВОЁМ МЕСТЕ — продажи чинит синк, остаток автомата чинит сбор,
 * себестоимость чинит прайс, эталон витрины чинит слово владельца, а строки
 * не в строю чинит карточка автомата.
 */
export type AnalyticsWarningCode = "no_sales" | "stock_missing" | "unknown_cost" | "no_reference" | "excluded_sales";

export interface AnalyticsWarning {
  code: AnalyticsWarningCode;
  message: string;
}

/**
 * Помесячная динамика цен — донорский `price_dynamics`, его просит ТОЛЬКО
 * панель (R-P5b-5). `retail` — средняя витринная за месяц (Σamount/Σqty),
 * `purchase` — средняя из наблюдений закупки. `null` — не «ноль сум», а «в
 * этом месяце такой цены не наблюдали».
 */
export interface MonthlyPrice {
  product: string;
  month: string;
  retail: number | null;
  purchase: number | null;
}

export type MarginResponse = MarginReport & { warnings: AnalyticsWarning[] };
export type DeadStockResponse = DeadStockReport & { warnings: AnalyticsWarning[] };
export type PriceChangesResponse = PriceChangesReport & { monthly: MonthlyPrice[]; warnings: AnalyticsWarning[] };
export type PriceGapResponse = PriceGapReport & { warnings: AnalyticsWarning[] };

/** Строка продаж окна вместе с исходным серийником — до фильтра «в строю». */
interface ПродажаБазы extends SaleRow {
  canonSerial: string;
}

/**
 * Справочник прогона: канон имён, прайс и парк. Читается ОДИН раз на отчёт.
 *
 * Два похода за теми же картами — это не только лишние запросы: между ними
 * владелец успевает переименовать товар или снять автомат со службы, и отчёт
 * посчитался бы наполовину по одному справочнику, наполовину по другому.
 */
interface Справочник {
  canonOf: (raw: string) => string;
  /** Строки прайса: закупочная цена и эталон витрины уже числами. */
  products: { name: string; purchasePrice: number | null; salePrice: number | null }[];
  /** Канон серийника → имя автомата, ТОЛЬКО в строю. */
  inService: Map<string, string>;
  /** Канон серийника → имя, для тех, кого фильтр выбросил (объяснить владельцу). */
  outOfService: Map<string, string>;
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);
  /** Готовый отчёт по ключу «отчёт|окно|сутки» — см. `REPORT_CACHE_MS`. */
  private readonly кеш = new Map<string, { at: number; отчёт: unknown }>();
  /** Считающийся прямо сейчас отчёт того же ключа (single-flight). */
  private readonly вПолёте = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly vending: VendingService,
  ) {}

  /**
   * Маржа по проданному за окно: автомат → товар и товар → парк (R-P5b-3).
   *
   * `now` — параметр, а не `Date.now()` внутри: прогон, пересекающий полночь
   * Ташкента, иначе считал бы первую половину по одному окну, а вторую по
   * другому, и тесты флакали бы ровно в этот момент.
   */
  async margin(days = MARGIN_DAYS_DEFAULT, now = new Date()): Promise<MarginResponse> {
    const окно = окноПоВчера(зажать(days, MARGIN_DAYS_DEFAULT, MARGIN_DAYS_MAX), now);
    return this.сКешем(`margin|${окно.days}|${tashkentDay(now)}`, now, () => this.маржа(окно, now));
  }

  /**
   * Мёртвый сток: что не двигалось за окно — склад и автоматы в строю (R-P5b-4).
   *
   * Настройка окна читается ДО кеша: окно входит в ключ, и без него запрос без
   * `?days=` попадал бы в один кеш с любым другим. Это один маленький select
   * на запрос — цена за то, что правка `DEAD_STOCK_DAYS` в панели действует
   * сразу, а не через пять минут.
   */
  async deadStock(days?: number, now = new Date()): Promise<DeadStockResponse> {
    const настройка = await readIntSetting(this.db, "DEAD_STOCK_DAYS", DEAD_STOCK_DAYS_FALLBACK, this.logger);
    const окно = зажать(days ?? настройка, DEAD_STOCK_DAYS_FALLBACK, DEAD_STOCK_DAYS_MAX);
    return this.сКешем(`dead-stock|${окно}|${tashkentDay(now)}`, now, () => this.мёртвыйСток(окно, now));
  }

  /** Две ленты изменений цен за окно плюс помесячная динамика для панели (R-P5b-5). */
  async priceChanges(days = PRICE_CHANGES_DAYS_DEFAULT, now = new Date()): Promise<PriceChangesResponse> {
    const окно = окноПоВчера(зажать(days, PRICE_CHANGES_DAYS_DEFAULT, PRICE_CHANGES_DAYS_MAX), now);
    return this.сКешем(`price-changes|${окно.days}|${tashkentDay(now)}`, now, () => this.цены(окно, now));
  }

  /** Факт витрины против эталона владельца: где недобираем (R-P5b-6). */
  async priceGap(days = PRICE_GAP_DAYS_DEFAULT, now = new Date()): Promise<PriceGapResponse> {
    const окно = окноПоВчера(зажать(days, PRICE_GAP_DAYS_DEFAULT, PRICE_GAP_DAYS_MAX), now);
    return this.сКешем(`price-gap|${окно.days}|${tashkentDay(now)}`, now, () => this.разрывВитрины(окно, now));
  }

  /**
   * Индекс себестоимости прогона (R-P5b-2). Публично: тем же индексом считает
   * недельная сводка, и её маржа обязана совпасть с маржой отчёта до сума.
   */
  async costIndex(now = new Date()): Promise<{ cost: CostIndex; source: "orders" | "price" }> {
    return this.костиндекс(await this.справочник(), now);
  }

  /**
   * Сбросить кеш отчётов. Зовётся оттуда, где данные заведомо поменялись:
   * правка эталона витрины и бутстрап меняют второй операнд `price-gap`, и
   * отдать после этого закешированный отчёт значило бы показать владельцу
   * разрыв, которого он только что не стало.
   */
  invalidate(): void {
    this.кеш.clear();
  }

  // ── Расчёты ────────────────────────────────────────────────────────────────

  private async маржа(окно: Окно, now: Date): Promise<MarginResponse> {
    const ctx = await this.справочник();
    const [продажи, lowPct, { cost }] = await Promise.all([
      this.продажиОкна(ctx, окно.from, окно.to),
      readIntSetting(this.db, "MARGIN_LOW_PCT", MARGIN_LOW_PCT_FALLBACK, this.logger),
      this.костиндекс(ctx, now),
    ]);

    // В `marginByMachine` едут ВСЕ строки окна, включая чужие серийники: она
    // сама делит их на парк и `excluded`. Отфильтровать здесь значило бы
    // потерять сумму, которой владельцу потом не объяснить расхождение с
    // кассой.
    const отчёт = marginByMachine(продажи, cost, { ...окно, inService: ctx.inService, lowPct });

    const warnings: AnalyticsWarning[] = [];
    if (продажи.length === 0) warnings.push(нетПродаж(окно));
    if (отчёт.unknownProducts.length > 0) {
      warnings.push({
        code: "unknown_cost",
        message: `Без закупочной цены: ${перечислить(отчёт.unknownProducts)} — их выручка в отчёте есть, затрат нет, маржа завышена на эту сумму.`,
      });
    }
    for (const x of отчёт.excluded) {
      const имя = ctx.outOfService.get(x.serial) ?? "нет карточки";
      warnings.push({
        code: "excluded_sales",
        message: `Продажи автомата ${x.serial} (${имя}) не в строю в маржу не вошли: ${x.qty} шт, ${x.amount} сум.`,
      });
    }
    return { ...отчёт, warnings };
  }

  private async мёртвыйСток(days: number, now: Date): Promise<DeadStockResponse> {
    const ctx = await this.справочник();
    // Окно мёртвого стока кончается СЕГОДНЯ, а не вчера: товар, проданный
    // сегодня утром, назвать мёртвым нельзя — а именно это и вышло бы, закройся
    // окно движения вчерашним днём.
    const since = tashkentDay(new Date(tashkentDayStartOf(now).getTime() - (days - 1) * DAY_MS));
    const сегодня = tashkentDay(now);
    const начало = tashkentDayStart(since) ?? new Date(tashkentDayStartOf(now).getTime() - (days - 1) * DAY_MS);

    const [склад, остатки, продажи, заливки, накладные, { cost }] = await Promise.all([
      this.db
        .select({ productName: vendingStock.productName, quantity: vendingStock.quantity })
        .from(vendingStock)
        .where(gt(vendingStock.quantity, 0)),
      // Остатки автоматов читаются ОКНОМ, а последний день выбирается в
      // памяти: строк тут десятки в сутки (SKU × 2 автомата), а коррелированный
      // подзапрос `max(dt)` — это ещё один кусок сырого SQL, который юнит-тест
      // не исполняет. Дороже отладка, чем полторы тысячи строк.
      this.db
        .select({ dt: machineStock.dt, machineSerial: machineStock.machineSerial, product: machineStock.product, qty: machineStock.qty })
        .from(machineStock)
        .where(gte(machineStock.dt, since)),
      this.продажиОкна(ctx, since, сегодня),
      this.db
        .select({ machineSerial: vendingRefillEvent.machineSerial, slots: vendingRefillEvent.slots })
        .from(vendingRefillEvent)
        .where(gte(vendingRefillEvent.windowTo, начало)),
      this.принятыеНакладные(начало),
      this.костиндекс(ctx, now),
    ]);

    // Движение: продажа, заливка по снимку, приход по накладной. Для склада
    // ключ глобальный (товар уехал со склада, где бы он потом ни продался), для
    // автомата — пара `serial|товар`: тот же товар бойко идёт в American
    // Hospital и месяцами стоит в Olma (R-P5b-4).
    const moved = new Set<string>();
    for (const p of продажи) {
      if (!ctx.inService.has(p.canonSerial)) continue; // «продажа» склада-заглушки движением не считается
      moved.add(normalizeProductName(p.product));
      moved.add(machineMovementKey(p.canonSerial, p.product));
    }
    for (const r of заливки) {
      for (const slot of r.slots ?? []) {
        if (!slot?.product) continue;
        moved.add(machineMovementKey(r.machineSerial, ctx.canonOf(slot.product)));
      }
    }
    for (const позиция of накладные) moved.add(normalizeProductName(ctx.canonOf(позиция.product)));

    const warehouse: StockPosition[] = склад.map((r) => ({ product: ctx.canonOf(r.productName), qty: Number(r.quantity) }));

    // Последний день КАЖДОГО автомата: у машин разный лаг сбора, и общий
    // «максимум по таблице» выкинул бы из отчёта автомат, чей снимок пришёл на
    // сутки позже.
    const последнийДень = new Map<string, string>();
    for (const r of остатки) {
      const canon = normalizeMachineSerial(r.machineSerial);
      const был = последнийДень.get(canon);
      if (!был || r.dt > был) последнийДень.set(canon, r.dt);
    }
    const inMachines: StockPosition[] = [];
    const сОстатком = new Set<string>();
    for (const r of остатки) {
      const canon = normalizeMachineSerial(r.machineSerial);
      const имя = ctx.inService.get(canon);
      if (имя === undefined || r.dt !== последнийДень.get(canon)) continue;
      сОстатком.add(canon);
      const qty = Number(r.qty);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      inMachines.push({ product: ctx.canonOf(r.product), qty, serial: canon, machineName: имя });
    }

    const отчёт = deadStock(warehouse, inMachines, moved, cost, days, since);

    const warnings: AnalyticsWarning[] = [];
    if (продажи.length === 0) {
      warnings.push({
        code: "no_sales",
        message: `Продаж с ${since} нет — движение определять не по чему, и весь остаток выглядит мёртвым. Сначала проверь синк продаж.`,
      });
    }
    // Про остаток молчим только там, где о нём нечего сказать: автомат,
    // который в окне торговал, обязан иметь снимок остатка. Автомат без продаж
    // и без остатка — это кофейный парк, которого отчёт не касается (R-P5b-9).
    const торговали = new Set(продажи.filter((p) => ctx.inService.has(p.canonSerial)).map((p) => p.canonSerial));
    const безОстатка = [...торговали].filter((s) => !сОстатком.has(s)).map((s) => `${ctx.inService.get(s) ?? s} (${s})`);
    if (безОстатка.length > 0) {
      warnings.push({
        code: "stock_missing",
        message: `Остатка на последний день окна нет: ${перечислить(безОстатка)} — эти автоматы в отчёт не вошли, хотя торговали.`,
      });
    }
    if (отчёт.noPriceCount > 0) {
      warnings.push({
        code: "unknown_cost",
        message: `Без закупочной цены ${отчёт.noPriceCount} позиц. — они в отчёте есть, но в сумму ${отчёт.totalValue} сум не входят.`,
      });
    }
    return { ...отчёт, warnings };
  }

  private async цены(окно: Окно, now: Date): Promise<PriceChangesResponse> {
    const ctx = await this.справочник();
    const начало = tashkentDayStart(окно.from) ?? new Date(tashkentDayStartOf(now).getTime() - окно.days * DAY_MS);
    const [продажи, события, pct] = await Promise.all([
      this.продажиОкна(ctx, окно.from, окно.to),
      // У ленты событий верхней границы НЕТ намеренно, хотя витринная кончается
      // вчера: цена, изменённая сегодня утром, — это ровно та новость, за
      // которой владелец и открывает отчёт. Витрина сегодняшний день включить
      // не может (`sale.dt` закрывается ночью), и делать ленты одинаково
      // слепыми ради симметрии значило бы прятать свежее изменение на сутки.
      this.db
        .select({ type: event.type, payload: event.payload, occurredAt: event.occurredAt })
        .from(event)
        .where(and(inArray(event.type, [...PRICE_EVENT_TYPES]), gte(event.occurredAt, начало))),
      readIntSetting(this.db, "PRICE_CHANGE_PCT", PRICE_CHANGE_PCT_FALLBACK, this.logger),
    ]);

    const витрина = продажи.filter((p) => ctx.inService.has(p.canonSerial));
    const наблюдения: PurchasePriceEvent[] = [];
    for (const e of события) {
      const p = (e.payload ?? {}) as { product?: unknown; oldPrice?: unknown; newPrice?: unknown; price?: unknown };
      const имя = typeof p.product === "string" ? p.product.trim() : "";
      // `vending.price_changed` несёт `newPrice`, наблюдение приёмки — `price`.
      // Ноль и мусор — это «цены нет», а не «отдали даром»: нулевая точка в
      // ленте выглядела бы обвалом на 100 %.
      const новая = цена(p.newPrice) ?? цена(p.price);
      if (!имя || новая === null) continue;
      наблюдения.push({ product: ctx.canonOf(имя), oldPrice: цена(p.oldPrice), newPrice: новая, at: tashkentDay(e.occurredAt) });
    }

    const отчёт = priceChanges(наблюдения, retailDaily(витрина), pct, окно.days);
    const warnings: AnalyticsWarning[] = [];
    if (витрина.length === 0) warnings.push(нетПродаж(окно));
    return { ...отчёт, monthly: помесячно(витрина, наблюдения), warnings };
  }

  private async разрывВитрины(окно: Окно, _now: Date): Promise<PriceGapResponse> {
    const ctx = await this.справочник();
    const [продажи, pct] = await Promise.all([
      this.продажиОкна(ctx, окно.from, окно.to),
      readIntSetting(this.db, "PRICE_GAP_PCT", PRICE_GAP_PCT_FALLBACK, this.logger),
    ]);

    // Факт витрины считает `priceGap` из тех же строк продаж (Σamount/Σqty):
    // своей агрегации здесь нет и быть не должно — она уже есть в общем
    // пакете, а вторая копия разошлась бы с первой на округлении.
    const факт = продажи.filter((p) => ctx.inService.has(p.canonSerial));
    const эталон = new Map<string, number>();
    for (const p of ctx.products) if (p.salePrice !== null) эталон.set(p.name, p.salePrice);

    const отчёт = priceGap(факт, эталон, pct, окно.days);
    const warnings: AnalyticsWarning[] = [];
    if (факт.length === 0) warnings.push(нетПродаж(окно));
    if (отчёт.noReference.length > 0) {
      warnings.push({
        code: "no_reference",
        message: `Эталон витрины не задан: ${перечислить(отчёт.noReference)} — сравнивать не с чем, задай «цена продажи <товар> <сум>».`,
      });
    }
    return { ...отчёт, warnings };
  }

  // ── Общие выборки ──────────────────────────────────────────────────────────

  private async справочник(): Promise<Справочник> {
    const [index, registry] = await Promise.all([this.vending.loadProductIndex(), this.vending.machineRegistry()]);
    const inService = new Map<string, string>();
    const outOfService = new Map<string, string>();
    for (const [serial, name] of registry.nameBySerial) {
      const снят = registry.notInService.get(serial);
      if (снят) outOfService.set(serial, `${снят.name}, ${снят.status}`);
      else inService.set(serial, name);
    }
    return {
      canonOf: (raw: string) => this.vending.resolveProduct(raw, index.aliasByKey),
      products: index.productRows.map((p) => ({
        name: p.name,
        purchasePrice: p.purchasePrice === null ? null : Number(p.purchasePrice),
        salePrice: p.salePrice === null ? null : Number(p.salePrice),
      })),
      inService,
      outOfService,
    };
  }

  /** Продажи окна с каноном имени и серийника. Единственный источник денег (R-P5b-1). */
  private async продажиОкна(ctx: Справочник, from: string, to: string): Promise<ПродажаБазы[]> {
    const rows = await this.db
      .select({ dt: sale.dt, machineSerial: sale.machineSerial, product: sale.product, qty: sale.qty, amount: sale.amount })
      .from(sale)
      .where(and(gte(sale.dt, from), lte(sale.dt, to)));
    return rows.map((r) => ({
      dt: r.dt,
      serial: r.machineSerial,
      canonSerial: normalizeMachineSerial(r.machineSerial),
      product: ctx.canonOf(r.product),
      qty: Number(r.qty),
      amount: Number(r.amount),
    }));
  }

  /** Позиции накладных, ПРИНЯТЫХ в окне: `{product, qty, price}` уже проверенные. */
  private async принятыеНакладные(since: Date): Promise<{ product: string; qty: number; price: number | null }[]> {
    const rows = await this.db
      .select({ positions: vendingPurchaseOrder.positions })
      .from(vendingPurchaseOrder)
      .where(and(eq(vendingPurchaseOrder.status, "received"), gte(vendingPurchaseOrder.receivedAt, since)));

    const out: { product: string; qty: number; price: number | null }[] = [];
    for (const r of rows) {
      const positions = Array.isArray(r.positions) ? r.positions : [];
      for (const p of positions) {
        const pos = (p ?? {}) as { product?: unknown; order?: unknown; price?: unknown };
        const product = typeof pos.product === "string" ? pos.product.trim() : "";
        // `order` — сколько заказали (та же колонка, по которой приёмка
        // зачисляет склад). `positions` лежит в jsonb без валидации, поэтому
        // проверяем так же строго, как это делает `receiveOrder`.
        const qty = typeof pos.order === "number" && Number.isFinite(pos.order) ? Math.trunc(pos.order) : 0;
        if (!product || qty <= 0) continue;
        out.push({ product, qty, price: цена(pos.price) });
      }
    }
    return out;
  }

  /**
   * Себестоимость единицы по канону имени (R-P5b-2): (1) взвешенная по
   * принятым накладным окна, (2) иначе цена карточки, (3) иначе «цены нет».
   *
   * `source` показывает владельцу, откуда взялась цифра. Сегодня это всегда
   * `price`: накладных на проде ноль, и молча выдавать цену карточки за
   * «взвешенную по закупкам» значит обещать историю, которой нет.
   */
  private async костиндекс(ctx: Справочник, now: Date): Promise<{ cost: CostIndex; source: "orders" | "price" }> {
    const дни = Math.max(1, Math.trunc(await readIntSetting(this.db, "COST_WINDOW_DAYS", COST_WINDOW_DAYS_FALLBACK, this.logger)));
    const since = new Date(tashkentDayStartOf(now).getTime() - (дни - 1) * DAY_MS);
    const позиции = await this.принятыеНакладные(since);

    const лоты = new Map<string, { price: number; qty: number }[]>();
    for (const p of позиции) {
      if (p.price === null) continue; // позиция без цены себестоимость не двигает
      const ключ = normalizeProductName(ctx.canonOf(p.product));
      const набор = лоты.get(ключ);
      if (набор) набор.push({ price: p.price, qty: p.qty });
      else лоты.set(ключ, [{ price: p.price, qty: p.qty }]);
    }

    // Ключи ТОЛЬКО канонические: `CostIndex` в общем пакете спрашивает цену
    // нормализованным ключом, и сырое написание молча уехало бы в
    // `unknownUnits`, тихо подняв маржу.
    const поКлючу = new Map<string, number>();
    for (const [ключ, набор] of лоты) {
      const взвешенная = weightedCost(набор);
      if (взвешенная !== null) поКлючу.set(ключ, взвешенная);
    }
    const source = поКлючу.size > 0 ? "orders" : "price";
    for (const p of ctx.products) {
      const ключ = normalizeProductName(p.name);
      if (p.purchasePrice !== null && p.purchasePrice > 0 && !поКлючу.has(ключ)) поКлючу.set(ключ, p.purchasePrice);
    }

    return { cost: (product: string) => поКлючу.get(normalizeProductName(ctx.canonOf(product))) ?? null, source };
  }

  /**
   * Кеш и ОДИН расчёт на ключ.
   *
   * Роуты открыты на чтение, а расчёт тяжёлый (продажи окна в память плюс
   * остатки и события), поэтому готовый отчёт живёт `REPORT_CACHE_MS`, а
   * параллельные запросы одного ключа ждут ОДИН расчёт, а не запускают по
   * своему. Ключ — отчёт, окно И ташкентские сутки: после полуночи окно
   * сдвигается, и вчерашний отчёт под тем же `days` был бы уже не тем отчётом.
   */
  private async сКешем<T>(ключ: string, now: Date, расчёт: () => Promise<T>): Promise<T> {
    const готовое = this.кеш.get(ключ);
    if (готовое && now.getTime() - готовое.at < REPORT_CACHE_MS) return готовое.отчёт as T;

    const считается = this.вПолёте.get(ключ);
    if (считается) return считается as Promise<T>;

    const работа = расчёт();
    this.вПолёте.set(ключ, работа);
    try {
      const отчёт = await работа;
      this.кеш.set(ключ, { at: now.getTime(), отчёт });
      return отчёт;
    } finally {
      this.вПолёте.delete(ключ);
    }
  }
}

interface Окно {
  days: number;
  from: string;
  to: string;
}

/** Окно `days` полных ташкентских суток, последние — ВЧЕРАШНИЕ. */
function окноПоВчера(days: number, now: Date): Окно {
  const сегодня = tashkentDayStartOf(now).getTime();
  return { days, from: tashkentDay(new Date(сегодня - days * DAY_MS)), to: tashkentDay(new Date(сегодня - DAY_MS)) };
}

function зажать(days: number, дефолт: number, потолок: number): number {
  const n = Math.trunc(days);
  if (!Number.isFinite(n) || n <= 0) return дефолт;
  return Math.min(n, потолок);
}

/** Цена из jsonb: `0`, дробь-мусор и заоблачное число — это «цены нет». */
function цена(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 10_000_000) return null;
  return v;
}

const нетПродаж = (окно: Окно): AnalyticsWarning => ({
  code: "no_sales",
  message: `Продаж за ${окно.days} дн. (${окно.from} … ${окно.to}) нет — считать нечего.`,
});

/** Имён в предупреждении — не больше пяти, остальное числом: строка на полсотни имён нечитаема. */
const МАКС_ИМЁН = 5;
function перечислить(имена: readonly string[]): string {
  if (имена.length <= МАКС_ИМЁН) return имена.join(", ");
  return `${имена.slice(0, МАКС_ИМЁН).join(", ")} и ещё ${имена.length - МАКС_ИМЁН}`;
}

/**
 * Помесячная динамика (донорский `price_dynamics`) — считается из ТЕХ ЖЕ строк,
 * что уже прочитаны для лент, без единого лишнего запроса. Панель зовёт
 * `/vending/price-changes` без флагов и ждёт `monthly` в ответе, поэтому поле
 * всегда на месте: пустой массив здесь значил бы «в окне не было цен», а не
 * «не просили посчитать».
 */
function помесячно(продажи: readonly SaleRow[], наблюдения: readonly PurchasePriceEvent[]): MonthlyPrice[] {
  interface Ячейка {
    product: string;
    month: string;
    qty: number;
    amount: number;
    закупСумма: number;
    закупШтук: number;
  }
  const acc = new Map<string, Ячейка>();
  const ячейка = (product: string, month: string): Ячейка => {
    const ключ = `${normalizeProductName(product)}|${month}`;
    const был = acc.get(ключ);
    if (был) return был;
    const новая: Ячейка = { product, month, qty: 0, amount: 0, закупСумма: 0, закупШтук: 0 };
    acc.set(ключ, новая);
    return новая;
  };

  for (const p of продажи) {
    if (!Number.isFinite(p.qty) || p.qty <= 0) continue;
    const c = ячейка(p.product, p.dt.slice(0, 7));
    c.qty += p.qty;
    c.amount += Number.isFinite(p.amount) ? p.amount : 0;
  }
  for (const e of наблюдения) {
    const c = ячейка(e.product, e.at.slice(0, 7));
    c.закупСумма += e.newPrice;
    c.закупШтук += 1;
  }

  return [...acc.values()]
    .map((c) => ({
      product: c.product,
      month: c.month,
      retail: c.qty > 0 ? Math.round(c.amount / c.qty) : null,
      purchase: c.закупШтук > 0 ? Math.round(c.закупСумма / c.закупШтук) : null,
    }))
    .sort((a, b) => (a.product < b.product ? -1 : a.product > b.product ? 1 : a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
}
