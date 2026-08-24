import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PurchaseItem, Slot } from "./vending-calc";
import { allocateByRoute, allocateBySlots, coilOrder, routeOrderFrom } from "./vending-plan";

const item = (o: Partial<PurchaseItem> & { product: string; perMachine: Record<string, number> }): PurchaseItem => ({
  need: Object.values(o.perMachine).reduce((a, b) => a + b, 0),
  stock: 0, covered: 0, buy: 0, surplus: 0, pack: 1, order: 0, extra: 0, price: 0, costExact: 0, costRounded: 0,
  noPrice: false, noSales: false, fromPurchase: 0, fromStock: 0, unfilled: 0, toStock: 0, stockAfter: 0,
  excluded: false, fixedQty: null, ...o,
});

describe("План закупа: порядок слотов и маршрут", () => {
  it("coilOrder: 2 < 10 < 'A'", () => {
    assert.deepEqual(["10", "A", "2"].sort(coilOrder), ["2", "10", "A"]);
  });
  it("routeOrderFrom: серийники настройки первыми, остальные по имени; мусор игнорируется", () => {
    const ms = [{ serial: "2508160359", name: "American Hospital" }, { serial: "2508160376", name: "Olma" }, { serial: "1", name: "Zeta" }];
    assert.deepEqual(routeOrderFrom("2508160376, 9999", ms), ["2508160376", "2508160359", "1"]);
    assert.deepEqual(routeOrderFrom("", ms), ["2508160359", "2508160376", "1"]);
  });
});

describe("План закупа: раздача по автоматам", () => {
  it("первый автомат маршрута получает закуп первым, второй — остаток и склад", () => {
    const fanta = item({ product: "Fanta", perMachine: { olma: 8, ah: 4 }, fromPurchase: 8, fromStock: 3, unfilled: 1 });
    const [olma, ah] = allocateByRoute([fanta], ["olma", "ah"]);
    assert.deepEqual(olma!.byProduct.Fanta, { need: 8, fromPurchase: 8, fromStock: 0, unfilled: 0 });
    assert.deepEqual(ah!.byProduct.Fanta, { need: 4, fromPurchase: 0, fromStock: 3, unfilled: 1 });
    assert.equal(olma!.fromPurchase, 8);
    assert.equal(ah!.unfilled, 1);
  });
  it("автомат без потребности по товару не получает строки", () => {
    const x = item({ product: "X", perMachine: { olma: 2 }, fromPurchase: 2 });
    const [olma, ah] = allocateByRoute([x], ["olma", "ah"]);
    assert.equal(olma!.byProduct.X!.fromPurchase, 2);
    assert.equal(ah!.byProduct.X, undefined);
    assert.equal(ah!.need, 0);
  });
});

describe("План закупа: раздача по слотам", () => {
  const slots: Slot[] = [
    { coilId: "12", product: "Fanta", capacity: 11, quantity: 4 },
    { coilId: "3", product: "Fanta", capacity: 5, quantity: 2 },
    { coilId: "7", product: "TUC", capacity: 5, quantity: 5 },
    { coilId: "9", product: null, capacity: 5, quantity: 0 },
  ];
  it("меньший coilId первым: закуп → склад → пусто; слоты без дефицита и без товара пропущены", () => {
    const alloc = { serial: "olma", byProduct: { Fanta: { need: 10, fromPurchase: 4, fromStock: 3, unfilled: 3 } }, need: 10, fromPurchase: 4, fromStock: 3, unfilled: 3 };
    const rows = allocateBySlots(slots, alloc);
    assert.deepEqual(rows.map((r) => r.coilId), ["3", "12"]);
    assert.deepEqual(rows[0], { coilId: "3", product: "Fanta", quantity: 2, capacity: 5, need: 3, fromPurchase: 3, fromStock: 0, unfilled: 0 });
    assert.deepEqual(rows[1], { coilId: "12", product: "Fanta", quantity: 4, capacity: 11, need: 7, fromPurchase: 1, fromStock: 3, unfilled: 3 });
  });
  it("сумма по слотам равна раздаче автомата", () => {
    const alloc = { serial: "olma", byProduct: { Fanta: { need: 10, fromPurchase: 10, fromStock: 0, unfilled: 0 } }, need: 10, fromPurchase: 10, fromStock: 0, unfilled: 0 };
    const rows = allocateBySlots(slots, alloc);
    assert.equal(rows.reduce((a, r) => a + r.fromPurchase, 0), 10);
  });
});
