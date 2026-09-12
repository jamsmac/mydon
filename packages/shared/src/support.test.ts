import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STABLE_FACTS, supportLabel, supportOf, SUPPORT_WORD } from "./support";

describe("supportOf — опора под цифрой (Н-3, Н-4)", () => {
  it("ноль фактов — «нет данных», а не «предварительно»", () => {
    assert.equal(supportOf(0).strength, "none");
    assert.equal(supportOf(-3).strength, "none", "мусор не делает цифру предварительной");
  });

  it("граница ровно на STABLE_FACTS: 9 — предварительно, 10 — устойчиво", () => {
    assert.equal(supportOf(STABLE_FACTS - 1).strength, "preliminary");
    assert.equal(supportOf(STABLE_FACTS).strength, "stable");
  });

  it("пример из спеки читается дословно", () => {
    assert.equal(supportLabel(supportOf(3, 27), "заправки"), "предварительно, 3 заправки из 27");
    assert.equal(supportLabel(supportOf(40), "заправок"), "устойчиво, 40 заправок");
  });

  it("порог доверия — не порог сокрытия: слабая цифра всё равно несёт число фактов", () => {
    const s = supportOf(1, 27);
    assert.equal(s.facts, 1, "цифру не прячем и не обнуляем");
    assert.match(supportLabel(s, "заправки"), /предварительно/);
  });

  it("дробные и нечисловые входы не создают полуфактов", () => {
    assert.equal(supportOf(3.7).facts, 3);
    assert.equal(supportOf(Number.NaN).facts, 0);
    assert.equal(supportOf(5, Number.NaN).of, null);
  });

  it("словарь один на систему — три слова, не синонимы в каждом отчёте", () => {
    assert.deepEqual(Object.values(SUPPORT_WORD), ["нет данных", "предварительно", "устойчиво"]);
  });
});
