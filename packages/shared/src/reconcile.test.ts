import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reconcile, valuesAgree, type ReconField, type ReconRow } from "./reconcile";

const FIELDS: ReconField[] = [
  { role: "amount", label: "Сумма", compare: "number" },
  { role: "product", label: "Товар", compare: "key" },
  { role: "payment", label: "Оплата", compare: "exact" },
];

const row = (key: string, v: Record<string, string>): ReconRow => ({ key, values: v });

describe("Сверка: сравнение значений по правилу роли", () => {
  it("число: «15000», «15000.00», «15 000.00» — одно и то же", () => {
    assert.equal(valuesAgree("15000", "15000.00", "number"), true);
    assert.equal(valuesAgree("15 000.00", "15000", "number"), true);
    assert.equal(valuesAgree("15000", "20000", "number"), false);
  });

  it("число: нечитаемое не приравнивается к нулю", () => {
    assert.equal(valuesAgree("—", "0", "number"), false);
    assert.equal(valuesAgree("—", "—", "number"), true, "но одинаковый текст сходится");
  });

  it("ключ: регистр и лишние пробелы не считаются расхождением", () => {
    assert.equal(valuesAgree("Ice Lemon Tea", "ice lemon  tea", "key"), true);
  });

  it("точно: cash и cash0 — разные каналы, их путать нельзя", () => {
    assert.equal(valuesAgree("cash", "cash0", "exact"), false);
    assert.equal(valuesAgree("cash", "cash", "exact"), true);
  });
});

describe("Сверка: построчно по ключу", () => {
  it("полное совпадение — расхождений нет", () => {
    const a = [row("ff01", { amount: "15000", product: "Tea", payment: "cash" })];
    const b = [row("ff01", { amount: "15000.00", product: "tea", payment: "cash" })];
    const r = reconcile(a, b, FIELDS);
    assert.equal(r.matched, 1);
    assert.equal(r.conflicts.length, 0);
    assert.equal(r.fields.find((f) => f.role === "amount")!.agree, 1);
  });

  it("расходится сумма — показаны ОБА значения, ни одно не объявлено верным", () => {
    const a = [row("ff01", { amount: "15000", product: "Tea", payment: "cash" })];
    const b = [row("ff01", { amount: "20000", product: "Tea", payment: "cash" })];
    const r = reconcile(a, b, FIELDS);
    assert.equal(r.conflicts.length, 1);
    assert.deepEqual(r.conflicts[0].diffs[0], { role: "amount", label: "Сумма", a: "15000", b: "20000" });
    assert.equal(r.fields.find((f) => f.role === "amount")!.differ, 1);
  });

  it("ключ есть только у одного источника — попадает в свой список", () => {
    const a = [row("ff01", { amount: "1" }), row("ff02", { amount: "2" })];
    const b = [row("ff02", { amount: "2" }), row("ff03", { amount: "3" })];
    const r = reconcile(a, b, FIELDS);
    assert.equal(r.matched, 1);
    assert.deepEqual(r.onlyA, ["ff01"]);
    assert.deepEqual(r.onlyB, ["ff03"]);
  });

  it("ключ сопоставляется без учёта регистра, значение показывается как в источнике", () => {
    const a = [row("FF01", { amount: "1" })];
    const b = [row("ff01", { amount: "1" })];
    const r = reconcile(a, b, FIELDS);
    assert.equal(r.matched, 1);
    assert.equal(r.onlyACount, 0);
  });

  it("поле есть у одного и нет у другого — это «не с чем сравнить», а не расхождение", () => {
    const a = [row("ff01", { amount: "15000", product: "Tea" })];
    const b = [row("ff01", { amount: "15000" })]; // товара нет
    const r = reconcile(a, b, FIELDS);
    assert.equal(r.conflicts.length, 0);
    assert.equal(r.fields.find((f) => f.role === "product")!.absent, 1);
    assert.equal(r.fields.find((f) => f.role === "product")!.differ, 0);
  });

  it("задвоенный заказ показан как факт, а не схлопнут молча", () => {
    // В самой панели три заказа задвоены — это её данные, а не наша ошибка.
    const a = [
      row("ff01", { amount: "15000" }),
      row("ff01", { amount: "15000" }),
      row("ff02", { amount: "9000" }),
    ];
    const b = [row("ff01", { amount: "15000" }), row("ff02", { amount: "9000" })];
    const r = reconcile(a, b, FIELDS);
    assert.deepEqual(r.duplicatesA, [{ key: "ff01", count: 2 }]);
    assert.equal(r.duplicatesB.length, 0);
    assert.equal(r.matched, 2, "сверяются уникальные ключи, задвоение — отдельно");
  });

  it("пустой ключ сверять не с чем — строка выпадает", () => {
    const a = [row("", { amount: "1" }), row("ff01", { amount: "2" })];
    const b = [row("ff01", { amount: "2" })];
    const r = reconcile(a, b, FIELDS);
    assert.equal(r.matched, 1);
    assert.equal(r.onlyACount, 0, "пустой ключ не считается «только у A»");
  });

  it("итоги считают все строки источника, включая задвоенные", () => {
    const a = [row("ff01", {}), row("ff01", {}), row("ff02", {})];
    const b = [row("ff01", {})];
    const r = reconcile(a, b, FIELDS);
    assert.equal(r.totalA, 3);
    assert.equal(r.totalB, 1);
  });
});
