import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  contractTotals,
  fmtInt,
  fmtMoney,
  installmentSchedule,
  itemBreakdown,
  paymentBadge,
  trancheAmount,
} from "./contract-calc";

/**
 * Golden-тесты формул UZS-договора — фиксируют поведение донора PROMACH
 * до переноса (спецификация SPEC_UZS_CONTRACTS.md, §11).
 */

describe("contractTotals — НДС 12% «изнутри» (×12/112)", () => {
  it("112 000 000 с НДС → НДС 12 000 000, без НДС 100 000 000", () => {
    const t = contractTotals([{ qty: 2, price: 56_000_000 }]);
    assert.equal(t.totalWithVat, 112_000_000);
    assert.equal(t.totalVat, 12_000_000);
    assert.equal(t.totalNoVat, 100_000_000);
  });
  it("кривая цена строки не роняет итог — считается нулём", () => {
    const t = contractTotals([{ qty: 1, price: Number.NaN }, { qty: 1, price: 10 }]);
    assert.equal(t.totalWithVat, 10);
  });
});

describe("itemBreakdown — строка спецификации DOCX", () => {
  it("price=56 000 000 × 2: НДС 12 000 000, цена без НДС за единицу 50 000 000", () => {
    const b = itemBreakdown({ qty: 2, price: 56_000_000 });
    assert.equal(b.total, 112_000_000);
    assert.equal(b.vat, 12_000_000);
    assert.equal(b.noVat, 100_000_000);
    assert.equal(b.unitNoVat, 50_000_000);
  });
});

describe("installmentSchedule — рассрочка донора", () => {
  it("0%: 100 млн, предоплата 10%, 6 мес → 6 платежей ровно по 15 000 000", () => {
    const rows = installmentSchedule({
      totalWithVat: 100_000_000,
      prepayPct: 10,
      months: 6,
      annualRatePct: 0,
      firstDate: new Date(2026, 8, 1),
    });
    assert.equal(rows.length, 6);
    for (const r of rows) assert.equal(r.amount, 15_000_000);
    const principalSum = rows.reduce((s, r) => s + r.principalPart, 0);
    assert.ok(Math.abs(principalSum - 90_000_000) < 1e-6, "тело выплачено полностью");
    assert.ok(Math.abs(rows[5]!.balance) < 1e-6, "остаток в конце — ноль");
  });
  it("аннуитет: 100 млн, 12 мес, 24% годовых → месячный ≈ 9 455 960, проценты первого месяца 2 000 000", () => {
    const rows = installmentSchedule({
      totalWithVat: 100_000_000,
      prepayPct: 0,
      months: 12,
      annualRatePct: 24,
      firstDate: new Date(2026, 8, 1),
    });
    // Эталон — значение, вычисленное донорской формулой principal*(r(1+r)^n)/((1+r)^n−1).
    const r = 0.02;
    const expected = (100_000_000 * (r * Math.pow(1.02, 12))) / (Math.pow(1.02, 12) - 1);
    assert.ok(Math.abs(rows[0]!.amount - expected) < 1e-6);
    assert.ok(Math.abs(rows[0]!.amount - 9_455_960) < 1, "≈ 9 455 960 сум");
    assert.equal(rows[0]!.interestPart, 2_000_000);
    assert.ok(Math.abs(rows[11]!.balance) < 1e-3, "аннуитет гасит тело к последнему платежу");
  });
  it("даты — шаг месяц от первой (семантика setMonth донора)", () => {
    const rows = installmentSchedule({
      totalWithVat: 30,
      prepayPct: 0,
      months: 3,
      annualRatePct: 0,
      firstDate: new Date(2026, 11, 15), // 15 декабря — перенос через новый год
    });
    assert.deepEqual(
      rows.map((r) => [r.due.getFullYear(), r.due.getMonth() + 1, r.due.getDate()]),
      [
        [2026, 12, 15],
        [2027, 1, 15],
        [2027, 2, 15],
      ],
    );
  });
});

describe("trancheAmount — транш частичной оплаты", () => {
  it("30% от 112 000 000 → 33 600 000", () => {
    assert.equal(trancheAmount(112_000_000, 30), 33_600_000);
  });
});

describe("paymentBadge — производный платёжный статус", () => {
  it("total=0 → «—»; paid=0 → «Не оплачен»; 33.4% → «Частично (33%)»; 100% → «100% оплачен»", () => {
    assert.equal(paymentBadge(5, 0), "—");
    assert.equal(paymentBadge(0, 100), "Не оплачен");
    assert.equal(paymentBadge(33.4, 100), "Частично (33%)");
    assert.equal(paymentBadge(100, 100), "100% оплачен");
    assert.equal(paymentBadge(150, 100), "100% оплачен");
  });
});

describe("форматирование донора", () => {
  it("fmt(1234567.891) → «1 234 567,89»; fmtInt(99.5) → «100»", () => {
    // локаль ru-RU использует неразрывный пробел — сравниваем без него
    assert.equal(fmtMoney(1_234_567.891).replace(/ /g, " "), "1 234 567,89");
    assert.equal(fmtInt(99.5), "100");
  });
});
