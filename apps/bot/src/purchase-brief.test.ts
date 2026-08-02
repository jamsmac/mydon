import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VendingPurchase, VendingPurchaseItem } from "./core-client";
import { formatPurchaseBrief, formatPurchaseSubmitAck, isPurchaseSubmitCommand } from "./purchase-brief";

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

describe("Оформление закупа: команда и подтверждение (§5.7)", () => {
  it("«оформить закуп» — команда submit, «закуп»/«что заказать» — нет", () => {
    assert.equal(isPurchaseSubmitCommand("оформить закуп"), true);
    assert.equal(isPurchaseSubmitCommand("отправь закуп на утверждение"), true);
    assert.equal(isPurchaseSubmitCommand("заявка на закуп"), true);
    assert.equal(isPurchaseSubmitCommand("согласуй заказ"), true);
    // Брифинг закупа — не submit.
    assert.equal(isPurchaseSubmitCommand("закуп"), false);
    assert.equal(isPurchaseSubmitCommand("что заказать"), false);
  });

  it("подтверждение отправки перечисляет позиции, сумму и куда смотреть", () => {
    const t = formatPurchaseSubmitAck({ submitted: true, positions: 3, costRounded: 84000 });
    assert.match(t, /отправлена на утверждение/);
    assert.match(t, /Позиций: 3/);
    assert.match(t, /84\s?000 сум/);
    assert.match(t, /согласования/);
  });

  it("нечего отправлять — показывает причину, без шума", () => {
    const t = formatPurchaseSubmitAck({ submitted: false, positions: 0, costRounded: 0, reason: "Закупать нечего." });
    assert.match(t, /нечего/i);
  });
});
