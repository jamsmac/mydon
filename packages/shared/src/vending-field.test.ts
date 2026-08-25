import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEAD_MIN_SLOTS, deadMachine, detectRefills, matchRefill, shrinkageByDay, type MachineSnapshot, type SnapshotSlot } from "./vending-field";

const slot = (coilId: string, product: string | null, quantity: number, capacity = 5): SnapshotSlot => ({ coilId, product, quantity, capacity });
const at = (iso: string) => new Date(iso);

describe("Полевой контур: мёртвый автомат (R-P4-4)", () => {
  it("заглушка источника: 199=199 по всем слотам — ни одна ёмкость не в диапазоне, мёртв", () => {
    const slots = Array.from({ length: 12 }, (_, i) => slot(String(i + 1), "X", 199, 199));
    assert.equal(deadMachine(slots), true);
  });
  it("полный ЖИВОЙ автомат мёртвым не считается", () => {
    // Только что заправленный автомат на 43 пружины стоит 5/5 по всем слотам.
    // Прежнее правило «все валидные слоты полны» выбрасывало его из плана и
    // продаж на несколько часов — ровно тот дефект, ради которого правило
    // переписано.
    const slots = Array.from({ length: 43 }, (_, i) => slot(String(i + 1), "X", 5, 5));
    assert.equal(deadMachine(slots), false);
  });
  it("часть ёмкостей в диапазоне — не заглушка, а сбитая калибровка", () => {
    const slots = [
      ...Array.from({ length: 11 }, (_, i) => slot(String(i + 1), "X", 199, 199)),
      slot("12", "Y", 3, 5),
    ];
    assert.equal(deadMachine(slots), false);
  });
  it("меньше 10 слотов с товаром — не мёртв, даже если ёмкости мусорные", () => {
    assert.equal(
      deadMachine(Array.from({ length: DEAD_MIN_SLOTS - 1 }, (_, i) => slot(String(i), "X", 199, 199))),
      false,
    );
  });
  it("пустой автомат (слотов с товаром нет) — не мёртв: судить не о чем", () => {
    assert.equal(deadMachine(Array.from({ length: 12 }, (_, i) => slot(String(i), null, 0, 0))), false);
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
    // Заглушка отдаёт 199=199, и между «снимками» число даже растёт — без
    // фильтра это выглядело бы заливкой на 588 единиц.
    const dead = (q: number) => Array.from({ length: 12 }, (_, i) => slot(String(i), "X", q, 199));
    const mixed: MachineSnapshot[] = [
      { serial: "360", capturedAt: at("2026-08-18T07:00:00Z"), slots: dead(150) },
      { serial: "360", capturedAt: at("2026-08-18T10:00:00Z"), slots: dead(199) },
      ...snaps,
    ];
    assert.equal(detectRefills(mixed, 5).map((e) => e.serial).join(), "376");
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
  it("излишек за период показывается, но в деньги не входит; порог по позиции за период", () => {
    const day = (date: string, start: number, end: number) => ({ date, startSlots: [slot("1", "Kinder", start, 11)], endSlots: [slot("1", "Kinder", end, 11)], sales: new Map<string, number>(), refillUnits: 0 });
    // Итог по товару за период отрицательный (−1): это излишек, а не «3 потери
    // и 4 излишка» — дневные знаки внутри товара гасятся (R-FW-1).
    const s = shrinkageByDay([day("2026-08-19", 10, 9), day("2026-08-20", 8, 11), day("2026-08-21", 9, 8)], prices, 30000);
    const k = s.items[0]!;
    assert.equal(k.lossUnits, 0);
    assert.equal(k.surplusUnits, 1);
    assert.equal(k.lossValue, 0);
    assert.equal(k.alert, false);
    assert.equal(s.lossValue, 0);
  });
  it("порог по позиции за период считается по НЕТТО-недостаче", () => {
    const day = (date: string, start: number, end: number) => ({ date, startSlots: [slot("1", "Kinder", start, 11)], endSlots: [slot("1", "Kinder", end, 11)], sales: new Map<string, number>(), refillUnits: 0 });
    const s = shrinkageByDay([day("2026-08-19", 10, 8), day("2026-08-20", 8, 7), day("2026-08-21", 9, 8)], prices, 30000);
    const k = s.items[0]!;
    assert.equal(k.lossUnits, 4);
    assert.equal(k.lossValue, 44000);
    assert.equal(k.alert, true);
  });
  it("товар без цены — noPrice, деньги 0; товар не в обоих снимках — день по нему пропущен", () => {
    const s = shrinkageByDay([{ date: "2026-08-19", startSlots: [slot("1", "TUC", 5), slot("2", "Kinder", 3)], endSlots: [slot("1", "TUC", 3)], sales: new Map(), refillUnits: 0 }], prices, 30000);
    assert.deepEqual(s.items.map((i) => [i.product, i.lossUnits, i.noPrice]), [["TUC", 2, true]]);
  });
});

describe("Полевой контур: неттинг усушки внутри товара за период (R-FW-1)", () => {
  const prices = new Map([["Kinder", 11000], ["Qurt", 6800]]);
  const день = (date: string, product: string, start: number, end: number, sales = 0) => ({
    date,
    startSlots: [slot("1", product, start, 11)],
    endSlots: [slot("1", product, end, 11)],
    sales: new Map<string, number>(sales ? [[product, sales]] : []),
    refillUnits: 0,
  });

  it("−3 и +3 по одному товару подряд гасятся: ни потерь, ни излишка", () => {
    // Прод: Ourvend кладёт 3 продажи в `dt` СЛЕДУЮЩИХ суток, и один товар даёт
    // день −3 и день +3. До неттинга это показывалось как 29 970 сум убытка.
    const s = shrinkageByDay([день("2026-08-14", "Kinder", 5, 2), день("2026-08-15", "Kinder", 0, 3)], prices, 30000);
    assert.deepEqual(s.items, []);
    assert.equal(s.lossValue, 0);
    assert.equal(s.daysCounted, 2);
  });

  it("−5 и +2 по одному товару: остаётся недостача 3, излишка нет", () => {
    const s = shrinkageByDay([день("2026-08-14", "Kinder", 10, 5), день("2026-08-15", "Kinder", 5, 7)], prices, 30000);
    const k = s.items.find((i) => i.product === "Kinder")!;
    assert.equal(k.lossUnits, 3);
    assert.equal(k.surplusUnits, 0);
    assert.equal(k.lossValue, 33000);
    assert.equal(k.daysCounted, 2);
    assert.equal(s.lossValue, 33000);
  });

  it("между товарами не гасится: излишек Qurt не закрывает недостачу Kinder (R-P4-3)", () => {
    const s = shrinkageByDay(
      [день("2026-08-14", "Kinder", 10, 7), день("2026-08-14", "Qurt", 4, 7)],
      prices,
      30000,
    );
    const k = s.items.find((i) => i.product === "Kinder")!;
    const q = s.items.find((i) => i.product === "Qurt")!;
    assert.equal(k.lossUnits, 3);
    assert.equal(k.surplusUnits, 0);
    assert.equal(q.lossUnits, 0);
    assert.equal(q.surplusUnits, 3);
    assert.equal(s.lossValue, 33000);
  });
});
