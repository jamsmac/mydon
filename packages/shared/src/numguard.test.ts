import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { strictNumber } from "./numguard";

describe("strictNumber: строгий разбор чисел источника", () => {
  it("числа проходят как есть, включая ноль и отрицательные", () => {
    assert.equal(strictNumber(0), 0);
    assert.equal(strictNumber(60000), 60000);
    assert.equal(strictNumber(-15), -15);
    assert.equal(strictNumber(1.5), 1.5);
  });
  it("числовые строки разбираются", () => {
    assert.equal(strictNumber("60000"), 60000);
    assert.equal(strictNumber("  3.5 "), 3.5);
    assert.equal(strictNumber("0"), 0);
  });
  it("мусор — null, а не молчаливый 0", () => {
    assert.equal(strictNumber(""), null);
    assert.equal(strictNumber("   "), null);
    assert.equal(strictNumber("н/д"), null);
    assert.equal(strictNumber("abc"), null);
    assert.equal(strictNumber(NaN), null);
    assert.equal(strictNumber(Infinity), null);
    assert.equal(strictNumber(null), null);
    assert.equal(strictNumber(undefined), null);
    assert.equal(strictNumber({}), null);
  });
});
