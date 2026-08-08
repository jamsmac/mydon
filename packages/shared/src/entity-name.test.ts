import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_ENTITY_NAME, entityNameProblem } from "./entity-name";

describe("entityNameProblem — имя карточки, а не строка документа", () => {
  it("обычное имя проходит", () => {
    assert.equal(entityNameProblem("EAST-WEST INVEST ООО СП"), null);
  });

  it("длинное, но правдоподобное имя проходит", () => {
    // Настоящие названия бывают длинными — граница не должна мешать работе.
    assert.equal(entityNameProblem("ООО СП ".padEnd(300, "х")), null);
  });

  it("склейка строк накладной отвергается с понятной причиной", () => {
    // Ровно тот случай 04.08.2026: в имени несколько контрагентов сразу.
    const склейка =
      "EAST-WEST INVEST 302512057 Шины камерные, ROADBUSTER 1350000 ".repeat(30);
    const причина = entityNameProblem(склейка);
    assert.ok(причина, "такое имя обязано быть отвергнуто");
    assert.match(причина, /строка документа/);
    assert.match(причина, new RegExp(String(склейка.trim().length)));
  });

  it("на границе — можно, за границей — нельзя", () => {
    assert.equal(entityNameProblem("х".repeat(MAX_ENTITY_NAME)), null);
    assert.ok(entityNameProblem("х".repeat(MAX_ENTITY_NAME + 1)));
  });

  it("пустое и слишком короткое — прежняя проверка сохранена", () => {
    assert.match(entityNameProblem("")!, /короче/);
    assert.match(entityNameProblem(" a ")!, /короче/);
    assert.match(entityNameProblem(null)!, /короче/);
  });
});
