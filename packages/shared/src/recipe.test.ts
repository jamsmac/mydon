import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { convertQty, isUnit, parseRecipe, recipeCost, type IngredientPrice, type RecipeLine } from "./recipe";

describe("Рецепт: перевод единиц", () => {
  it("вес: г↔кг", () => {
    assert.equal(convertQty(18, "г", "кг"), 0.018);
    assert.equal(convertQty(2, "кг", "г"), 2000);
  });
  it("объём: мл↔л", () => {
    assert.equal(convertQty(200, "мл", "л"), 0.2);
    assert.equal(convertQty(1, "л", "мл"), 1000);
  });
  it("та же единица — без изменения", () => {
    assert.equal(convertQty(5, "шт", "шт"), 5);
  });
  it("разные размерности несовместимы", () => {
    assert.equal(convertQty(1, "г", "мл"), null);
    assert.equal(convertQty(1, "кг", "л"), null);
  });
  it("штучные не переводятся друг в друга: порция ≠ чашка", () => {
    assert.equal(convertQty(1, "порция", "чашка"), null);
    assert.equal(convertQty(1, "шт", "порция"), null);
  });
  it("isUnit узнаёт свои и отвергает чужие", () => {
    assert.equal(isUnit("г"), true);
    assert.equal(isUnit("kg"), false);
    assert.equal(isUnit(5), false);
  });
});

describe("Рецепт: себестоимость", () => {
  const prices: Record<string, IngredientPrice> = {
    beans: { price: 80000, unit: "кг" }, // 80 000 сум/кг
    milk: { price: 12000, unit: "л" }, // 12 000 сум/л
    cup: { price: 500, unit: "шт" },
    noPrice: { price: null, unit: null },
    grams: { price: 200, unit: "г" },
  };
  const at = (id: string) => prices[id] ?? { price: null, unit: null };

  it("считает по составу с переводом единиц", () => {
    const lines: RecipeLine[] = [
      { ingredientId: "beans", quantity: 18, unit: "г" }, // 0.018 кг × 80000 = 1440
      { ingredientId: "milk", quantity: 150, unit: "мл" }, // 0.15 л × 12000 = 1800
      { ingredientId: "cup", quantity: 1, unit: "шт" }, // 1 × 500 = 500
    ];
    const r = recipeCost(lines, at);
    assert.equal(r.total, 1440 + 1800 + 500);
    assert.equal(r.unresolved, 0);
  });

  it("ингредиент без цены — строка непосчитана, итог честно неполон", () => {
    const r = recipeCost([{ ingredientId: "noPrice", quantity: 10, unit: "г" }], at);
    assert.equal(r.total, 0);
    assert.equal(r.unresolved, 1);
    assert.equal(r.lines[0].cost, null);
    assert.match(r.lines[0].why!, /цена/);
  });

  it("несовместимая единица — строка непосчитана с причиной", () => {
    // grams — цена за «г», а в составе «мл»: перевести нельзя.
    const r = recipeCost([{ ingredientId: "grams", quantity: 50, unit: "мл" }], at);
    assert.equal(r.unresolved, 1);
    assert.match(r.lines[0].why!, /размерност/);
  });

  it("частично посчитанный рецепт: сумма только по посчитанным", () => {
    const r = recipeCost(
      [
        { ingredientId: "cup", quantity: 1, unit: "шт" }, // 500
        { ingredientId: "noPrice", quantity: 1, unit: "шт" }, // непосчитан
      ],
      at,
    );
    assert.equal(r.total, 500);
    assert.equal(r.unresolved, 1);
  });
});

describe("Рецепт: чтение состава из attrs", () => {
  it("массив объектов читается", () => {
    const lines = parseRecipe({ состав: [{ ingredientId: "a", quantity: 18, unit: "г" }] });
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0], { ingredientId: "a", quantity: 18, unit: "г" });
  });
  it("состав строкой (JSON) тоже читается", () => {
    const lines = parseRecipe({ состав: '[{"ingredientId":"a","quantity":2,"unit":"кг"}]' });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].quantity, 2);
  });
  it("мусор молча отбрасывается: полусломанному не место в расчёте", () => {
    const lines = parseRecipe({
      состав: [
        { ingredientId: "", quantity: 1, unit: "г" }, // нет ингредиента
        { ingredientId: "a", quantity: 0, unit: "г" }, // ноль
        { ingredientId: "b", quantity: 5, unit: "фунт" }, // чужая единица
        { ingredientId: "c", quantity: 3, unit: "мл" }, // ок
      ],
    });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].ingredientId, "c");
  });
  it("нет состава — пустой список, а не ошибка", () => {
    assert.deepEqual(parseRecipe({}), []);
    assert.deepEqual(parseRecipe(null), []);
    assert.deepEqual(parseRecipe({ состав: "не json" }), []);
  });
});
