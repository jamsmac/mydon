import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isMergedPlace, isPlaceOwnerType, mergeRequestProblem, placeFullName } from "./place-merge";

describe("место и контрагент (М-2, М-3, М-11)", () => {
  it("полное имя собирается на показ: «Центр кардиологии · 4 корпус»", () => {
    assert.equal(placeFullName("4 корпус", "Центр кардиологии"), "Центр кардиологии · 4 корпус");
  });

  it("без контрагента — просто имя: владельца на показ не выдумываем", () => {
    assert.equal(placeFullName("Parus F1", null), "Parus F1");
    assert.equal(placeFullName("Parus F1", "  "), "Parus F1");
  });

  it("владельцем помещения бывает контрагент или наша компания — не поставщик-товар и не место", () => {
    assert.equal(isPlaceOwnerType("contractor"), true);
    assert.equal(isPlaceOwnerType("own_company"), true);
    assert.equal(isPlaceOwnerType("location"), false);
    assert.equal(isPlaceOwnerType("product"), false);
  });
});

describe("слияние карточек мест (М-9, М-10)", () => {
  const ok = { sourceId: "a", targetId: "b", basis: "owner_word", reason: "одно место, слово владельца 10.09" };

  it("годный запрос — без замечаний", () => {
    assert.equal(mergeRequestProblem(ok), null);
  });

  it("совпадение адреса основанием не является — такого основания нет вовсе", () => {
    assert.match(mergeRequestProblem({ ...ok, basis: "address" }) ?? "", /адреса основанием не является/);
  });

  it("причина словами обязательна", () => {
    assert.match(mergeRequestProblem({ ...ok, reason: "   дубль " }) ?? "", /не короче/);
  });

  it("сама с собой — отказ", () => {
    assert.match(mergeRequestProblem({ ...ok, targetId: "a" }) ?? "", /саму с собой/);
  });

  it("слитая карточка узнаётся по пометке «слита в»", () => {
    assert.equal(isMergedPlace({ "слита в": "b-id", выключена: true }), true);
    assert.equal(isMergedPlace({ выключена: true }), false);
    assert.equal(isMergedPlace(null), false);
  });
});
