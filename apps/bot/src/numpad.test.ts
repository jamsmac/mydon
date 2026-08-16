import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyPress,
  NUMPAD_MAX_DIGITS,
  numpadKeyboard,
  numpadText,
  parseNumpadCallback,
} from "./numpad";

describe("Цифровая клавиатура: разбор нажатий", () => {
  it("узнаёт цифры, стирание, готово и пропуск", () => {
    assert.deepEqual(parseNumpadCallback("cf", "cf:n:7"), { kind: "digit", digit: "7" });
    assert.deepEqual(parseNumpadCallback("cf", "cf:n:del"), { kind: "erase" });
    assert.deepEqual(parseNumpadCallback("cf", "cf:n:ok"), { kind: "done" });
    assert.deepEqual(parseNumpadCallback("cf", "cf:n:skip"), { kind: "skip" });
  });

  it("чужой префикс и мусор не трогает — иначе мастера перехватят кнопки друг друга", () => {
    assert.equal(parseNumpadCallback("cf", "cw:n:7"), null, "клавиатура мойки — не наша");
    assert.equal(parseNumpadCallback("cf", "cf:loc:abc"), null, "выбор точки — не наша кнопка");
    assert.equal(parseNumpadCallback("cf", "cf:n:99"), null, "две цифры за нажатие не приходят");
    assert.equal(parseNumpadCallback("cf", "cf:n:"), null);
  });
});

describe("Цифровая клавиатура: набор числа", () => {
  it("копит цифры и стирает по одной", () => {
    let d = "";
    for (const c of ["1", "2", "3", "4"]) d = applyPress(d, { kind: "digit", digit: c });
    assert.equal(d, "1234");
    d = applyPress(d, { kind: "erase" });
    assert.equal(d, "123");
  });

  it("стирание пустого набора не падает и не уходит в минус", () => {
    assert.equal(applyPress("", { kind: "erase" }), "");
  });

  it("ведущие нули не копятся: «007» и «7» — одно число", () => {
    let d = applyPress("", { kind: "digit", digit: "0" });
    d = applyPress(d, { kind: "digit", digit: "0" });
    d = applyPress(d, { kind: "digit", digit: "7" });
    assert.equal(d, "7");
  });

  it("одинокий ноль остаётся — это введённое значение, а не пустота", () => {
    assert.equal(applyPress("", { kind: "digit", digit: "0" }), "0");
  });

  it("длиннее предела не растёт — защита от залипшего пальца", () => {
    let d = "";
    for (let i = 0; i < 12; i++) d = applyPress(d, { kind: "digit", digit: "9" });
    assert.equal(d.length, NUMPAD_MAX_DIGITS);
  });

  it("«готово» и «пропустить» набор не меняют", () => {
    assert.equal(applyPress("120", { kind: "done" }), "120");
    assert.equal(applyPress("120", { kind: "skip" }), "120");
  });
});

describe("Цифровая клавиатура: вид", () => {
  it("телефонная раскладка: 1-2-3 сверху, как в звонилке", () => {
    const rows = numpadKeyboard("cf").inline_keyboard;
    assert.deepEqual(
      rows[0].map((b) => b.text),
      ["1", "2", "3"],
    );
    assert.deepEqual(rows[3].map((b) => b.text), ["⌫", "0", "✅ Готово"]);
  });

  it("пропуск показывается только там, где поле необязательное", () => {
    const withSkip = JSON.stringify(numpadKeyboard("cf", { skip: true }));
    const without = JSON.stringify(numpadKeyboard("cf"));
    assert.ok(withSkip.includes("cf:n:skip"), "необязательный шаг даёт «пропустить»");
    assert.ok(!without.includes("cf:n:skip"), "обязательный — не даёт, иначе вес потеряется молча");
  });

  it("отмена ведёт в общий колбэк мастера, а не в свой", () => {
    assert.ok(JSON.stringify(numpadKeyboard("cf")).includes("cf:cancel"));
  });

  it("пустой набор показан прочерком, а не нулём", () => {
    assert.ok(numpadText("Вес?", "").includes("Набрано: —"));
    assert.ok(numpadText("Вес?", "0").includes("Набрано: 0"), "ноль — это значение");
    assert.ok(numpadText("Вес?", "1234", "г").includes("Набрано: 1234 г"));
  });
});
