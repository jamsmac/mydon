import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePlanogram } from "./planogram";

describe("Планограмма автомата", () => {
  it("читает занятые слоты", () => {
    const attrs = {
      раскладка: JSON.stringify([
        { slot: "A1", productId: "p1" },
        { slot: "A2", productId: "p2" },
      ]),
    };
    assert.deepEqual(parsePlanogram(attrs), [
      { slot: "A1", productId: "p1" },
      { slot: "A2", productId: "p2" },
    ]);
  });

  it("пусто/битьё → пустой список, не падает", () => {
    assert.deepEqual(parsePlanogram(null), []);
    assert.deepEqual(parsePlanogram({}), []);
    assert.deepEqual(parsePlanogram({ раскладка: "не json" }), []);
    assert.deepEqual(parsePlanogram({ раскладка: "{}" }), []);
  });

  it("пустой слот и пустой товар отбрасываются", () => {
    const attrs = {
      раскладка: JSON.stringify([
        { slot: "  ", productId: "p1" },
        { slot: "A1", productId: "" },
        { slot: "A2", productId: "p2" },
      ]),
    };
    assert.deepEqual(parsePlanogram(attrs), [{ slot: "A2", productId: "p2" }]);
  });

  it("повторный слот отбрасывается — в ячейке один товар", () => {
    const attrs = {
      раскладка: JSON.stringify([
        { slot: "A1", productId: "p1" },
        { slot: "A1", productId: "p2" },
      ]),
    };
    assert.deepEqual(parsePlanogram(attrs), [{ slot: "A1", productId: "p1" }]);
  });

  it("слот обрезается от пробелов", () => {
    assert.deepEqual(parsePlanogram({ раскладка: JSON.stringify([{ slot: " B3 ", productId: "p1" }]) }), [
      { slot: "B3", productId: "p1" },
    ]);
  });
});
