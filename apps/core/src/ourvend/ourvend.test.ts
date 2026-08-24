import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeParity, type ParityDayRow } from "./ourvend-parity.service";
import { buildSnapshotRows, rewriteKeys, type SnapshotDay } from "./ourvend-snapshot.service";

describe("Снапшот OurVend: построчная проверка присланных дней", () => {
  it("нечисловое qty/amount — в карантин, не нулём в базу", () => {
    const days: SnapshotDay[] = [
      {
        dt: "2026-08-23",
        machineSerial: "2508160376",
        rows: [
          { product: "Fanta", qty: "12", amount: "144000" },
          { product: "Мусор", qty: "N/A", amount: "1" },
          { product: "Мусор2", qty: "1", amount: "12 000" },
        ],
      },
    ];
    const { clean, quarantined } = buildSnapshotRows(days, true);
    assert.equal(clean.length, 1);
    assert.equal(clean[0].qty, 12);
    assert.equal(quarantined.length, 2);
    assert.equal(quarantined[0].field, "qty");
    assert.equal(quarantined[1].field, "amount");
  });

  it("снимок остатков (без денег): amount не проверяется и не требуется", () => {
    const days: SnapshotDay[] = [
      { dt: "2026-08-24", machineSerial: "2508160376", rows: [{ product: "Вода", qty: 6.5 }] },
    ];
    const { clean, quarantined } = buildSnapshotRows(days, false);
    assert.equal(clean.length, 1);
    assert.equal(clean[0].qty, 6.5);
    assert.equal(quarantined.length, 0);
  });

  it("серийник приводится к канону (без «c»), битая дата отбрасывает день", () => {
    const days: SnapshotDay[] = [
      { dt: "23.08.2026", machineSerial: "X", rows: [{ product: "A", qty: 1, amount: 1 }] },
      { dt: "2026-08-23", machineSerial: "C2508160376", rows: [{ product: "A", qty: 1, amount: 1 }] },
    ];
    const { clean } = buildSnapshotRows(days, true);
    assert.equal(clean.length, 1);
    assert.equal(clean[0].machineSerial, "2508160376");
  });

  it("двойники (день, автомат, товар) агрегируются суммой — 23505 невозможен", () => {
    const days: SnapshotDay[] = [
      {
        dt: "2026-08-23",
        machineSerial: "2508160376",
        rows: [
          { product: "Снек", qty: 2, amount: 20000 },
          { product: "Снек", qty: 3, amount: 30000 },
        ],
      },
    ];
    const { clean } = buildSnapshotRows(days, true);
    assert.equal(clean.length, 1);
    assert.equal(clean[0].qty, 5);
    assert.equal(clean[0].amount, 50000);
  });

  it("битые формы (rows не массив, null-элемент) отбрасываются, а не роняют приём", () => {
    const days = [
      { dt: "2026-08-23", machineSerial: "A", rows: {} },
      { dt: "2026-08-23", machineSerial: "B", rows: [null, { product: "X", qty: 1, amount: 1 }] },
    ] as unknown as SnapshotDay[];
    const { clean, quarantined } = buildSnapshotRows(days, true);
    assert.equal(clean.length, 1);
    assert.equal(quarantined.length, 0);
  });

  it("ключи перезаписи включают дни БЕЗ строк — пустой день стирает старое", () => {
    const days: SnapshotDay[] = [
      { dt: "2026-08-23", machineSerial: "A", rows: [] },
      { dt: "2026-08-23", machineSerial: "A", rows: [] },
      { dt: "2026-08-23", machineSerial: "B", rows: [{ product: "X", qty: 1, amount: 1 }] },
    ];
    const keys = rewriteKeys(days);
    assert.equal(keys.length, 2, "дубли ключей схлопываются, пустые дни остаются");
  });
});

describe("Паритет собственного снапшота со stock-дорожкой (гейт П2)", () => {
  const row = (dt: string, serial: string, qty: number, amount: number): ParityDayRow => ({
    dt,
    serial,
    qty,
    amount,
  });

  it("полное совпадение — ноль расхождений", () => {
    const own = [row("2026-08-23", "2508160376", 12, 144000)];
    const stock = [row("2026-08-23", "2508160376", 12, 144000)];
    const { checked, mismatches } = computeParity(own, stock);
    assert.equal(checked, 1);
    assert.equal(mismatches.length, 0);
  });

  it("разошлись суммы — расхождение с обеими сторонами в отчёте", () => {
    const own = [row("2026-08-23", "m1", 12, 144000)];
    const stock = [row("2026-08-23", "m1", 11, 132000)];
    const { mismatches } = computeParity(own, stock);
    assert.equal(mismatches.length, 1);
    assert.equal(mismatches[0].reason, "суммы расходятся");
    assert.equal(mismatches[0].ownQty, 12);
    assert.equal(mismatches[0].stockQty, 11);
  });

  it("день есть у нас, нет у stock — и наоборот — оба видны", () => {
    const own = [row("2026-08-22", "m1", 1, 1000)];
    const stock = [row("2026-08-23", "m1", 2, 2000)];
    const { mismatches } = computeParity(own, stock);
    assert.equal(mismatches.length, 2);
    assert.ok(mismatches.some((m) => m.reason.includes("stock-дорожки нет")));
    assert.ok(mismatches.some((m) => m.reason.includes("нашем снапшоте нет")));
  });

  it("копеечная разница float не считается расхождением", () => {
    const own = [row("2026-08-23", "m1", 12, 144000.001)];
    const stock = [row("2026-08-23", "m1", 12, 144000)];
    assert.equal(computeParity(own, stock).mismatches.length, 0);
  });
});
