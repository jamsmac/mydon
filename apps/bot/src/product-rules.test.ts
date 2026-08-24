import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatRuleResult, isRuleCommand, parseRuleCommand } from "./product-rules";

describe("Бот: команды правил закупа товара (П5a)", () => {
  it("разбирает четыре формы", () => {
    assert.deepEqual(parseRuleCommand("не закупать Twix"), { kind: "exclude", product: "Twix" });
    assert.deepEqual(parseRuleCommand("Закупать twix"), { kind: "include", product: "twix" });
    assert.deepEqual(parseRuleCommand("фикс Snickers 48"), { kind: "fixed", product: "Snickers", qty: 48 });
    assert.deepEqual(parseRuleCommand("фикс Snickers нет"), { kind: "fixed", product: "Snickers", qty: 0 });
    assert.deepEqual(parseRuleCommand("блок Red Bull 6"), { kind: "pack", product: "Red Bull", qty: 6 });
  });
  it("число — один токен: «блок Cola 330 12» → товар «Cola 330», блок 12", () => {
    assert.deepEqual(parseRuleCommand("блок Cola 330 12"), { kind: "pack", product: "Cola 330", qty: 12 });
  });
  it("потолки и мусор → null; «закупать» без товара → null", () => {
    assert.equal(parseRuleCommand("блок TUC 5000"), null);
    assert.equal(parseRuleCommand("фикс TUC 0"), null);
    assert.equal(parseRuleCommand("закупать"), null);
  });
  it("отрицательное количество — отказ, а не молчаливое «плюс N»", () => {
    assert.equal(parseRuleCommand("блок TUC -5"), null);
    assert.equal(parseRuleCommand("фикс Snickers -48"), null);
    // Имя с дефисом и числом от этого не страдает.
    assert.deepEqual(parseRuleCommand("блок Cola-330 12"), { kind: "pack", product: "Cola-330", qty: 12 });
  });
  it("пустое имя товара — отказ (подсказка формата, а не 400 из Core)", () => {
    assert.equal(parseRuleCommand("не закупать «»"), null);
    assert.equal(parseRuleCommand("закупать «»"), null);
  });
  it("isRuleCommand не ловит «что закупать» и «закуп»", () => {
    assert.equal(isRuleCommand("что закупать"), false);
    assert.equal(isRuleCommand("закуп"), false);
    assert.equal(isRuleCommand("не закупать Lays"), true);
  });
  it("форматирует успех и «не найден»", () => {
    assert.match(formatRuleResult({ kind: "exclude", product: "Twix" }, { ok: true, product: "Twix 50gr" }), /«Twix 50gr» убран из закупки/);
    assert.match(formatRuleResult({ kind: "pack", product: "X", qty: 6 }, { ok: false, reason: "not_found", product: "X" }), /не найден/);
  });
});
