import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEAD_MIN_SLOTS, deadMachine, detectRefills, matchRefill, shrinkageByDay, type MachineSnapshot, type SnapshotSlot } from "./vending-field";

const slot = (coilId: string, product: string | null, quantity: number, capacity = 5): SnapshotSlot => ({ coilId, product, quantity, capacity });
const at = (iso: string) => new Date(iso);

describe("Полевой контур: мёртвый автомат (R-P4-4)", () => {
  it("все слоты полны до 199 при ≥10 слотах — мёртв", () => {
    const slots = Array.from({ length: 12 }, (_, i) => slot(String(i + 1), "X", 199, 199));
    assert.equal(deadMachine(slots, 200), true);
  });
  it("живой автомат: хотя бы один слот не полон", () => {
    const slots = [...Array.from({ length: 11 }, (_, i) => slot(String(i + 1), "X", 5)), slot("12", "Y", 3)];
    assert.equal(deadMachine(slots), false);
  });
  it("меньше 10 слотов с товаром — не мёртв, даже если все полны", () => {
    assert.equal(deadMachine(Array.from({ length: DEAD_MIN_SLOTS - 1 }, (_, i) => slot(String(i), "X", 5))), false);
  });
});

describe("Полевой контур: детектор заливок по снимкам", () => {
  const snaps: MachineSnapshot[] = [
    { serial: "376", capturedAt: at("2026-08-18T07:00:00Z"), slots: [slot("1", "Montella", 1), slot("2", "Fanta", 0), slot("3", "TUC", 4)] },
    { serial: "376", capturedAt: at("2026-08-18T10:00:00Z"), slots: [slot("1", "Montella", 5), slot("2", "Fanta", 5), slot("3", "TUC", 3)] },
    { serial: "376", capturedAt: at("2026-08-18T13:00:00Z"), slots: [slot("1", "Montella", 4), slot("2", "Fanta", 5), slot("3", "TUC", 3)] },
  ];
  it("окно с Σ+ ≥ порога даёт событие; продажи (отрицательные дельты) не учитываются; следующее окно без прихода — нет", () => {
    const ev = detectRefills(snaps, 5);
    assert.equal(ev.length, 1);
    assert.equal(ev[0]!.units, 9);
    assert.deepEqual(ev[0]!.slots.map((s) => [s.coilId, s.delta]), [["1", 4], ["2", 5]]);
    assert.equal(ev[0]!.windowFrom.toISOString(), "2026-08-18T07:00:00.000Z");
    assert.equal(ev[0]!.windowTo.toISOString(), "2026-08-18T10:00:00.000Z");
  });
  it("ниже порога — событий нет", () => { assert.equal(detectRefills(snaps, 10).length, 0); });
  it("мёртвый автомат пропускается; разные автоматы не смешиваются", () => {
    const dead = Array.from({ length: 12 }, (_, i) => slot(String(i), "X", 199, 199));
    const mixed: MachineSnapshot[] = [
      { serial: "360", capturedAt: at("2026-08-18T07:00:00Z"), slots: dead },
      { serial: "360", capturedAt: at("2026-08-18T10:00:00Z"), slots: dead },
      ...snaps,
    ];
    assert.equal(detectRefills(mixed, 5, 200).map((e) => e.serial).join(), "376");
  });
  it("слот без товара или с capacity вне 0..MAX не участвует", () => {
    const s: MachineSnapshot[] = [
      { serial: "1", capturedAt: at("2026-08-18T07:00:00Z"), slots: [slot("1", null, 0), slot("2", "A", 0, 500)] },
      { serial: "1", capturedAt: at("2026-08-18T10:00:00Z"), slots: [slot("1", null, 9), slot("2", "A", 9, 500)] },
    ];
    assert.equal(detectRefills(s, 1).length, 0);
  });
});

describe("Полевой контур: сопоставление с записью оператора", () => {
  const ev = detectRefills([
    { serial: "376", capturedAt: at("2026-08-18T07:00:00Z"), slots: [slot("1", "A", 0)] },
    { serial: "376", capturedAt: at("2026-08-18T10:00:00Z"), slots: [slot("1", "A", 5)] },
  ], 1)[0]!;
  it("берёт ближайшую запись того же автомата в окне ±3ч", () => {
    const m = matchRefill(ev, [
      { id: "far", serial: "376", performedAt: at("2026-08-18T14:30:00Z"), qty: 5 },
      { id: "near", serial: "376", performedAt: at("2026-08-18T09:30:00Z"), qty: 5 },
      { id: "other", serial: "359", performedAt: at("2026-08-18T09:00:00Z"), qty: 5 },
    ]);
    assert.equal(m?.id, "near");
  });
  it("нет записи в окне → null", () => {
    assert.equal(matchRefill(ev, [{ id: "x", serial: "376", performedAt: at("2026-08-19T09:30:00Z"), qty: 5 }]), null);
  });
});

describe("Полевой контур: усушка по дням без заливок (R-P4-3)", () => {
  const prices = new Map([["Kinder", 11000], ["Qurt", 6800]]);
  it("день без заливки: expected = start − sales; недостача в штуках и сумах", () => {
    const s = shrinkageByDay([{
      date: "2026-08-19",
      startSlots: [slot("1", "Kinder", 10, 11), slot("2", "Qurt", 8, 11)],
      endSlots: [slot("1", "Kinder", 6, 11), slot("2", "Qurt", 8, 11)],
      sales: new Map([["Kinder", 2]]),
      refillUnits: 0,
    }], prices, 30000);
    const k = s.items.find((i) => i.product === "Kinder")!;
    assert.equal(k.lossUnits, 2);            // 10 − 2 = 8 ожидали, 6 факт
    assert.equal(k.lossValue, 22000);
    assert.equal(k.alert, false);
    assert.equal(s.daysCounted, 1);
    assert.equal(s.daysSkipped, 0);
  });
  it("день с заливкой пропускается целиком", () => {
    const s = shrinkageByDay([{ date: "2026-08-18", startSlots: [slot("1", "Kinder", 1, 11)], endSlots: [slot("1", "Kinder", 11, 11)], sales: new Map(), refillUnits: 96 }], prices, 30000);
    assert.equal(s.daysSkipped, 1);
    assert.equal(s.items.length, 0);
  });
  it("излишек показывается, но в деньги не входит; порог по позиции за период", () => {
    const day = (date: string, start: number, end: number) => ({ date, startSlots: [slot("1", "Kinder", start, 11)], endSlots: [slot("1", "Kinder", end, 11)], sales: new Map<string, number>(), refillUnits: 0 });
    const s = shrinkageByDay([day("2026-08-19", 10, 8), day("2026-08-20", 8, 9), day("2026-08-21", 9, 8)], prices, 30000);
    const k = s.items[0]!;
    assert.equal(k.lossUnits, 3);
    assert.equal(k.surplusUnits, 1);
    assert.equal(k.lossValue, 33000);
    assert.equal(k.alert, true);
    assert.equal(s.lossValue, 33000);
  });
  it("товар без цены — noPrice, деньги 0; товар не в обоих снимках — день по нему пропущен", () => {
    const s = shrinkageByDay([{ date: "2026-08-19", startSlots: [slot("1", "TUC", 5), slot("2", "Kinder", 3)], endSlots: [slot("1", "TUC", 3)], sales: new Map(), refillUnits: 0 }], prices, 30000);
    assert.deepEqual(s.items.map((i) => [i.product, i.lossUnits, i.noPrice]), [["TUC", 2, true]]);
  });
});
