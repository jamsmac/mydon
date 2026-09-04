import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { and, eq, gt, gte, inArray, lte, notInArray } from "drizzle-orm";
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
  type AnalyticsWarning,
  type CostIndex,
  type DeadStockReport,
  type MarginReport,
  type MonthlyPrice,
  type PriceChangesReport,
  type PriceGapReport,
  type PurchasePriceEvent,
  type SaleRow,
  type StockPosition,
} from "@mydon/shared";
import { DB, type Db } from "../db/db.module";
import { VendingLedgerService } from "../stock/vending-ledger";
import { readIntSetting } from "../system/settings";
import { ReportCache, clamp, listInline } from "./report-cache";
import {
  notInServiceSerialForms,
  parseOrderPositions,
  SALE_PRICE_FACT_DAYS,
  VendingService,
  type InServicePark,
  type OrderPosition,
} from "./vending.service";

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
 *    Ни один отчёт этого модуля их не читает, и тест это стережёт.
 *
 * 2. Автоматы — «в строю ОТ ДАННЫХ» (`VendingService.inServicePark`): мимо
 *    отчёта идёт только тот, про кого карточка прямо говорит `status ≠
 *    in_service`. На проде склады SKLAD 4S/5S/6S отдают слоты-заглушки (7 960
 *    «единиц», 45 млн сум остатка), а один раз SKLAD 4S ещё и «продал» 1 шт
 *    Moxito на 12 000 сум. Автомат без карточки при этом остаётся в деньгах:
 *    «карточку не завели» — не то же самое, что «снят со службы».
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
/**
 * Окно разрыва витрины — ТО ЖЕ, что у гейта команды «цена продажи»
 * (`SALE_PRICE_FACT_DAYS`), и своей константы здесь нет намеренно: разъедься
 * они на сутки, владелец получал бы «цена принята» от бота и строку разрыва в
 * отчёте про то же самое число (R-P5b-6).
 */
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
 * Откуда взялась себестоимость КОНКРЕТНОГО товара (R-P5b-2): взвешенная по
 * принятым накладным окна, цена карточки прайса или «цены нет».
 *
 * Признак товарный, а не общий на отчёт: одна принятая накладная переключила бы
 * общий признак в «по накладным» для всех 52 товаров, из которых 51 остался бы
 * на цене карточки. Поле заведено ровно ради этого вопроса — и соврало бы
 * ровно в тот момент, когда на него впервые посмотрят.
 */
export type CostSource = "orders" | "price" | "unknown";

export interface CostIndexResult {
  cost: CostIndex;
  sourceOf: (product: string) => CostSource;
}

export type MarginResponse = MarginReport & { warnings: AnalyticsWarning[] };
export type DeadStockResponse = DeadStockReport & { warnings: AnalyticsWarning[] };
export type PriceChangesResponse = PriceChangesReport & { monthly: MonthlyPrice[]; warnings: AnalyticsWarning[] };
export type PriceGapResponse = PriceGapReport & { warnings: AnalyticsWarning[] };

/** Строка продаж окна вместе с каноном серийника — до фильтра «в строю». */
interface ПродажаБазы extends SaleRow {
  canonSerial: string;
}

/** Продажи окна и парк, собранный ПО НИМ (см. `inServicePark`). */
interface ПродажиОкна {
  строки: ПродажаБазы[];
  парк: InServicePark;
}

/**
 * Справочник прогона: канон имён, прайс и реестр автоматов. Читается ОДИН раз
 * на отчёт.
 *
 * Два похода за теми же картами — это не только лишние запросы: между ними
 * владелец успевает переименовать товар или снять автомат со службы, и отчёт
 * посчитался бы наполовину по одному справочнику, наполовину по другому.
 */
