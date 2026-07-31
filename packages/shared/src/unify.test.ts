import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { unify } from "./unify";
import type { ReconField, ReconRow } from "./reconcile";

const FIELDS: ReconField[] = [
  { role: "machine", label: "Автомат", compare: "key" },
  { role: "amount", label: "Сумма", compare: "number" },
  { role: "payment", label: "Оплата", compare: "exact" },
];

const row = (key: string, v: Record<string, string>): ReconRow => ({ key, values: v });

/** Всегда просим одну большую страницу (первую), чтобы видеть весь союз. */
const all = (a: ReconRow[], b: ReconRow[]) => unify(a, b, FIELDS, 1, 1000);

describe("Объединение: заказ ложится один раз", () => {
  it("один и тот же номер из двух источников — один заказ", () => {
    const a = [row("100", { machine: "VM-1", amount: "15000", payment: "cash" })];
    const b = [row("100", { machine: "VM-1", amount: "15000", payment: "cash" })];
    const u = all(a, b);
    assert.equal(u.union, 1);
    assert.equal(u.both, 1);
    assert.equal(u.orders.length, 1);
    assert.equal(u.orders[0].presence, "both");
    assert.equal(u.orders[0].conflict, false);
  });

  it("союз не задваивает: 2 общих + 1 только A + 1 только B = 3 уникальных", () => {
    const a = [
      row("1", { amount: "100" }),
      row("2", { amount: "200" }),
      row("3", { amount: "300" }),
    ];
    const b = [
      row("2", { amount: "200" }),
      row("3", { amount: "300" }),
      row("9", { amount: "900" }),
    ];
    const u = all(a, b);
    assert.equal(u.union, 4);
    assert.equal(u.both, 2);
    assert.equal(u.onlyA, 1);
    assert.equal(u.onlyB, 1);
  });
});

describe("Объединение: согласие и спор", () => {
  it("суммы сходятся числом, «15000» = «15 000.00»", () => {
    const a = [row("1", { amount: "15000" })];
    const b = [row("1", { amount: "15 000.00" })];
    const u = all(a, b);
    const f = u.orders[0].fields.find((x) => x.role === "amount")!;
    assert.equal(f.agree, true);
    assert.equal(u.conflicts, 0);
  });

  it("расхождение — заказ спорный, показаны оба значения", () => {
    const a = [row("1", { amount: "15000" })];
    const b = [row("1", { amount: "20000" })];
    const u = all(a, b);
    assert.equal(u.conflicts, 1);
    const o = u.orders[0];
    assert.equal(o.conflict, true);
    const f = o.fields.find((x) => x.role === "amount")!;
    assert.equal(f.a, "15000");
    assert.equal(f.b, "20000");
    assert.equal(f.agree, false);
  });

  it("оплата cash и cash0 — точное сравнение, разошлись", () => {
    const a = [row("1", { payment: "cash" })];
    const b = [row("1", { payment: "cash0" })];
    const u = all(a, b);
    assert.equal(u.orders[0].conflict, true);
  });
});

describe("Объединение: односторонние и пустые поля", () => {
  it("заказ только у A — сторона B пустая, сравнивать не с чем", () => {
    const a = [row("7", { amount: "700", payment: "card" })];
    const b: ReconRow[] = [];
    const u = all(a, b);
    assert.equal(u.orders[0].presence, "onlyA");
    const f = u.orders[0].fields.find((x) => x.role === "amount")!;
    assert.equal(f.a, "700");
    assert.equal(f.b, null);
    assert.equal(f.agree, null);
  });

  it("поле, пустое у обоих, в журнал не попадает", () => {
    const a = [row("1", { amount: "100", payment: "" })];
    const b = [row("1", { amount: "100", payment: "" })];
    const u = all(a, b);
    assert.equal(u.orders[0].fields.some((f) => f.role === "payment"), false);
  });

  it("поле есть у одного, пусто у другого — сравнения нет, значение видно", () => {
    const a = [row("1", { machine: "VM-1" })];
    const b = [row("1", { machine: "" })];
    const u = all(a, b);
    const f = u.orders[0].fields.find((x) => x.role === "machine")!;
    assert.equal(f.a, "VM-1");
    assert.equal(f.b, null);
    assert.equal(f.agree, null);
  });
});

describe("Объединение: задвоенные номера", () => {
  it("номер, встреченный дважды в A, помечен и считается один раз", () => {
    const a = [
      row("5", { amount: "500" }),
      row("5", { amount: "500" }),
    ];
    const b = [row("5", { amount: "500" })];
    const u = all(a, b);
    assert.equal(u.union, 1);
    assert.equal(u.duplicated, 1);
    assert.equal(u.orders[0].duplicated, true);
  });

  it("сравнение идёт по первому вхождению, задвоение не сглаживает спор", () => {
    // Первое A=500 против B=900 — спор, несмотря на второе A=900.
    const a = [
      row("5", { amount: "500" }),
      row("5", { amount: "900" }),
    ];
    const b = [row("5", { amount: "900" })];
    const u = all(a, b);
    assert.equal(u.orders[0].conflict, true);
    assert.equal(u.orders[0].duplicated, true);
  });
});

describe("Объединение: порядок и страницы", () => {
  it("спорные — выше, затем односторонние, затем согласованные", () => {
    const a = [
      row("10", { amount: "100" }), // both, agree
      row("20", { amount: "200" }), // both, conflict
      row("30", { amount: "300" }), // only A
    ];
    const b = [
      row("10", { amount: "100" }),
      row("20", { amount: "999" }),
    ];
    const u = all(a, b);
    assert.equal(u.orders[0].key, "20"); // спорный
    assert.equal(u.orders[0].conflict, true);
    assert.equal(u.orders[1].key, "30"); // односторонний
    assert.equal(u.orders[2].key, "10"); // согласованный
  });

  it("страница нарезается после упорядочивания, свод по всему союзу", () => {
    const a = Array.from({ length: 5 }, (_, i) => row(String(i + 1), { amount: "100" }));
    const b = Array.from({ length: 5 }, (_, i) => row(String(i + 1), { amount: "100" }));
    const p1 = unify(a, b, FIELDS, 1, 2);
    assert.equal(p1.union, 5); // свод по всем
    assert.equal(p1.orders.length, 2); // первая страница — 2 из 5
    assert.equal(p1.page, 1);
    // Третья страница (1-based) — остаток: 5 - 2*2 = 1 заказ.
    const p3 = unify(a, b, FIELDS, 3, 2);
    assert.equal(p3.orders.length, 1);
  });

  it("нормализация ключа: пробелы и регистр не создают второй заказ", () => {
    const a = [row(" 100 ", { amount: "1" })];
    const b = [row("100", { amount: "1" })];
    const u = all(a, b);
    assert.equal(u.union, 1);
    assert.equal(u.both, 1);
  });

  it("пустой ключ сводить не с чем — заказ отброшен", () => {
    const a = [row("", { amount: "1" }), row("1", { amount: "1" })];
    const b = [row("1", { amount: "1" })];
    const u = all(a, b);
    assert.equal(u.union, 1);
  });
});
