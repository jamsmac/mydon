import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VendingPurchase, VendingPurchaseItem } from "./core-client";
import { formatPurchaseBrief } from "./purchase-brief";

const item = (o: Partial<VendingPurchaseItem> & { product: string }): VendingPurchaseItem => ({
  need: 0,
  buy: 0,
  pack: 1,
  order: 0,
  price: 0,
  costRounded: 0,
  noPrice: false,
  noSales: false,
  ...o,
});

const base = (o: Partial<VendingPurchase> = {}): VendingPurchase => ({
  items: [],
  excludedNoSales: [],
  noPrice: [],
  totalBuy: 0,
  totalOrder: 0,
  costExact: 0,
  costRounded: 0,
  overpay: 0,
  ...o,
});

describe("Брифинг закупа (Telegram)", () => {
  it("пусто везде — «закупать нечего»", () => {
    const t = formatPurchaseBrief(base());
    assert.match(t, /нечего/i);
  });

  it("итог, переплата и топ по стоимости", () => {
    const p = base({
      items: [
        item({ product: "Montella", buy: 4, order: 12, costRounded: 60000 }),
        item({ product: "Fanta", buy: 2, order: 12, costRounded: 24000 }),
      ],
      totalBuy: 6,
      totalOrder: 24,
      costRounded: 84000,
      overpay: 40000,
    });
    const t = formatPurchaseBrief(p);
    assert.match(t, /Купить 6 ед/);
    assert.match(t, /с упаковками 24 ед/);
    assert.match(t, /84\s?000 сум/);
    assert.match(t, /Переплата за упаковки: 40\s?000 сум/);
    // Топ по costRounded: Montella (60k) раньше Fanta (24k).
    assert.ok(t.indexOf("Montella") < t.indexOf("Fanta"));
    assert.match(t, /Montella — заказать 12 \(нехватка 4\)/);
  });

  it("без цены и без продаж — отдельными строками, не в закупе", () => {
    const p = base({
      items: [item({ product: "NoPrice", buy: 3, order: 3, noPrice: true })],
      excludedNoSales: [item({ product: "Dead", noSales: true })],
      noPrice: ["NoPrice"],
      totalBuy: 3,
      totalOrder: 3,
    });
    const t = formatPurchaseBrief(p);
    assert.match(t, /Без цены — на разбор: NoPrice/);
    assert.match(t, /Не закупать \(нет продаж\): Dead/);
    // У позиции без цены сумма не выдумывается.
    assert.match(t, /NoPrice — заказать 3 \(нехватка 3\) · нет цены/);
  });

  it("больше топа — сворачивает хвост в «…и ещё N»", () => {
    const items = Array.from({ length: 13 }, (_, i) =>
      item({ product: `P${i}`, buy: 1, order: 1, costRounded: 13 - i }),
    );
    const t = formatPurchaseBrief(base({ items, totalBuy: 13, totalOrder: 13, costRounded: 91 }));
    assert.match(t, /…и ещё 3/);
  });
});
