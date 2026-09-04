import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatInventoryNo,
  isValidInventoryNo,
  normalizeInventoryNo,
  seriesNumberOf,
  suggestInventoryNo,
} from "./parts";

describe("инвентарные номера узлов (R-PU-2)", () => {
  it("нормализация: без пробелов, верхний регистр, пустое → null", () => {
    assert.equal(normalizeInventoryNo(" m-001 "), "M-001");
    assert.equal(normalizeInventoryNo("h - 27 - 3"), "H-27-3");
    assert.equal(normalizeInventoryNo("   "), null);
    assert.equal(normalizeInventoryNo(undefined), null);
  });

  it("допустимый вид: латиница, цифры, дефис; кириллица и мусор — отказ", () => {
    assert.equal(isValidInventoryNo("M-001"), true);
    assert.equal(isValidInventoryNo("h-27-3"), true);
    assert.equal(isValidInventoryNo("12"), true, "свой формат с наклейки допустим");
    assert.equal(isValidInventoryNo("М-001"), false, "кириллическая М — не серия");
    assert.equal(isValidInventoryNo("-M"), false);
    assert.equal(isValidInventoryNo("x".repeat(40)), false);
  });

  it("серия по виду: M-017, G-004; бункер с набором — H-27-3", () => {
    assert.equal(formatInventoryNo("mixer", 17), "M-017");
    assert.equal(formatInventoryNo("grinder", 4), "G-004");
    assert.equal(formatInventoryNo("brewer", 1000), "B-1000");
    assert.equal(formatInventoryNo("hopper", 5, { setNumber: 27, position: 3 }), "H-27-3");
    assert.equal(formatInventoryNo("hopper", 5), "H-005", "бункер без набора — счётчик");
  });

  it("порядковый номер серии читается только из своей серии", () => {
    assert.equal(seriesNumberOf("mixer", "M-017"), 17);
    assert.equal(seriesNumberOf("mixer", "m-17"), 17);
    assert.equal(seriesNumberOf("mixer", "G-017"), null, "чужая серия");
    assert.equal(seriesNumberOf("mixer", "MIXER-1"), null);
    assert.equal(seriesNumberOf("hopper", "H-27-3"), null, "набор-позиция — не счётчик");
  });

  it("следующий свободный — максимум занятых + 1, дыры не переиспользуются", () => {
    assert.equal(suggestInventoryNo("mixer", []), "M-001");
    assert.equal(suggestInventoryNo("mixer", ["M-001", "M-003", "G-009", "старый-7"]), "M-004");
    assert.equal(suggestInventoryNo("grinder", ["G-009"]), "G-010");
  });
});
