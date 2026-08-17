import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asStaffMode } from "./as-staff";

describe("Режим «побыть сотрудником»", () => {
  it("включается житейскими словами, а не командой со слэшем", () => {
    for (const phrase of ["я сотрудник", "Режим сотрудника", "как сотрудник", "побыть сотрудником"]) {
      const mode = new Set<number>();
      assert.equal(asStaffMode(1, phrase, mode), true, phrase);
      assert.ok(mode.has(1), phrase);
    }
  });

  it("выключается и возвращает владельца", () => {
    const mode = new Set<number>([1]);
    assert.equal(asStaffMode(1, "я владелец", mode), true);
    assert.equal(mode.has(1), false);
  });

  it("точное совпадение: фраза внутри вопроса режим не меняет", () => {
    const mode = new Set<number>();
    assert.equal(asStaffMode(1, "а если я сотрудник склада, что мне видно?", mode), false);
    assert.equal(mode.has(1), false, "свободный вопрос владельца не переключает бота молча");
  });

  it("режим у каждого чата свой", () => {
    const mode = new Set<number>();
    asStaffMode(1, "я сотрудник", mode);
    assert.ok(mode.has(1));
    assert.equal(mode.has(2), false);
  });

  it("повторное включение не ломает состояние", () => {
    const mode = new Set<number>();
    asStaffMode(1, "я сотрудник", mode);
    asStaffMode(1, "я сотрудник", mode);
    assert.equal(mode.size, 1);
  });
});
