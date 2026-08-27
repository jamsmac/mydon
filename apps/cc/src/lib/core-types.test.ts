import { describe, expect, it } from "vitest";
import type {
  AnalyticsWarning as SharedWarning,
  MonthlyPrice as SharedMonthly,
  OurvendHealth as SharedHealth,
  OurvendSyncRun as SharedRun,
  PurchasePlan as SharedPlan,
  ProductFiscal as SharedProductFiscal,
  ShrinkReport as SharedShrink,
  StockCountRow as SharedStockCountRow,
  StockCountsReport as SharedStockCounts,
} from "@mydon/shared";
import type {
  AnalyticsWarning,
  MonthlyPrice,
  OurvendHealth,
  OurvendSyncRun,
  StockCountRow,
  StockCountsReport,
  VendingProductRow,
  VendingPlan,
  VendingShrinkageReport,
  VendingSyncRun,
} from "./core";

/**
 * Компиляторная сверка зеркал (N4 финального ревью П5b).
 *
 * Тест набора полей в `@mydon/shared` (`vending-reports-contracts.test.ts`)
 * сверяет shared сам с собой: списки полей там переписаны руками, и
 * переименование поля в панели он не увидит НИКОГДА. Поймать расхождение может
 * только компилятор — поэтому здесь фикстуры объявлены ОБЩИМ типом и
 * присвоены типу панели: заведись в `lib/core.ts` своя копия с другим полем,
 * этот файл перестанет собираться, а не молча разъедется в проде.
 *
 * Тип панели сегодня — реэкспорт (`export type { … } from "@mydon/shared"`), и
 * присвоение тривиально по построению. Это и есть проверяемое утверждение:
 * сверка ломается ровно тогда, когда реэкспорт заменят объявлением.
 */
const прогонОбщий: SharedRun = {
  id: "run-1",
  startedAt: "2026-08-25T06:00:00.000Z",
  finishedAt: "2026-08-25T06:00:11.000Z",
  status: "success",
  machinesTotal: 2,
  machinesOk: 2,
  durationMs: 11_000,
  error: null,
};

const здоровьеОбщее: SharedHealth = {
  runs: [прогонОбщий],
  failedStreak: 0,
  lastSuccessAt: "2026-08-25T06:00:11.000Z",
  staleHours: 0,
  staleThresholdH: 6,
  slotsLagMin: 12,
  salesLagH: 13,
  snapshotStale: false,
  productSaleLagH: 0.2,
  parityStreak: 3,
  cutoverThreshold: 7,
  parityLastRed: "2026-08-25",
  parityStreakSince: "2026-08-26",
  parity: { days: 7, ok: false, mismatches: 0, stockOk: false, checked: 0, stockChecked: 0, mode: "mirror", note: "остатки: снимков остатков OurVend за период нет" },
};

const месяцОбщий: SharedMonthly = { product: "Kinder Bueno", month: "2026-07", retail: 11_000, purchase: 7_700 };
const предупреждениеОбщее: SharedWarning = { code: "no_reference", message: "У 32 товаров эталон не задан" };

