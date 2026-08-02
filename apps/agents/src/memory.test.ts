import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { signature } from "./memory";

describe("Сигнатура фактов (дельта-память)", () => {
  it("одинаковые факты → одинаковая сигнатура", () => {
    assert.equal(signature({ a: 1, b: 2 }), signature({ a: 1, b: 2 }));
  });

  it("порядок ключей не влияет", () => {
    assert.equal(signature({ a: 1, b: 2 }), signature({ b: 2, a: 1 }));
  });

  it("изменение значения меняет сигнатуру", () => {
    assert.notEqual(signature({ idleMachines: 4 }), signature({ idleMachines: 5 }));
  });

  it("пустые факты дают стабильную сигнатуру", () => {
    assert.equal(signature({}), signature({}));
    assert.equal(signature({}), "{}");
  });
});
