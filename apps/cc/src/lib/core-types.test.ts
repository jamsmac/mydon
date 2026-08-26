import { describe, expect, it } from "vitest";
import type {
  AnalyticsWarning as SharedWarning,
  MonthlyPrice as SharedMonthly,
  OurvendHealth as SharedHealth,
  OurvendSyncRun as SharedRun,
} from "@mydon/shared";
import type { AnalyticsWarning, MonthlyPrice, OurvendHealth, OurvendSyncRun, VendingSyncRun } from "./core";

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
  parity: { days: 7, ok: false, mismatches: 0, stockOk: false, checked: 0, stockChecked: 0, note: "остатки: снимков остатков OurVend за период нет" },
};

const месяцОбщий: SharedMonthly = { product: "Kinder Bueno", month: "2026-07", retail: 11_000, purchase: 7_700 };
const предупреждениеОбщее: SharedWarning = { code: "no_reference", message: "У 32 товаров эталон не задан" };

describe("Типы панели — реэкспорт из @mydon/shared, а не копии", () => {
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
      "parityStreak",
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

  it("помесячная цена и предупреждение — те же формы, что у ядра", () => {
    const месяц: MonthlyPrice = месяцОбщий;
    const предупреждение: AnalyticsWarning = предупреждениеОбщее;
    expect(Object.keys(месяц).sort()).toEqual(["month", "product", "purchase", "retail"]);
    expect(Object.keys(предупреждение).sort()).toEqual(["code", "message"]);
  });
});
