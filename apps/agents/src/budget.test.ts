import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asBudgetStrategy } from "./budget";

describe("asBudgetStrategy — неизвестное падает в pause", () => {
  it("распознаёт валидные и режет комментарий", () => {
    assert.equal(asBudgetStrategy("pause"), "pause");
    assert.equal(asBudgetStrategy("downgrade"), "downgrade");
    assert.equal(asBudgetStrategy("ask   # комментарий"), "ask");
  });
  it("мусор и пусто → pause", () => {
    assert.equal(asBudgetStrategy("свобода"), "pause");
    assert.equal(asBudgetStrategy(undefined), "pause");
  });
});
