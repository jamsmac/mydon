import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stockBalance, type StockMovement } from "./stock";

describe("Склад: остаток на чтении", () => {
  it("приход в одной единице — остаток равен сумме", () => {
    const ms: StockMovement[] = [
      { kind: "intake", warehouseId: "w1", qty: 5, unit: "кг" },
      { kind: "intake", warehouseId: "w1", qty: 3, unit: "кг" },
    ];
    const b = stockBalance(ms, "кг");
    assert.equal(b.qty, 8);
    assert.equal(b.unconvertible, 0);
  });

  it("приход в «кг», расход в «г» — приводим к базовой единице", () => {
    // 2 кг завезли, 500 г списали → 1.5 кг.
    const ms: StockMovement[] = [
      { kind: "intake", warehouseId: "w1", qty: 2, unit: "кг" },
      { kind: "consumption", warehouseId: "w1", qty: 500, unit: "г" },
    ];
    const b = stockBalance(ms, "кг");
    assert.equal(b.qty, 1.5);
    assert.equal(b.unconvertible, 0);
  });

  it("остаток по конкретному складу считает только его движения", () => {
    const ms: StockMovement[] = [
      { kind: "intake", warehouseId: "w1", qty: 10, unit: "кг" },
      { kind: "intake", warehouseId: "w2", qty: 4, unit: "кг" },
    ];
    assert.equal(stockBalance(ms, "кг", "w1").qty, 10);
    assert.equal(stockBalance(ms, "кг", "w2").qty, 4);
    assert.equal(stockBalance(ms, "кг").qty, 14); // сводный
  });

  it("перемещение: −со склада, +на встречный; в сводном остатке нейтрально", () => {
    const ms: StockMovement[] = [
      { kind: "intake", warehouseId: "w1", qty: 10, unit: "кг" },
      { kind: "transfer", warehouseId: "w1", counterpartyId: "w2", qty: 3, unit: "кг" },
    ];
    assert.equal(stockBalance(ms, "кг", "w1").qty, 7);
    assert.equal(stockBalance(ms, "кг", "w2").qty, 3);
    assert.equal(stockBalance(ms, "кг").qty, 10); // перемещение само себя гасит
  });

  it("несводимая единица — непосчитана, остаток честно неполон", () => {
    const ms: StockMovement[] = [
      { kind: "intake", warehouseId: "w1", qty: 2, unit: "кг" },
      { kind: "intake", warehouseId: "w1", qty: 1, unit: "л" }, // объём в вес не перевести
    ];
    const b = stockBalance(ms, "кг", "w1");
    assert.equal(b.qty, 2);
    assert.equal(b.unconvertible, 1);
  });

  it("несводимое движение чужого склада не портит остаток этого", () => {
    const ms: StockMovement[] = [
      { kind: "intake", warehouseId: "w1", qty: 2, unit: "кг" },
      { kind: "intake", warehouseId: "w2", qty: 1, unit: "л" }, // чужой склад
    ];
    const b = stockBalance(ms, "кг", "w1");
    assert.equal(b.qty, 2);
    assert.equal(b.unconvertible, 0);
  });

  it("корректировка инвентаризации: отрицательная дельта уменьшает остаток", () => {
    // Было 10 кг, пересчёт показал 8 → дельта −2 → остаток 8.
    const ms: StockMovement[] = [
      { kind: "intake", warehouseId: "w1", qty: 10, unit: "кг" },
      { kind: "adjustment", warehouseId: "w1", qty: -2, unit: "кг" },
    ];
    assert.equal(stockBalance(ms, "кг", "w1").qty, 8);
    assert.equal(stockBalance(ms, "кг").qty, 8); // и в сводном
  });

  it("корректировка: положительная дельта — излишек", () => {
    const ms: StockMovement[] = [
      { kind: "intake", warehouseId: "w1", qty: 3, unit: "кг" },
      { kind: "adjustment", warehouseId: "w1", qty: 1.5, unit: "кг" },
    ];
    assert.equal(stockBalance(ms, "кг", "w1").qty, 4.5);
  });

  it("корректировка привязана к своему складу и не течёт на чужой", () => {
    const ms: StockMovement[] = [
      { kind: "intake", warehouseId: "w1", qty: 5, unit: "кг" },
      { kind: "intake", warehouseId: "w2", qty: 5, unit: "кг" },
      { kind: "adjustment", warehouseId: "w1", qty: -1, unit: "кг" },
    ];
    assert.equal(stockBalance(ms, "кг", "w1").qty, 4);
    assert.equal(stockBalance(ms, "кг", "w2").qty, 5, "чужой склад не тронут");
  });
});