interface Справочник {
  canonOf: (raw: string) => string;
  /** Строки прайса: закупочная цена, эталон витрины и «в продаже ли» уже разобраны. */
  products: { name: string; purchasePrice: number | null; salePrice: number | null; isActive: boolean }[];
  registry: { notInService: Map<string, { name: string; status: string }>; nameBySerial: Map<string, string> };
  /** Сырые формы серийников не в строю — ими выборка сужается прямо в SQL. */
  notInServiceForms: string[];
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);
  private readonly кеш = new ReportCache();
  /** Кеши смежных отчётов: гаснут вместе с этим (см. `attachCache`). */
  private readonly смежные: ReportCache[] = [];

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly vending: VendingService,
    /** Проекция `vending_stock` → леджер (У6). В тестах отсутствует — читаем таблицу. */
    @Optional() @Inject(VendingLedgerService) private readonly ledger?: VendingLedgerService,
  ) {}

  /**
   * Маржа по проданному за окно: автомат → товар и товар → парк (R-P5b-3).
   *
   * `now` — параметр, а не `Date.now()` внутри: прогон, пересекающий полночь
   * Ташкента, иначе считал бы первую половину по одному окну, а вторую по
   * другому, и тесты флакали бы ровно в этот момент.
   */
  async margin(days = MARGIN_DAYS_DEFAULT, now = new Date()): Promise<MarginResponse> {
    const окно = окноПоВчера(clamp(days, MARGIN_DAYS_DEFAULT, MARGIN_DAYS_MAX), now);
    return this.кеш.get(`margin|${окно.days}|${tashkentDay(now)}`, () => this.маржа(окно, now));
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
    const окно = clamp(days ?? настройка, DEAD_STOCK_DAYS_FALLBACK, DEAD_STOCK_DAYS_MAX);
    return this.кеш.get(`dead-stock|${окно}|${tashkentDay(now)}`, () => this.мёртвыйСток(окно, now));
  }

  /** Две ленты изменений цен за окно плюс помесячная динамика для панели (R-P5b-5). */
  async priceChanges(days = PRICE_CHANGES_DAYS_DEFAULT, now = new Date()): Promise<PriceChangesResponse> {
    const окно = окноПоВчера(clamp(days, PRICE_CHANGES_DAYS_DEFAULT, PRICE_CHANGES_DAYS_MAX), now);
    return this.кеш.get(`price-changes|${окно.days}|${tashkentDay(now)}`, () => this.цены(окно, now));
  }

  /** Факт витрины против эталона владельца: где недобираем (R-P5b-6). */
  async priceGap(days = SALE_PRICE_FACT_DAYS, now = new Date()): Promise<PriceGapResponse> {
    const окно = окноПоВчера(clamp(days, SALE_PRICE_FACT_DAYS, PRICE_GAP_DAYS_MAX), now);
    return this.кеш.get(`price-gap|${окно.days}|${tashkentDay(now)}`, () => this.разрывВитрины(окно));
  }

  /**
   * Индекс себестоимости прогона (R-P5b-2). Публично: тем же индексом считает
   * недельная сводка, и её маржа обязана совпасть с маржой отчёта до сума.
   */
  async costIndex(now = new Date()): Promise<CostIndexResult> {
    return this.костиндекс(await this.справочник(), now);
  }

  /**
   * Присоединить кеш СМЕЖНОГО отчёта — того, что считает те же числа.
   *
   * Зовёт `WeeklyDigestService` из своего конструктора: у сводки собственный
   * `ReportCache`, а маржа в ней та же самая. Без этой связки правка цены
   * гасила бы `/vending/margin`, но не `/vending/weekly-digest`, и пять минут
   * два ответа Core на один вопрос расходились бы — нарушение R-P5b-10 ровно
   * в тот момент, когда владелец проверяет собственную правку.
   *
   * Явная регистрация, а не глобальный реестр кешей: список того, что гаснет
   * вместе, должен быть виден в коде, а не собираться побочным эффектом
   * конструктора неизвестно чего.
   */
  attachCache(кеш: ReportCache): void {
    this.смежные.push(кеш);
  }

  /**
   * Сбросить кеш ВСЕХ отчётов. Зовётся оттуда, где данные заведомо поменялись:
   * правка эталона витрины и бутстрап меняют второй операнд `price-gap`,
   * правка закупочной цены и приёмка накладной — себестоимость всей маржи и
   * оценку мёртвого стока, а правка порогов из панели «Система» —
   * `MARGIN_LOW_PCT`, `PRICE_CHANGE_PCT`, `PRICE_GAP_PCT`, `COST_WINDOW_DAYS`,
   * которые читаются ВНУТРИ кешируемого расчёта и в ключ не входят. Отдать
   * после этого закешированный отчёт значило бы показать владельцу картину,
   * которую он только что своими руками изменил.
   *
   * ОДНА ФУНКЦИЯ НА ВСЕ ОТЧЁТЫ. Пока сброс знал только про свой кеш,
   * недельная сводка жила своей жизнью — см. `attachCache`.
   */
  invalidateReports(): void {
    this.кеш.clear();
    for (const смежный of this.смежные) смежный.clear();
  }

  // ── Расчёты ────────────────────────────────────────────────────────────────

  private async маржа(окно: Окно, now: Date): Promise<MarginResponse> {
    const ctx = await this.справочник();
    const [{ строки, парк }, lowPct, { cost }] = await Promise.all([
      // Строки НЕ в строю остаются: `marginByMachine` сама делит их на парк и
      // `excluded`. Отсечь их в SQL значило бы потерять сумму, которой
      // владельцу потом не объяснить расхождение с кассой.
      this.продажиОкна(ctx, окно.from, окно.to),
      readIntSetting(this.db, "MARGIN_LOW_PCT", MARGIN_LOW_PCT_FALLBACK, this.logger),
      this.костиндекс(ctx, now),
    ]);

    const отчёт = marginByMachine(строки, cost, { ...окно, inService: парк.inService, lowPct });

    const warnings: AnalyticsWarning[] = [];
    if (строки.length === 0) warnings.push(нетПродаж(окно));
    if (отчёт.unknownProducts.length > 0) {
      warnings.push({
        code: "unknown_cost",
        message: `Без закупочной цены: ${listInline(отчёт.unknownProducts)} — их выручка в отчёте есть, затрат нет, маржа завышена на эту сумму.`,
      });
    }
    for (const x of отчёт.excluded) {
      const снят = парк.notInService.get(x.serial);
      const имя = снят ? `${снят.name}, ${снят.status}` : "нет карточки";
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
    const сегодня = tashkentDayStartOf(now).getTime();
    const since = tashkentDay(new Date(сегодня - (days - 1) * DAY_MS));
    const начало = tashkentDayStart(since) ?? new Date(сегодня - (days - 1) * DAY_MS);

    // Склад — одной дверью в режиме ledger (R-GS-1); таблица — в table, как раньше.
    let склад: { productName: string; quantity: number }[];
    let неизвестно = 0;
    if (this.ledger && (await this.ledger.source()) === "ledger") {
      const g = await this.ledger.goodsStock(this.db);
      склад = g.rows.flatMap((r) => (r.quantity !== null && r.quantity > 0 ? [{ productName: r.productName, quantity: r.quantity }] : []));
      неизвестно = g.rows.filter((r) => r.quantity === null).length;
    } else {
      склад = await this.db
        .select({ productName: vendingStock.productName, quantity: vendingStock.quantity })
        .from(vendingStock)
        .where(gt(vendingStock.quantity, 0));
    }
    const [остатки, продажи, заливки, накладные, { cost }] = await Promise.all([
      // Остатки автоматов читаются ОКНОМ, а последний день выбирается в
      // памяти: строк тут десятки в сутки (SKU × 2 автомата), а коррелированный
      // подзапрос `max(dt)` — это ещё один кусок сырого SQL, который юнит-тест
      // не исполняет. Дороже отладка, чем полторы тысячи строк.
      this.db
        .select({ dt: machineStock.dt, machineSerial: machineStock.machineSerial, product: machineStock.product, qty: machineStock.qty })
        .from(machineStock)
        .where(gte(machineStock.dt, since)),
      this.продажиОкна(ctx, since, tashkentDay(now), true),
      this.db
        .select({ machineSerial: vendingRefillEvent.machineSerial, slots: vendingRefillEvent.slots })
        .from(vendingRefillEvent)
        .where(gte(vendingRefillEvent.windowTo, начало)),
      this.принятыеНакладные(начало),
      this.костиндекс(ctx, now),
    ]);

    // ДВИЖЕНИЕ У ПОЛОВИН РАЗНОЕ, И ЭТО ГЛАВНОЕ РЕШЕНИЕ ОТЧЁТА (R-P5b-4).
    //
    // Склад: движение — всё, что снимает остаток или пополняет его осмысленно:
    // продажа, ЗАЛИВКА (товар физически уехал со склада в автомат) и приёмка
    // накладной. Ключ глобальный: где товар потом продастся, складу неважно.
    //
    // Автомат: движение — ТОЛЬКО ПРОДАЖА. Заливка про автомат не говорит
    // ничего, кроме того, что мы сами туда привезли, — а «доливаем то, что не
    // берут» и есть самый дорогой случай мёртвого стока. Прод показал цену
    // ошибки: `Kinder Bueno` в American Hospital, 11 шт, последняя продажа
    // 28.07, слот залит 14.08 — позиция на 121 000 сум (39 % всего мёртвого
    // стока) исчезала из отчёта ровно потому, что её долили.
    // Ключ автомата — пара `serial|товар`: тот же товар бойко идёт в American
    // Hospital и месяцами стоит в Olma.
    const moved = new Set<string>();
    for (const p of продажи.строки) {
      moved.add(normalizeProductName(p.product));
      moved.add(machineMovementKey(p.canonSerial, p.product));
    }
    for (const r of заливки) {
      for (const slot of r.slots ?? []) {
        if (!slot?.product) continue;
        moved.add(normalizeProductName(ctx.canonOf(slot.product)));
      }
    }
    for (const позиция of накладные) moved.add(normalizeProductName(ctx.canonOf(позиция.product)));

    const warehouse: StockPosition[] = склад.map((r) => ({ product: ctx.canonOf(r.productName), qty: Number(r.quantity) }));

    // Парк остатков — от серийников САМИХ ОСТАТКОВ: автомат без карточки
    // остаётся в отчёте (см. `inServicePark`), склад-заглушка уходит.
    const паркОстатков = this.vending.inServicePark(
      остатки.map((r) => r.machineSerial),
      ctx.registry,
    );
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
      const имя = паркОстатков.inService.get(canon);
      if (имя === undefined || r.dt !== последнийДень.get(canon)) continue;
      сОстатком.add(canon);
      const qty = Number(r.qty);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      inMachines.push({ product: ctx.canonOf(r.product), qty, serial: canon, machineName: имя });
    }

    const отчёт = deadStock(warehouse, inMachines, moved, cost, days, since);

    const warnings: AnalyticsWarning[] = [];
    if (продажи.строки.length === 0) {
      warnings.push({
        code: "no_sales",
        message: `Продаж с ${since} нет — движение определять не по чему, и весь остаток выглядит мёртвым. Сначала проверь синк продаж.`,
      });
    }
    // Про остаток молчим только там, где о нём нечего сказать: автомат,
    // который в окне торговал, обязан иметь снимок остатка. Автомат без продаж
    // и без остатка — это кофейный парк, которого отчёт не касается (R-P5b-9).
    const торговали = new Set(продажи.строки.map((p) => p.canonSerial));
    const безОстатка = [...торговали]
      .filter((s) => !сОстатком.has(s))
      .map((s) => `${продажи.парк.inService.get(s) ?? s} (${s})`);
    if (безОстатка.length > 0) {
      warnings.push({
        code: "stock_missing",
        message: `Остатка на последний день окна нет: ${listInline(безОстатка)} — эти автоматы в отчёт не вошли, хотя торговали.`,
      });
    }
    if (отчёт.noPriceCount > 0) {
      warnings.push({
        code: "unknown_cost",
        message: `Без закупочной цены ${отчёт.noPriceCount} позиц. — они в отчёте есть, но в сумму ${отчёт.totalValue} сум не входят.`,
      });
    }
    if (неизвестно > 0) {
      warnings.push({ code: "stock_unknown_card", message: `Без карточки склада: ${неизвестно} поз. — в отчёте по складу их нет` });
    }
    return { ...отчёт, warnings };
  }

  private async цены(окно: Окно, now: Date): Promise<PriceChangesResponse> {
    const ctx = await this.справочник();
    const начало = tashkentDayStart(окно.from) ?? new Date(tashkentDayStartOf(now).getTime() - окно.days * DAY_MS);
    const [продажи, события, pct] = await Promise.all([
      this.продажиОкна(ctx, окно.from, окно.to, true),
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

    const отчёт = priceChanges(наблюдения, retailDaily(продажи.строки), pct, окно.days);
    const warnings: AnalyticsWarning[] = [];
    if (продажи.строки.length === 0) warnings.push(нетПродаж(окно));
    return { ...отчёт, monthly: помесячно(продажи.строки, наблюдения, окно), warnings };
  }

  private async разрывВитрины(окно: Окно): Promise<PriceGapResponse> {
    const ctx = await this.справочник();
    const [продажи, pct] = await Promise.all([
      this.продажиОкна(ctx, окно.from, окно.to, true),
      readIntSetting(this.db, "PRICE_GAP_PCT", PRICE_GAP_PCT_FALLBACK, this.logger),
    ]);

    // Факт витрины считает `priceGap` из тех же строк продаж — той же функцией
    // `retailFactByProduct`, которой считает гейт команды «цена продажи».
    // Своей агрегации Σamount/Σqty здесь нет и быть не должно (R-P5b-10).
    const эталон = new Map<string, number>();
    const снятые = new Set<string>();
    for (const p of ctx.products) {
      if (p.salePrice !== null) эталон.set(p.name, p.salePrice);
      if (!p.isActive) снятые.add(normalizeProductName(p.name));
    }

    const отчёт = priceGap(продажи.строки, эталон, pct, окно.days);
    // Снятый с продажи товар в списке «эталон не задан» — шум: эталон нужен
    // тому, что продаётся дальше. Товар, которого в прайсе НЕТ вовсе, в списке
    // остаётся: он продавался, а карточки у него нет — это уже другая проблема,
    // и прятать её нельзя.
    const noReference = отчёт.noReference.filter((имя) => !снятые.has(normalizeProductName(имя)));

    const warnings: AnalyticsWarning[] = [];
    if (продажи.строки.length === 0) warnings.push(нетПродаж(окно));
    if (noReference.length > 0) {
      warnings.push({
        code: "no_reference",
        message: `Эталон витрины не задан: ${listInline(noReference)} — сравнивать не с чем, задай «цена продажи <товар> <сум>».`,
      });
    }
    return { ...отчёт, noReference, warnings };
  }

  // ── Общие выборки ──────────────────────────────────────────────────────────

  private async справочник(): Promise<Справочник> {
    const [index, registry] = await Promise.all([this.vending.loadProductIndex(), this.vending.machineRegistry()]);
    return {
      canonOf: (raw: string) => this.vending.resolveProduct(raw, index.catalog),
      products: index.productRows.map((p) => ({
        name: p.name,
        purchasePrice: p.purchasePrice === null ? null : Number(p.purchasePrice),
        salePrice: p.salePrice === null ? null : Number(p.salePrice),
        isActive: p.isActive,
      })),
      registry,
      notInServiceForms: notInServiceSerialForms(registry.notInService.keys()),
    };
  }

  /**
   * Продажи окна с каноном имени и серийника плюс парк, собранный ПО ЭТИМ
   * СТРОКАМ. Единственный источник денег (R-P5b-1).
   *
   * `толькоВСтрою` сужает выборку прямо в SQL — списком тех, КОГО ИСКЛЮЧИТЬ.
   * Положительный список («оставить эти серийники») пришлось бы собирать из
   * реестра, и автомат без карточки молча выпал бы из отчёта. Решает всё равно
   * `парк.ok`: SQL не знает про регистр и формы написания, он лишь снимает с
   * чтения заведомо лишние строки склада-заглушки.
   */
  private async продажиОкна(ctx: Справочник, from: string, to: string, толькоВСтрою = false): Promise<ПродажиОкна> {
    const окно = and(gte(sale.dt, from), lte(sale.dt, to));
    const rows = await this.db
      .select({ dt: sale.dt, machineSerial: sale.machineSerial, product: sale.product, qty: sale.qty, amount: sale.amount })
      .from(sale)
      .where(
        толькоВСтрою && ctx.notInServiceForms.length > 0
          ? and(окно, notInArray(sale.machineSerial, ctx.notInServiceForms))
          : окно,
      );

    const парк = this.vending.inServicePark(
      rows.map((r) => r.machineSerial),
      ctx.registry,
    );
    const строки = rows.map((r) => ({
      dt: r.dt,
      serial: r.machineSerial,
      canonSerial: normalizeMachineSerial(r.machineSerial),
      product: ctx.canonOf(r.product),
      qty: Number(r.qty),
      amount: Number(r.amount),
    }));

    return { строки: толькоВСтрою ? строки.filter((r) => парк.ok(r.serial)) : строки, парк };
  }

  /**
   * Позиции накладных, ПРИНЯТЫХ в окне.
   *
   * Разбор — общий `parseOrderPositions`, а не свой: гейт цены у копий уже
   * разъезжался с недельной сводкой (R-P5b-10).
   */
  private async принятыеНакладные(since: Date): Promise<OrderPosition[]> {
    const rows = await this.db
      .select({ positions: vendingPurchaseOrder.positions })
      .from(vendingPurchaseOrder)
      .where(and(eq(vendingPurchaseOrder.status, "received"), gte(vendingPurchaseOrder.receivedAt, since)));

    return rows.flatMap((r) => parseOrderPositions(r.positions));
  }

  /**
   * Себестоимость единицы по канону имени (R-P5b-2): (1) взвешенная по
   * принятым накладным окна, (2) иначе цена карточки, (3) иначе «цены нет».
   *
   * `sourceOf` отвечает про КОНКРЕТНЫЙ товар — см. `CostSource`. Сегодня на
   * проде накладных ноль, и все 52 товара стоят на цене карточки; первая же
   * принятая накладная переведёт на взвешенную цену ровно свои позиции.
   */
  private async костиндекс(ctx: Справочник, now: Date): Promise<CostIndexResult> {
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
    const поКлючу = new Map<string, { price: number; source: CostSource }>();
    for (const [ключ, набор] of лоты) {
      // Взвешивание нескольких лотов — работа `weightedCost`: две поставки по
      // 10 и 100 штук дают не среднее двух цен, а среднее по штукам.
      const взвешенная = weightedCost(набор);
      if (взвешенная !== null) поКлючу.set(ключ, { price: взвешенная, source: "orders" });
    }
    for (const p of ctx.products) {
      const ключ = normalizeProductName(p.name);
      if (p.purchasePrice !== null && p.purchasePrice > 0 && !поКлючу.has(ключ)) {
        поКлючу.set(ключ, { price: p.purchasePrice, source: "price" });
      }
    }

    const найти = (product: string) => поКлючу.get(normalizeProductName(ctx.canonOf(product)));
    return {
      cost: (product: string) => найти(product)?.price ?? null,
      sourceOf: (product: string) => найти(product)?.source ?? "unknown",
    };
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

/** Цена из jsonb: `0`, дробь-мусор и заоблачное число — это «цены нет». */
function цена(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 10_000_000) return null;
  return v;
}

const нетПродаж = (окно: Окно): AnalyticsWarning => ({
  code: "no_sales",
  message: `Продаж за ${окно.days} дн. (${окно.from} … ${окно.to}) нет — считать нечего.`,
});

/** Последний календарный день месяца `YYYY-MM`. */
function конецМесяца(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/**
 * Помесячная динамика (донорский `price_dynamics`) — считается из ТЕХ ЖЕ строк,
 * что уже прочитаны для лент, без единого лишнего запроса. Панель зовёт
 * `/vending/price-changes` без флагов и ждёт `monthly` в ответе, поэтому поле
 * всегда на месте.
 *
 * В ответ идут ТОЛЬКО ПОЛНЫЕ месяцы окна. Месяц, из которого в окно попали
 * двадцать дней из тридцати одного, на графике выглядит как провал продаж, а
 * его средняя цена посчитана по другому объёму, чем у соседей: это не «данные
 * за месяц», а обрезок. При окне по умолчанию (30 суток) полных месяцев в нём
 * нет вовсе — и пустой `monthly` здесь честнее двух огрызков; панель, которой
 * нужна динамика, зовёт отчёт с окном пошире (`?days=180` — пять полных
 * месяцев).
 */
function помесячно(продажи: readonly SaleRow[], наблюдения: readonly PurchasePriceEvent[], окно: Окно): MonthlyPrice[] {
  interface Ячейка {
    product: string;
    month: string;
    qty: number;
    amount: number;
    закупСумма: number;
    закупШтук: number;
  }
  const полный = (month: string): boolean => `${month}-01` >= окно.from && конецМесяца(month) <= окно.to;

  const acc = new Map<string, Ячейка>();
  const ячейка = (product: string, month: string): Ячейка | null => {
    if (!полный(month)) return null;
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
    if (!c) continue;
    c.qty += p.qty;
    c.amount += Number.isFinite(p.amount) ? p.amount : 0;
  }
  for (const e of наблюдения) {
    const c = ячейка(e.product, e.at.slice(0, 7));
    if (!c) continue;
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
