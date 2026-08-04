import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cogsBreakdown, unitMargin } from "./unit-cogs";
import { PREORDER_ACTIONS, PREORDER_ALLOWED, preorderActionError } from "./preorder-status";

describe("cogsBreakdown — 4 корзины себестоимости донора", () => {
  it("раскладывает по корзинам, прочее — в other, без курса — счётчиком", () => {
    const b = cogsBreakdown([
      { category: "supplier", uzs: 300 },
      { category: "logistics", uzs: 50 },
      { category: "customs", uzs: 100 },
      { category: "certification", uzs: 20 },
      { category: null, uzs: 5 },
      { category: "supplier", uzs: null }, // валюта без курса
    ]);
    assert.equal(b.supplier, 300);
    assert.equal(b.logistics, 50);
    assert.equal(b.customs, 100);
    assert.equal(b.other, 25);
    assert.equal(b.totalUzs, 475);
    assert.equal(b.unconverted, 1);
  });
});

describe("unitMargin — маржа от цены продажи (sales-analytics)", () => {
  it("ROUND((sale − cost) / sale × 100, 2)", () => {
    const m = unitMargin(500_000_000, 420_000_000);
    assert.equal(m.margin, 80_000_000);
    assert.equal(m.marginPct, 16);
  });
  it("нулевая цена — процент null, не деление на ноль", () => {
    assert.equal(unitMargin(0, 100).marginPct, null);
  });
});

describe("предзаказы — матрица ALLOWED_TRANSITIONS донора", () => {
  it("каждое действие согласовано с матрицей переходов", () => {
    for (const [action, t] of Object.entries(PREORDER_ACTIONS)) {
      for (const from of t.from) {
        assert.ok(
          PREORDER_ALLOWED[from].includes(t.to),
          `${action}: ${from} → ${t.to} должен быть в ALLOWED_TRANSITIONS`,
        );
        assert.equal(preorderActionError(action, from), null);
      }
    }
  });
  it("сознательные скипы донора живы: requested→ordered, in_procurement→in_transit", () => {
    assert.equal(preorderActionError("order", "requested"), null);
    assert.equal(preorderActionError("mark-in-transit", "in_procurement"), null);
  });
  it("терминальные closed/cancelled заморожены", () => {
    assert.match(preorderActionError("close", "closed") ?? "", /терминальном/);
    assert.match(preorderActionError("submit", "cancelled") ?? "", /терминальном/);
  });
  it("запрещённое: доставить из draft нельзя", () => {
    assert.match(preorderActionError("mark-delivered", "draft") ?? "", /невозможно/);
  });
});
