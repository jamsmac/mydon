import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SALE_PRICE_FACT_DAYS } from "./vending-reports";
import type {
  BootstrapSalePriceResult,
  OurvendHealth,
  PurchasePlan,
  SetSalePriceResult,
  ShrinkReport,
  ShrinkWarningCode,
  StockCountRow,
  StockCountsReport,
  WeeklyDigest,
  WeeklyHealth,
} from "./vending-reports";

/**
 * Формы ответов Core, которые читают ТРОЕ (Core, бот, панель), — R-P5b-10.
 *
 * Типы сами по себе исполняемого кода не дают, и обычный тест их не проверит.
 * Проверяем то, что ломается на самом деле: НАБОР ПОЛЕЙ. Пока бот и панель
 * держат собственные зеркала этих интерфейсов (`apps/bot/src/core-client.ts`,
 * `apps/cc/src/lib/core.ts`), добавленное здесь поле обязано появиться и там —
 * а поле, переименованное здесь, ломает HTTP-контракт, а не рефакторит его.
 * Список ниже переписан ВРУЧНУЮ с зеркал; расхождение сразу видно глазом.
 */

const ЗДОРОВЬЕ: OurvendHealth = {
  runs: [
    {
      id: "r1",
      startedAt: "2026-08-23T03:05:00.000Z",
      finishedAt: "2026-08-23T03:07:00.000Z",
      status: "success",
      machinesTotal: 2,
      machinesOk: 2,
      durationMs: 120_000,
      error: null,
    },
  ],
  failedStreak: 0,
  lastSuccessAt: "2026-08-23T03:07:00.000Z",
  staleHours: 3.1,
  staleThresholdH: 6,
  slotsLagMin: 42,
  salesLagH: 3,
  snapshotStale: false,
  productSaleLagH: 5,
  parityStreak: 3,
  cutoverThreshold: 7,
  parity: { days: 7, ok: true, checked: 14, mismatches: 0, stockOk: true, stockChecked: 24, mode: "mirror", note: null },
};

/**
 * Здоровье сбора ЗА ОТЧЁТНУЮ НЕДЕЛЮ — числа недели, а не момента отправки.
 *
 * Стоит рядом с `ЗДОРОВЬЕ`, а не вместо него: в одном ответе едут ДВА набора
 * чисел об одном сборе, и подмена одного другим — это ровно тот дефект,
 * ради которого поле и заведено (R-H-9).
 */
const НЕДЕЛЬНОЕ_ЗДОРОВЬЕ: WeeklyHealth = {
  week: "2026-34",
  runs: 56,
  success: 54,
  partial: 1,
  failed: 1,
  worstFailedStreak: 1,
  lastSuccessAt: "2026-08-23T03:07:00.000Z",
  parityDays: [{ date: "2026-08-23", ok: true, salesChecked: 2, stockChecked: 68, note: null }],
  parityGreen: 1,
  parityRed: 0,
};

const СВОДКА: WeeklyDigest = {
  week: "2026-34",
  from: "2026-08-17",
  to: "2026-08-23",
  previousWeek: "2026-33",
  machines: [{ serial: "2508160376", name: "Olma Администрация", qty: 412, revenue: 1_487_000, margin: 421_310, pct: 28.3 }],
  totals: { qty: 412, revenue: 1_487_000, cogs: 1_065_690, margin: 421_310, pct: 28.3, unknownUnits: 0 },
  delta: { qty: -63, revenue: -441_000, margin: -171_000, qtyPct: -9.5, revenuePct: -17, marginPct: -22 },
  topProducts: [
    { product: "TUC Sour cream", qty: 96, revenue: 384_000, cogs: 268_800, margin: 115_200, pct: 30, unknownUnits: 0, low: false },
  ],
  worstProducts: [],
  refills: { events: 3, detectedUnits: 183, recordedUnits: 0 },
  intake: { orders: 2, units: 540, amount: 4_100_000 },
  stocktakes: { positions: 12, lastCountedAt: "2026-08-22T09:40:00.000Z" },
  deadStock: { rows: [{ product: "Fanta 0.5", qty: 24, value: 168_000, noPrice: false }], totalValue: 290_500 },
  priceChanges: {
    purchase: [{ product: "TUC Sour cream", from: 2_600, to: 2_800, pct: 7.7, at: "2026-08-18" }],
    retail: [{ product: "LaimonFresh", from: 15_000, to: 12_000, pct: -20, at: "2026-08-19" }],
  },
  health: ЗДОРОВЬЕ,
  weekHealth: НЕДЕЛЬНОЕ_ЗДОРОВЬЕ,
  warnings: [],
};

