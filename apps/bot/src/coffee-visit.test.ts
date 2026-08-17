import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextLocationKeyboard, parseVisitCallback, visitKeyboard, visitOf, visitSummary } from "./coffee-visit";

const VISIT = { locationId: "loc-1", locationName: "Olma office", refills: 2, consumables: false, started: true };

describe("Обход точки", () => {
  it("разбирает свои кнопки", () => {
    assert.deepEqual(parseVisitCallback("cv:more"), { kind: "more" });
    assert.deepEqual(parseVisitCallback("cv:cons"), { kind: "consumables" });
    assert.deepEqual(parseVisitCallback("cv:done"), { kind: "finish" });
    assert.deepEqual(parseVisitCallback("cv:next"), { kind: "next" });
    assert.equal(parseVisitCallback("cf:n:1"), null, "клавиатура заливки — не наша");
  });

  it("«ещё бункер» первым: на обходе это самое частое действие", () => {
    const rows = visitKeyboard(VISIT).inline_keyboard;
    assert.match(rows[0][0].text, /Ещё бункер/);
    assert.match(rows[2][0].text, /Завершить/);
  });

  it("внесённые расходники видны на кнопке — чтобы не вносить дважды по забывчивости", () => {
    assert.doesNotMatch(JSON.stringify(visitKeyboard(VISIT)), /внесены/);
    assert.match(JSON.stringify(visitKeyboard({ ...VISIT, consumables: true })), /внесены/);
  });

  it("сводка говорит, что сделано, пока с точки ещё можно не уходить", () => {
    assert.match(visitSummary(VISIT), /залито бункеров: 2/);
    assert.match(visitSummary(VISIT), /расходники не вносил/);
    assert.match(visitSummary({ ...VISIT, refills: 0, consumables: true }), /бункеры не заливал/);
  });

  it("после точки сразу предлагается следующая — слово набирать не надо", () => {
    assert.match(JSON.stringify(nextLocationKeyboard()), /cv:next/);
  });

  it("состояние без точки — обход не начат", () => {
    assert.equal(visitOf({}), null);
    assert.equal(visitOf({ locationId: "x" }), null, "имени нет — показать нечего");
    assert.deepEqual(visitOf({ locationId: "x", locationName: "Y" }), {
      locationId: "x",
      locationName: "Y",
      refills: 0,
      consumables: false,
      started: false,
    });
  });
});
