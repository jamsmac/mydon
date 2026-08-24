import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatRuleResult, isRuleCommand, parseRuleCommand, ruleCommandHint } from "./product-rules";

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

  it("показывает «было → стало» из ответа Core, а не из команды (UX#28)", () => {
    const t = formatRuleResult(
      { kind: "pack", product: "TUC", qty: 5 },
      { ok: true, product: "TUC Crackers Sour cream and Onion", before: { packSize: 10 }, after: { packSize: 5 } },
    );
    assert.match(t, /Блок «TUC Crackers Sour cream and Onion»: было 10 → стало 5/);
  });

  it("ничего не изменилось — так и сказано, а не «записано»", () => {
    // Повтор той же команды прежде звучал как успешная правка, и владелец
    // уходил уверенным, что поменял то, что и так стояло.
    const t = formatRuleResult(
      { kind: "pack", product: "TUC", qty: 5 },
      { ok: true, product: "TUC", before: { packSize: 5 }, after: { packSize: 5 } },
    );
    assert.match(t, /уже было так, ничего не изменилось/);
    assert.doesNotMatch(t, /было 5 → стало 5/);
  });

  it("снятие фикса показывает «было N → стало нет»", () => {
    const t = formatRuleResult(
      { kind: "fixed", product: "Snickers", qty: 0 },
      { ok: true, product: "Snickers 50gr", before: { fixedPurchaseQty: 48 }, after: { fixedPurchaseQty: null } },
    );
    assert.match(t, /Фикс-количество «Snickers 50gr» снято/);
    assert.match(t, /Фикс «Snickers 50gr»: было 48 → стало нет/);
  });

  it("без before/after (старый ответ Core) — прежний текст без перехода", () => {
    const t = formatRuleResult({ kind: "include", product: "Twix" }, { ok: true, product: "Twix 50gr" });
    assert.match(t, /«Twix 50gr» снова закупается/);
    assert.doesNotMatch(t, /было/);
  });

  it("отказ парсера объясняет ПРИЧИНУ, а не показывает общую шпаргалку (UX#27)", () => {
    assert.match(ruleCommandHint("блок TUC 5000"), /Блок — от 1 до 1000 штук/);
    assert.match(ruleCommandHint("фикс TUC 0"), /Чтобы снять фикс, напиши «фикс <товар> нет»/);
    assert.match(ruleCommandHint("фикс TUC 200000"), /от 1 до 100000 штук|от 1 до 100 000 штук/);
    assert.match(ruleCommandHint("блок TUC -5"), /положительное число/);
    assert.match(ruleCommandHint("не закупать «»"), /какой товар/);
    assert.match(ruleCommandHint("блок"), /Правила закупа/);
  });
});
