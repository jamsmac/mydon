import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OurvendHealth, WeeklyDigest } from "./vending-reports";

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
  slotsLagMin: 42,
  salesLagH: 3,
  productSaleLagH: 5,
  parity: { days: 7, ok: true, mismatches: 0, stockOk: true, note: null },
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
};

describe("Общие формы ответов Core (R-P5b-10)", () => {
  it("здоровье сбора: ровно те поля, что читают бот и панель", () => {
    assert.deepEqual(Object.keys(ЗДОРОВЬЕ).sort(), [
      "failedStreak",
      "lastSuccessAt",
      "parity",
      "productSaleLagH",
      "runs",
      "salesLagH",
      "slotsLagMin",
    ]);
    assert.deepEqual(Object.keys(ЗДОРОВЬЕ.parity).sort(), ["days", "mismatches", "note", "ok", "stockOk"]);
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

  it("лаг допускает null: «снимков нет» — не «0 мин»", () => {
    const пусто: OurvendHealth = { ...ЗДОРОВЬЕ, slotsLagMin: null, salesLagH: null, productSaleLagH: null };
    assert.deepEqual([пусто.slotsLagMin, пусто.salesLagH, пусто.productSaleLagH], [null, null, null]);
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
      "week",
      "worstProducts",
    ]);
    assert.deepEqual(Object.keys(СВОДКА.refills).sort(), ["detectedUnits", "events", "recordedUnits"]);
    assert.deepEqual(Object.keys(СВОДКА.intake).sort(), ["amount", "orders", "units"]);
    assert.deepEqual(Object.keys(СВОДКА.stocktakes).sort(), ["lastCountedAt", "positions"]);
    assert.deepEqual(Object.keys(СВОДКА.machines[0]!).sort(), ["margin", "name", "pct", "qty", "revenue", "serial"]);
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
