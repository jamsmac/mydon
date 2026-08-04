import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runCoffeeMonitor, type CoffeeMonitorCoreClient } from "./coffee-monitor";
import type { CoffeeFillStatusRow, CoffeeReconcileGroup } from "./core-client";

/** Стаб Core: отдаёт заданные fillStatus/reconcile, копит эмитированные события. */
function stubCore(
  fillStatus: CoffeeFillStatusRow[],
  reconcile: CoffeeReconcileGroup[],
  autoLink: { linked: number; ambiguous: string[]; unmatched: string[] } = { linked: 0, ambiguous: [], unmatched: [] },
) {
  const events: { source: string; type: string; payload?: Record<string, unknown> }[] = [];
  const reconcileCalls: { from: string; to: string }[] = [];
  const core: CoffeeMonitorCoreClient = {
    coffeeFillStatus: async () => fillStatus,
    coffeeReconcileAll: async (from, to) => {
      reconcileCalls.push({ from, to });
      return reconcile;
    },
    autoLinkCoffeeLocations: async () => autoLink,
    recordEvent: async (input) => {
      events.push(input);
      return { ok: true };
    },
  };
  return { core, events, reconcileCalls };
}

const fillRow = (over: Partial<CoffeeFillStatusRow> = {}): CoffeeFillStatusRow => ({
  locationId: "loc-1",
  locationName: "AH",
  position: 7,
  ingredientId: "ing-coffee",
  ingredientName: "Кофе",
  netFillWeight: 300,
  targetFillWeight: 600,
  status: "underfill",
  fillRatio: 0.5,
  ...over,
});

describe("monitor-coffee-bunkers: проактивный мониторинг (T0)", () => {
  it("недолив — эмитит coffee.underfill с нужным payload", async () => {
    const { core, events } = stubCore([fillRow()], []);
    const res = await runCoffeeMonitor(core);
    assert.equal(res.underfillEvents, 1);
    assert.equal(res.anomalyEvents, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "coffee.underfill");
    assert.equal(events[0].source, "coffee-monitor");
    assert.deepEqual(events[0].payload, {
      location: "AH",
      position: 7,
      ingredient: "Кофе",
      netFillWeight: 300,
      targetFillWeight: 600,
      fillRatio: 0.5,
    });
  });

  it("статус ok/unknown — событие не эмитится (не шумим по норме и по неизвестному)", async () => {
    const { core, events } = stubCore(
      [fillRow({ status: "ok" }), fillRow({ status: "unknown", fillRatio: null, netFillWeight: null, targetFillWeight: null })],
      [],
    );
    const res = await runCoffeeMonitor(core);
    assert.equal(res.underfillEvents, 0);
    assert.equal(events.length, 0);
  });

  it("расхождение расхода — эмитит coffee.anomaly, ok/unknown в группе пропускаются", async () => {
    const reconcile: CoffeeReconcileGroup[] = [
      {
        locationId: "loc-1",
        locationName: "AH",
        rows: [
          {
            ingredientId: "ing-coffee",
            ingredientName: "Кофе",
            actualGrams: 570,
            expectedGrams: 90,
            costActual: 45.6,
            costExpected: 7.2,
            reconcile: { status: "anomaly", deltaGrams: 480, deltaRatio: 5.33 },
          },
          {
            ingredientId: "ing-sugar",
            ingredientName: "Сахар",
            actualGrams: 100,
            expectedGrams: 95,
            costActual: null,
            costExpected: null,
            reconcile: { status: "ok", deltaGrams: 5, deltaRatio: 0.05 },
          },
        ],
      },
    ];
    const { core, events } = stubCore([], reconcile);
    const res = await runCoffeeMonitor(core);
    assert.equal(res.anomalyEvents, 1);
    const ev = events.find((e) => e.type === "coffee.anomaly")!;
    assert.deepEqual(ev.payload, {
      location: "AH",
      ingredient: "Кофе",
      actualGrams: 570,
      expectedGrams: 90,
      deltaRatio: 5.33,
    });
  });

  it("окно сверки — 3 суток назад от текущей даты (Asia/Tashkent)", async () => {
    const { core, reconcileCalls } = stubCore([], []);
    await runCoffeeMonitor(core, { now: () => new Date("2026-08-03T12:00:00Z") });
    assert.equal(reconcileCalls.length, 1);
    assert.equal(reconcileCalls[0].to, "2026-08-03");
    assert.equal(reconcileCalls[0].from, "2026-07-31");
  });

  it("сбой одного источника не должен скрывать сигналы другого", async () => {
    const events: unknown[] = [];
    const core: CoffeeMonitorCoreClient = {
      coffeeFillStatus: async () => [fillRow()],
      coffeeReconcileAll: async () => {
        throw new Error("Core недоступен");
      },
      autoLinkCoffeeLocations: async () => ({ linked: 0, ambiguous: [], unmatched: [] }),
      recordEvent: async (input) => {
        events.push(input);
        return { ok: true };
      },
    };
    const res = await runCoffeeMonitor(core);
    assert.equal(res.underfillEvents, 1, "недолив всё равно проверен и эмитирован");
    assert.equal(res.anomalyEvents, 0);
    assert.equal(res.errors.length, 1);
    assert.match(res.errors[0], /Core недоступен/);
    assert.equal(events.length, 1);
  });

  it("автопривязка: связала точки — событие coffee.autolink; нечего связывать — тишина", async () => {
    const linked = stubCore([], [], { linked: 2, ambiguous: ["AH"], unmatched: [] });
    const res = await runCoffeeMonitor(linked.core);
    assert.equal(res.autoLinked, 2);
    const ev = linked.events.find((e) => e.type === "coffee.autolink")!;
    assert.deepEqual(ev.payload, { linked: 2, ambiguous: ["AH"], unmatched: [] });

    const quiet = stubCore([], []);
    await runCoffeeMonitor(quiet.core);
    assert.equal(quiet.events.filter((e) => e.type === "coffee.autolink").length, 0, "нулевая привязка не шумит");
  });
});