describe("Общие формы ответов Core (R-P5b-10)", () => {
  it("здоровье сбора: ровно те поля, что читают бот и панель", () => {
    assert.deepEqual(Object.keys(ЗДОРОВЬЕ).sort(), [
      "cutoverThreshold",
      "failedStreak",
      "lastSuccessAt",
      "parity",
      "parityStreak",
      "productSaleLagH",
      "runs",
      "salesLagH",
      "slotsLagMin",
      "snapshotStale",
      "staleHours",
      "staleThresholdH",
    ]);
    assert.deepEqual(Object.keys(ЗДОРОВЬЕ.parity).sort(), [
      "checked",
      "days",
      "mismatches",
      // С ЧЕМ сверялись (R-FW-P3): без режима витрина не отличает «сошлось с
      // независимой стороной» от «сверять было не с чем» (`retired`).
      "mode",
      "note",
      "ok",
      "stockChecked",
      "stockOk",
    ]);
    assert.deepEqual(Object.keys(ЗДОРОВЬЕ.runs[0]!).sort(), [
      "durationMs",
      "error",
      "finishedAt",
      "id",
      "machinesOk",
      "machinesTotal",
      "startedAt",
      "status",
    ]);
  });

  it("гейт катовера едет числами: серия И порог, а не флаг «готово» (R-P8b-2)", () => {
    // Витрины рисуют «N зелёных дней из 7» и «✅ можно переключать» сравнением
    // ДВУХ полей ответа. Флаг вместо чисел не отвечает на вопрос «сколько ещё
    // ждать», а своя семёрка у каждого читателя разошлась бы с базой в тот же
    // день, когда владелец подвинет `CUTOVER_GREEN_DAYS` в панели «Система».
    assert.equal(typeof ЗДОРОВЬЕ.parityStreak, "number");
    assert.equal(typeof ЗДОРОВЬЕ.cutoverThreshold, "number");
    const непосчиталось: OurvendHealth = { ...ЗДОРОВЬЕ, parityStreak: 0 };
    assert.equal(непосчиталось.parityStreak < непосчиталось.cutoverThreshold, true, "ноль — не «готовы»");
  });

  it("лаг допускает null: «снимков нет» — не «0 мин»", () => {
    const пусто: OurvendHealth = { ...ЗДОРОВЬЕ, slotsLagMin: null, salesLagH: null, productSaleLagH: null };
    assert.deepEqual([пусто.slotsLagMin, пусто.salesLagH, пусто.productSaleLagH], [null, null, null]);
  });

  it("порог застоя едет в ответе рядом с давностью — витрине не нужна своя копия (R-P8a-6)", () => {
    // Бот и панель рисуют «⛔ сбор стоит» по сравнению ДВУХ полей ответа. Своя
    // константа порога у каждого читателя разошлась бы с базой в тот же день,
    // когда владелец подвинет `SYNC_STALE_HOURS` в панели настроек.
    assert.equal(typeof ЗДОРОВЬЕ.staleThresholdH, "number");
    const никогда: OurvendHealth = { ...ЗДОРОВЬЕ, lastSuccessAt: null, staleHours: null };
    assert.equal(никогда.staleHours, null, "«успехов не было вовсе» — не «ноль часов»");
  });

  it("застой учётного снапшота едет ГОТОВЫМ вердиктом, а не лагом с порогом (R-P8b-5)", () => {
    // Витрине пришлось бы сравнивать три вещи, а не две: лаг, порог и РЕЖИМ
    // учёта. В режиме `stock` снапшот теневой — тот же лаг там не значит
    // ничего, и «⛔ учёт стоит» по лагу с порогом рисовалось бы на ровном
    // месте. Поэтому здесь булево, а не второй `staleThresholdH`.
    assert.equal(typeof ЗДОРОВЬЕ.snapshotStale, "boolean");
    const встал: OurvendHealth = { ...ЗДОРОВЬЕ, salesLagH: 37, snapshotStale: true };
    assert.equal(встал.snapshotStale, true);
    // «Не посчиталось» — не «встал»: пустое здоровье обязано давать false.
    const непосчиталось: OurvendHealth = { ...ЗДОРОВЬЕ, salesLagH: null, snapshotStale: false };
    assert.equal(непосчиталось.snapshotStale, false);
  });

  it("недельная сводка: ровно те поля, что читают бот и панель", () => {
    assert.deepEqual(Object.keys(СВОДКА).sort(), [
      "deadStock",
      "delta",
      "from",
      "health",
      "intake",
      "machines",
      "previousWeek",
      "priceChanges",
      "refills",
      "stocktakes",
      "to",
      "topProducts",
      "totals",
      "warnings",
      "week",
      // Здоровье недели — ОТДЕЛЬНОЕ поле рядом с `health`: письмо несёт два
      // набора чисел об одном сборе, «сейчас» и «за отчётную неделю» (R-H-9).
      "weekHealth",
      "worstProducts",
    ]);
    assert.deepEqual(Object.keys(СВОДКА.refills).sort(), ["detectedUnits", "events", "recordedUnits"]);
    assert.deepEqual(Object.keys(СВОДКА.intake).sort(), ["amount", "orders", "units"]);
    assert.deepEqual(Object.keys(СВОДКА.stocktakes).sort(), ["lastCountedAt", "positions"]);
    assert.deepEqual(Object.keys(СВОДКА.machines[0]!).sort(), ["margin", "name", "pct", "qty", "revenue", "serial"]);
  });

  it("паритет без единой сверенной пары говорит это числом, а не «расхождений 0»", () => {
    const пусто: OurvendHealth = {
      ...ЗДОРОВЬЕ,
      parity: {
        days: 7,
        ok: false,
        checked: 14,
        mismatches: 0,
        stockOk: false,
        stockChecked: 0,
        mode: "mirror",
        note: "снимков остатков нет",
      },
    };
    // Ровно боевой случай 25.08: продажи сошлись 14 парами, а остатки сверять
    // было не по чему — и это ДВА разных числа, а не одно «❌ расхождений 0».
    assert.equal(пусто.parity.mismatches, 0);
    assert.equal(пусто.parity.checked, 14);
    assert.equal(пусто.parity.stockChecked, 0);
    assert.notEqual(пусто.parity.note, null);
  });

  it("здоровье недели: ровно те поля, что читает бот (R-H-9)", () => {
    assert.deepEqual(Object.keys(НЕДЕЛЬНОЕ_ЗДОРОВЬЕ).sort(), [
      "failed",
      "lastSuccessAt",
      "parityDays",
      "parityGreen",
      "parityRed",
      "partial",
      "runs",
      "success",
      "week",
      "worstFailedStreak",
    ]);
    // Подпись письма и подпись чисел обязаны совпадать: блок, подписанный
    // неделей, но посчитанный моментом отправки, — это и есть дефект O7.
    assert.equal(СВОДКА.weekHealth.week, СВОДКА.week);
  });

  it("«сейчас» и «за неделю» — ДВА набора чисел в одном ответе, а не один", () => {
    // `failedStreak` отвечает «падает ли прямо сейчас», `worstFailedStreak` —
    // «была ли на неделе дыра». Подсунуть недельное число под старым именем
    // значило бы соврать под подписью, которую читают бот и панель.
    const авария: WeeklyDigest = {
      ...СВОДКА,
      health: { ...ЗДОРОВЬЕ, failedStreak: 2 },
      weekHealth: { ...НЕДЕЛЬНОЕ_ЗДОРОВЬЕ, failed: 0, worstFailedStreak: 0 },
    };
    assert.equal(авария.health.failedStreak, 2);
    assert.equal(авария.weekHealth.worstFailedStreak, 0);
  });

  it("успехов в неделе не было ВОВСЕ — `null`, а не ноль часов", () => {
    const безУспеха: WeeklyHealth = { ...НЕДЕЛЬНОЕ_ЗДОРОВЬЕ, success: 0, failed: 1, lastSuccessAt: null };
    assert.equal(безУспеха.lastSuccessAt, null);
    // Прогон был — просто неуспешный: это НЕ «сбор не запускался».
    assert.equal(безУспеха.runs > 0, true);
  });

  it("сводка несёт `warnings`: секция, которая не посчиталась, не исчезает молча", () => {
    const деградировала: WeeklyDigest = {
      ...СВОДКА,
      warnings: [{ code: "health_unavailable", message: "здоровье сбора не посчиталось" }],
    };
    assert.equal(деградировала.warnings[0]!.code, "health_unavailable");
  });

  it("окно факта витрины — одно число на Core, бота и панель", () => {
    assert.equal(SALE_PRICE_FACT_DAYS, 14);
  });

  it("причины отказа и пропуска названы литералами, а не свободным текстом", () => {
    const отказ: SetSalePriceResult = { ok: false, reason: "invalid_price", message: "эталон витрины — положительное число сум" };
    assert.equal(отказ.reason, "invalid_price");
    const бутстрап: BootstrapSalePriceResult = {
      days: SALE_PRICE_FACT_DAYS,
      set: [],
      skipped: [
        { product: "TUC", reason: "already_set" },
        { product: "Barni", reason: "no_sales" },
        { product: "Oreo", reason: "no_fact" },
        { product: "Velona", reason: "inactive" },
      ],
    };
    assert.deepEqual(бутстрап.skipped.map((s) => s.reason).sort(), ["already_set", "inactive", "no_fact", "no_sales"]);
  });

  it("история склада: пометка и первые сутки окна едут в ответе (R-H-2)", () => {
    const строка: StockCountRow = {
      dt: "2026-08-25",
      product: "Sprite 250ml",
      qty: 19,
      source: "stock-import",
      countedAt: "2026-08-25T04:00:00.000Z",
      note: "2 Холодильник",
    };
    const отчёт: StockCountsReport = { days: 90, since: "2026-05-28", product: null, rows: [строка], warnings: [] };
    assert.deepEqual(Object.keys(строка).sort(), ["countedAt", "dt", "note", "product", "qty", "source"]);
    assert.deepEqual(Object.keys(отчёт).sort(), ["days", "product", "rows", "since", "warnings"]);
    // `null` — законная пометка («её нет»), а не пропуск поля: выдумывать
    // «Основной склад» вместо неё нельзя.
    const безПометки: StockCountRow = { ...строка, source: "own", note: null };
    assert.equal(безПометки.note, null);
  });

  it("пустая неделя выражается типом: процент null, а не ноль", () => {
    const пустая: WeeklyDigest = {
      ...СВОДКА,
      machines: [],
      totals: { qty: 0, revenue: 0, cogs: 0, margin: 0, pct: null, unknownUnits: 0 },
      topProducts: [],
      worstProducts: [],
    };
    assert.equal(пустая.totals.pct, null);
    assert.equal(пустая.machines.length, 0);
  });
});

