import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeQuoteTotals, validateQuoteItems } from "./quote";

describe("computeQuoteTotals — итоги считает код, не модель", () => {
  it("выделяет НДС 12% из суммы с НДС", () => {
    // 1 позиция: 112000 сум с НДС × 1. netto = round(112000/1.12)=100000, НДС=12000.
    const t = computeQuoteTotals([{ priceUzs: 112000, qty: 1 }], 12000);
    assert.equal(t.uzs, 112000);
    assert.equal(t.vatUzs, 12000);
  });

  it("несколько позиций суммируются целочисленно", () => {
    const t = computeQuoteTotals([{ priceUzs: 100000, qty: 2 }, { priceUzs: 50000, qty: 3 }], 12000);
    assert.equal(t.uzs, 350000);
  });

  it("USD считается в центах (без потери копеек)", () => {
    // 120000 сум / курс 12000 = 10.00 USD = 1000 центов.
    const t = computeQuoteTotals([{ priceUzs: 120000, qty: 1 }], 12000);
    assert.equal(t.usdCents, 1000);
    assert.equal(t.usd, 10);
  });

  it("курс 0 → usd 0, а не деление на ноль", () => {
    const t = computeQuoteTotals([{ priceUzs: 100000, qty: 1 }], 0);
    assert.equal(t.usdCents, 0);
    assert.equal(t.usd, 0);
  });

  it("отрицательное количество обнуляется", () => {
    const t = computeQuoteTotals([{ priceUzs: 100000, qty: -5 }], 12000);
    assert.equal(t.uzs, 0);
  });
});

describe("validateQuoteItems — дробь в прайсе это ошибка, не повод округлить", () => {
  it("годные позиции → нет проблем", () => {
    assert.deepEqual(validateQuoteItems([{ priceUzs: 100000, qty: 2 }]), []);
  });
  it("пустой список отмечается", () => {
    assert.match(validateQuoteItems([]).join(), /нет позиций/);
  });
  it("дробная цена или отрицательное количество ловятся", () => {
    const problems = validateQuoteItems([{ priceUzs: 100.5, qty: 1 }, { priceUzs: 100, qty: -1 }]);
    assert.equal(problems.length, 2);
    assert.match(problems[0], /цена/);
    assert.match(problems[1], /количество/);
  });
});
