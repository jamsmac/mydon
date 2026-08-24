import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VendingPlan } from "./core-client";
import { TG_BUDGET, formatPurchasePlan, isPlanCommand } from "./purchase-plan";

/** ru-RU ставит U+202F/U+00A0 в тысячах — сравниваем по обычному пробелу. */
const norm = (s: string): string => s.replace(/[\u00a0\u202f]/g, " ");

const plan: VendingPlan = {
  generatedAt: "2026-08-25T04:00:00.000Z",
  stock: { asOf: "2026-08-20T15:00:00.000Z", totalBefore: 134, use: 3, back: 4, totalAfter: 135, stale: true },
  summary: {
    items: [
      {
        product: "Fanta",
        need: 12,
        stock: 3,
        buy: 9,
        pack: 12,
        order: 12,
        price: 5167,
        costRounded: 62004,
        noPrice: false,
        noSales: false,
        fromPurchase: 12,
        fromStock: 0,
        unfilled: 0,
        toStock: 0,
        stockAfter: 3,
        excluded: false,
        fixedQty: null,
        perMachine: { "2508160376": 8, "2508160359": 4 },
      },
    ],
    excludedNoSales: [],
    excludedByRule: [
      {
        product: "Qurt",
        need: 5,
        stock: 3,
        buy: 0,
        pack: 10,
        order: 0,
        price: 6800,
        costRounded: 0,
        noPrice: false,
        noSales: false,
        fromPurchase: 0,
        fromStock: 3,
        unfilled: 2,
        toStock: 0,
        stockAfter: 0,
        excluded: true,
        fixedQty: null,
        perMachine: { "2508160376": 5 },
      },
    ],
    noPrice: [],
    totalBuy: 9,
    totalOrder: 12,
    costExact: 46503,
    costRounded: 62004,
    overpay: 15501,
    totalFromPurchase: 12,
    totalFromStock: 3,
    totalUnfilled: 2,
    totalToStock: 0,
    allocation: "purchase-first",
  },
  machines: [
    {
      serial: "2508160376",
      name: "Olma",
      routeIndex: 1,
      need: 13,
      fromPurchase: 8,
      fromStock: 3,
      unfilled: 2,
      slots: [
        { coilId: "3", product: "Fanta", quantity: 1, capacity: 5, need: 4, fromPurchase: 4, fromStock: 0, unfilled: 0 },
        { coilId: "5", product: "Qurt", quantity: 0, capacity: 5, need: 5, fromPurchase: 0, fromStock: 3, unfilled: 2 },
      ],
    },
    {
      serial: "2508160359",
      name: "American Hospital",
      routeIndex: 2,
      need: 4,
      fromPurchase: 4,
      fromStock: 0,
      unfilled: 0,
      slots: [
        { coilId: "12", product: "Fanta", quantity: 7, capacity: 11, need: 4, fromPurchase: 4, fromStock: 0, unfilled: 0 },
      ],
    },
  ],
  warnings: [{ code: "stock_stale", message: "Склад инвентаризирован 20.08.2026 — обнови: «склад …»" }],
};

describe("Бот: команда «план закупа»", () => {
  it("ловит формулировки владельца и не ловит «что заказать»", () => {
    for (const t of ["план закупа", "План закупки", "маршрут закупа", "план загрузки"]) assert.equal(isPlanCommand(t), true, t);
    for (const t of ["что заказать", "закуп", "оформить закуп"]) assert.equal(isPlanCommand(t), false, t);
  });
  it("сводка: итоги, маршрут по автоматам, склад до/после, предупреждение о давности", () => {
    const [head] = formatPurchasePlan(plan).map(norm);
    assert.match(head!, /Загрузить 15 из 17/);
    assert.match(head!, /купить 12 .*62 004/);
    assert.match(head!, /1\. Olma — загрузить 11 \(закуп 8 · склад 3\) · пусто 2/);
    assert.match(head!, /2\. American Hospital — загрузить 4/);
    assert.match(head!, /Склад: 134 → 135/);
    assert.match(head!, /⚠️ .*20\.08\.2026/);
  });
  it("купить / со склада / убрано / слоты по автоматам — отдельные сообщения", () => {
    const parts = formatPurchasePlan(plan).map(norm);
    assert.ok(parts.some((p) => /🛒 Купить/.test(p) && /Fanta — 12 \(в автоматы 12, на склад 0\) · 62 004 сум/.test(p)));
    assert.ok(parts.some((p) => /📦 Со склада/.test(p) && /Qurt — 3/.test(p)));
    assert.ok(parts.some((p) => /🚫 Убрано из закупки/.test(p) && /Qurt — со склада 3, пусто 2/.test(p)));
    assert.ok(parts.some((p) => /🎰 Olma/.test(p) && /слот 5 Qurt: 0\/5 \+5 → склад 3 · пусто 2/.test(p)));
  });
  it("каждое сообщение укладывается в бюджет Telegram", () => {
    const big = { ...plan, machines: plan.machines.map((m) => ({ ...m, slots: Array.from({ length: 200 }, (_, i) => ({ ...m.slots[0]!, coilId: String(i) })) })) };
    for (const p of formatPurchasePlan(big)) assert.ok(p.length <= TG_BUDGET, String(p.length));
  });
  it("маршрут из десятков автоматов с предупреждениями — сводка тоже режется", () => {
    const many = {
      ...plan,
      machines: Array.from({ length: 40 }, (_, i) => ({ ...plan.machines[0]!, routeIndex: i + 1, name: `Автомат с длинным именем ${i}` })),
      warnings: Array.from({ length: 40 }, (_, i) => ({ code: "machine_skipped" as const, message: `Автомат ${i} не в строю — пропущен в плане.` })),
    };
    for (const p of formatPurchasePlan(many)) assert.ok(p.length <= TG_BUDGET, String(p.length));
  });

  it("нечего грузить — одно сообщение", () => {
    const empty = { ...plan, summary: { ...plan.summary, items: [], excludedByRule: [], totalFromPurchase: 0, totalFromStock: 0, totalUnfilled: 0 }, machines: [] };
    assert.equal(formatPurchasePlan(empty).length, 1);
  });
});
