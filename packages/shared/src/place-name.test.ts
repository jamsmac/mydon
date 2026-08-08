import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { placeNameKeys } from "./place-name";

describe("placeNameKeys — имя аппарата как указание на место", () => {
  it("имя без уточнителя даёт один ключ", () => {
    assert.deepEqual(placeNameKeys("American Hospital"), ["american hospital"]);
  });

  it("уточнитель отрезается, но полное имя остаётся первым", () => {
    // Полное проверяется раньше: если место названо ровно так, рассуждать не о чем.
    assert.deepEqual(placeNameKeys("American Hospital · снек"), [
      "american hospital · снек",
      "american hospital",
    ]);
  });

  it("два аппарата одной точки сходятся на её ключе", () => {
    const снек = placeNameKeys("Olma Администрация · снек");
    const кофе = placeNameKeys("Olma Администрация");
    assert.ok(снек.includes(кофе[0]!), "оба должны указывать на одно место");
  });

  it("скобки и дефис не режем — это часть имени", () => {
    // «Снек (без точки)» обязан остаться собой: обрезанный, он совпал бы с чем угодно.
    assert.deepEqual(placeNameKeys("Снек (без точки)"), ["снек (без точки)"]);
    assert.deepEqual(placeNameKeys("Parus-F4"), ["parus-f4"]);
  });

  it("длинный хвост не уточнитель", () => {
    const k = placeNameKeys("Точка · очень длинное пояснение про этаж");
    assert.equal(k.length, 1, "резать можно только короткий хвост");
  });

  it("короткий остаток отбрасывается", () => {
    // Ключ «ab» связал бы аппарат с первой попавшейся точкой.
    assert.deepEqual(placeNameKeys("ab · снек"), ["ab · снек"]);
  });

  it("пустое имя ключей не даёт", () => {
    assert.deepEqual(placeNameKeys(""), []);
    assert.deepEqual(placeNameKeys(null), []);
  });

  it("регистр и ё сворачиваются, как в остальном реестре", () => {
    assert.deepEqual(placeNameKeys("АЛЁША · снек"), ["алеша · снек", "алеша"]);
  });
});