/**
 * Формы усушки и плана закупа: те же три читателя, тот же приём (R-H-6).
 *
 * До этого набора формы жили ТРЕМЯ копиями — в `shrinkage.service.ts`/
 * `vending.service.ts` (Core), в `core-client.ts` (бот) и в `lib/core.ts`
 * (панель). Копии уже разъехались: союз кодов усушки панель переписала в
 * другом порядке, а `summary` автомата — инлайном. Структурная типизация это
 * терпит, поэтому переименование поля в Core не ломало ни бот, ни панель — оно
 * ломало строку в чате у владельца.
 */
describe("Формы усушки и плана закупа объявлены ОДИН раз (R-H-6)", () => {
  it("ShrinkReport: ровно те поля, что читают Core, бот и панель", () => {
    const отчёт: ShrinkReport = {
      from: "2026-08-11",
      to: "2026-08-24",
      threshold: 30_000,
      machines: [
        {
          serial: "2508160376",
          name: "Olma",
          summary: {
            items: [{ product: "Kinder Bueno", lossUnits: 9, lossValue: 99_000, surplusUnits: 0, daysCounted: 9, noPrice: false, alert: true }],
            lossValue: 99_000,
            daysCounted: 9,
            daysSkipped: 5,
            threshold: 30_000,
          },
          refillDays: [{ date: "2026-08-19", detectedUnits: 183, recordedUnits: 0 }],
        },
      ],
      warnings: [{ code: "no_counted_days", message: "все дни были заливкой" }],
    };
    assert.deepEqual(Object.keys(отчёт).sort(), ["from", "machines", "threshold", "to", "warnings"]);
    assert.deepEqual(Object.keys(отчёт.machines[0]!).sort(), ["name", "refillDays", "serial", "summary"]);
    assert.deepEqual(Object.keys(отчёт.machines[0]!.summary).sort(), ["daysCounted", "daysSkipped", "items", "lossValue", "threshold"]);
  });

  it("союз кодов усушки объявлен один раз — все шесть, и ни одного лишнего", () => {
    // Панель держала свою копию союза в ДРУГОМ порядке (`core.ts`), Core — в
    // своём. Структурная типизация порядок не ловит, а вот пропавший член —
    // ловит: лишний литерал ниже не компилируется.
    const все: ShrinkWarningCode[] = [
      "snapshots_stale", "no_sales_day", "machine_dead",
      "no_counted_days", "sales_unknown_product", "machine_error",
    ];
    assert.equal(new Set(все).size, 6);
    // @ts-expect-error — кода `machine_sleeping` в союзе нет и заводить его
    // можно только в shared, а не седьмой копией в панели.
    const лишний: ShrinkWarningCode = "machine_sleeping";
    assert.equal(лишний, "machine_sleeping");
  });

  it("PurchasePlan: ровно те поля, что читают Core, бот и панель", () => {
    const план: PurchasePlan = {
      generatedAt: "2026-08-25T09:00:00.000Z",
      stock: { asOf: "2026-08-22T09:40:00.000Z", totalBefore: 120, use: 40, back: 12, totalAfter: 92, stale: false, unmatched: 0 },
      summary: {
        items: [], excludedNoSales: [], excludedByRule: [], noPrice: [],
        allocation: "purchase-first",
        totalNeed: 0, totalCovered: 0, totalBuy: 0, totalOrder: 0,
        costExact: 0, costRounded: 0, overpay: 0, shortfallCost: 0, costByPriceFull: 0,
        totalFromPurchase: 0, totalFromStock: 0, totalUnfilled: 0, totalToStock: 0,
      },
      machines: [],
      routeConfigured: true,
      warnings: [{ code: "sales_partial", message: "автомата нет в свежем батче продаж" }],
    };
    assert.deepEqual(Object.keys(план).sort(), ["generatedAt", "machines", "routeConfigured", "stock", "summary", "warnings"]);
    assert.deepEqual(Object.keys(план.stock).sort(), ["asOf", "back", "stale", "totalAfter", "totalBefore", "unmatched", "use"]);
  });
});
