import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { denominationsTotal, parseDenominations } from "./denominations";

describe("Номиналы сума и сверка набора купюр", () => {
  it("сумма набора считается", () => {
    // Медианная инкассация 560 500 — не набирается целыми купюрами от 1000,
    // значит в живых данных суммы кратны 1000: проверяем на настоящей.
    assert.equal(denominationsTotal({ "50000": 10, "10000": 6 }), 560000);
    assert.equal(denominationsTotal({}), 0, "пустой набор — ноль, а не ошибка");
  });

  it("отрицательное количество купюр — ошибка ввода", () => {
    const r = parseDenominations({ "1000": "-5" });
    assert.ok("error" in r);
  });

  it("дробное количество купюр невозможно", () => {
    const r = parseDenominations({ "1000": "2.5" });
    assert.ok("error" in r, "полкупюры не бывает");
  });

  it("юникодный минус — нечитаемая запись, а не тихий ноль", () => {
    // U+2212 (математический минус), не ASCII-дефис "-" — его подставляет
    // автозамена macOS/Word. Number("−5") даёт NaN, а не -5, поэтому
    // проверка на отрицательное число его не ловит — нужна отдельная ветка.
    const r = parseDenominations({ "1000": "−5" });
    assert.ok("error" in r);
    assert.ok("error" in r && r.error.includes("1000"), "ошибка должна называть номинал");
  });

  it("опечатка «O» вместо «0» — нечитаемая запись, а не тихий ноль", () => {
    const r = parseDenominations({ "1000": "1O" });
    assert.ok("error" in r, "1O — не число, не должно молча стать нулём");
  });

  it("пустые поля читаются как ноль, а не как ошибка", () => {
    const r = parseDenominations({ "1000": "", "5000": "3" });
    assert.deepEqual(r, { counts: { "5000": 3 }, total: 15000 });
  });

  it("незнакомый номинал отвергается", () => {
    assert.ok("error" in parseDenominations({ "500": "2" }), "купюр 500 в обороте нет");
  });
});