const усушкаОбщая: SharedShrink = {
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

const планОбщий: SharedPlan = {
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

/**
 * История склада («Хвосты», R-H-2). `note` тут — ВСЯ пометка импорта целиком,
 * как её пишет `importNote`: фикстура сторожа обязана быть тем, что производит
 * код, иначе сторож охраняет выдуманную форму.
 */
const строкаИсторииОбщая: SharedStockCountRow = {
  id: "00000000-0000-4000-8000-000000000001",
  dt: "2026-06-01",
  product: "Snickers",
  qty: 41,
  source: "stock-import",
  countedAt: "2026-06-01T02:00:00.000Z",
  note: "импорт истории mydon-stock · место: Холодильник",
};

const историяОбщая: SharedStockCounts = {
  days: 90,
  since: "2026-05-28",
  product: null,
  rows: [строкаИсторииОбщая],
  warnings: [],
};

describe("Типы панели — реэкспорт из @mydon/shared, а не копии", () => {
  it("`VendingProductRow` панели несёт тот же `ProductFiscal`, что и shared", () => {
    const блокОбщий: SharedProductFiscal = {
      ikpu: "02202003001086002",
      mxik: null,
      vatPct: 12,
      barcode: null,
      packageCode: "796",
      marked: false,
    };
    const строка: VendingProductRow = {
      id: "p1",
      name: "Snickers 50gr",
      category: "snack",
      purchasePrice: 7000,
      salePrice: 15000,
      packSize: 10,
      isActive: true,
      excludedFromPurchase: false,
      fixedPurchaseQty: 48,
      fiscal: блокОбщий,
    };
    expect(строка.fiscal.packageCode).toBe("796");
  });

  it("здоровье сбора и прогон принимаются типом панели без переписывания полей", () => {
    const здоровье: OurvendHealth = здоровьеОбщее;
    const прогон: OurvendSyncRun = прогонОбщий;
    // `/vending/sync` и `/ourvend/health` показывают ОДНУ строку `vending_sync_run`.
    const прогонПанели: VendingSyncRun = прогонОбщий;
    expect(Object.keys(здоровье).sort()).toEqual([
      "cutoverThreshold",
      "failedStreak",
      "lastSuccessAt",
      "parity",
      "parityLastRed",
      "parityStreak",
      "parityStreakSince",
      "productSaleLagH",
      "runs",
      "salesLagH",
      "slotsLagMin",
      "snapshotStale",
      "staleHours",
      "staleThresholdH",
    ]);
    expect(прогонПанели).toBe(прогон);
  });

  it("паритет несёт режим сверки: витрина отличает «сравнивать не с чем» от «сошлось»", () => {
    // `mode` (R-FW-P3) — единственное, что отличает три разных «расхождений 0»:
    // сверку с зеркалом, сверку с донором после флипа и погашенное зеркало.
    // Потеряйся он в зеркале типов панели — секция здоровья снова рисовала бы
    // «остатки: снимков за период нет» там, где сверять нечего по замыслу.
    expect(Object.keys(здоровьеОбщее.parity).sort()).toEqual([
      "checked",
      "days",
      "mismatches",
      "mode",
      "note",
      "ok",
      "stockChecked",
      "stockOk",
    ]);
  });

  it("помесячная цена и предупреждение — те же формы, что у ядра", () => {
    const месяц: MonthlyPrice = месяцОбщий;
    const предупреждение: AnalyticsWarning = предупреждениеОбщее;
    expect(Object.keys(месяц).sort()).toEqual(["month", "product", "purchase", "retail"]);
    expect(Object.keys(предупреждение).sort()).toEqual(["code", "message"]);
  });
});

describe("Усушка и план закупа — реэкспорт, а не копии (R-H-6)", () => {
  it("форма усушки у панели и у ядра — одна и та же, сторож двусторонний", () => {
    // Панель звала усушку `VendingShrinkageReport`, Core — `ShrinkReport`, и
    // союз кодов панель переписала в другом порядке. Переименование поля в
    // Core компилятор не ловил: он видел две независимые структуры.
    //
    // Присваивание в ОБЕ стороны — проверка ТОЖДЕСТВА форм. Одностороннее
    // («общая → панельная») ловит переименование и лишнее обязательное поле в
    // копии, но копия, у которой поля НЕ ХВАТАЕТ, приняла бы общее значение
    // молча: это обычная структурная совместимость. А «недоописанная копия» —
    // ровно тот способ разъехаться, который тут и случился с закупом.
    const общая: SharedShrink = усушкаОбщая;
    const панельная: VendingShrinkageReport = общая;
    const обратно: SharedShrink = панельная;
    expect(панельная).toBe(общая);
    expect(обратно).toBe(общая);
  });

  it("план закупа у панели и у ядра — одно, сторож двусторонний", () => {
    const общий: SharedPlan = планОбщий;
    const панельный: VendingPlan = общий;
    const обратно: SharedPlan = панельный;
    expect(панельный).toBe(общий);
    expect(обратно).toBe(общий);
  });

  it("история склада: `note` и `since` доезжают до типа панели, а не теряются в зеркале", () => {
    // Оба поля добавлены аддитивно (R-H-2), и оба читает ТОЛЬКО панель. Заведись
    // в `lib/core.ts` своё объявление без `note`, ни один тест набора полей в
    // shared этого не увидел бы — увидит компилятор на этих двух строках.
    const строка: StockCountRow = строкаИсторииОбщая;
    const отчёт: StockCountsReport = историяОбщая;
    expect(Object.keys(строка).sort()).toEqual(["countedAt", "dt", "id", "note", "product", "qty", "source"]);
    expect(Object.keys(отчёт).sort()).toEqual(["days", "product", "rows", "since", "warnings"]);
  });
});
