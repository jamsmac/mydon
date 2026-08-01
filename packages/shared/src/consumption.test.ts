import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { consumptionReport, type SoldProduct } from "./consumption";
import type { IngredientPrice, RecipeLine } from "./recipe";

const recipes: Record<string, RecipeLine[]> = {
  latte: [
    { ingredientId: "beans", quantity: 18, unit: "г" },
    { ingredientId: "milk", quantity: 150, unit: "мл" },
    { ingredientId: "cup", quantity: 1, unit: "шт" },
  ],
  americano: [
    { ingredientId: "beans", quantity: 14, unit: "г" },
    { ingredientId: "cup", quantity: 1, unit: "шт" },
  ],
};
const prices: Record<string, IngredientPrice> = {
  beans: { price: 80000, unit: "кг" },
  milk: { price: 12000, unit: "л" },
  cup: { price: 500, unit: "шт" },
};
const recipeOf = (id: string): RecipeLine[] => recipes[id] ?? [];
const priceOf = (id: string): IngredientPrice => prices[id] ?? { price: null, unit: null };
const byId = (r: ReturnType<typeof consumptionReport>, id: string) =>
  r.ingredients.find((x) => x.ingredientId === id)!;

describe("Расход: списание из продаж", () => {
  it("10 латте — списывает состав, приводит к базовой единице", () => {
    const sold: SoldProduct[] = [{ productId: "latte", qty: 10 }];
    const r = consumptionReport(sold, recipeOf, priceOf);
    // beans: 10×18=180 г → 0.18 кг × 80000 = 14400
    assert.equal(byId(r, "beans").consumed, 0.18);
    assert.equal(byId(r, "beans").unit, "кг");
    assert.equal(byId(r, "beans").cost, 14400);
    // milk: 10×150=1500 мл → 1.5 л × 12000 = 18000
    assert.equal(byId(r, "milk").consumed, 1.5);
    assert.equal(byId(r, "milk").cost, 18000);
    // cup: 10 шт × 500 = 5000
    assert.equal(byId(r, "cup").consumed, 10);
    assert.equal(byId(r, "cup").cost, 5000);
    assert.equal(r.totalCost, 14400 + 18000 + 5000); // = 10 × себестоимость 3740
    assert.equal(r.unresolved, 0);
  });

  it("общий ингредиент двух товаров суммируется, fromProducts=2", () => {
    const sold: SoldProduct[] = [
      { productId: "latte", qty: 10 }, // 180 г зёрен
      { productId: "americano", qty: 5 }, // 70 г зёрен
    ];
    const r = consumptionReport(sold, recipeOf, priceOf);
    // beans: 180+70=250 г → 0.25 кг
    assert.equal(byId(r, "beans").consumed, 0.25);
    assert.equal(byId(r, "beans").fromProducts, 2);
    // cup: 10+5=15 шт
    assert.equal(byId(r, "cup").consumed, 15);
  });

  it("ингредиент без цены: расход сведён, стоимость неполна", () => {
    const noPrice = (id: string): IngredientPrice =>
      id === "beans" ? { price: null, unit: "кг" } : priceOf(id);
    const r = consumptionReport([{ productId: "latte", qty: 10 }], recipeOf, noPrice);
    assert.equal(byId(r, "beans").consumed, 0.18); // сведён
    assert.equal(byId(r, "beans").cost, null); // цены нет
    assert.ok(r.unresolved >= 1);
    assert.equal(byId(r, "milk").cost, 18000); // остальное посчитано
  });

  it("ингредиент без единицы: ни расхода, ни стоимости", () => {
    const noUnit = (id: string): IngredientPrice =>
      id === "beans" ? { price: 80000, unit: null } : priceOf(id);
    const r = consumptionReport([{ productId: "latte", qty: 10 }], recipeOf, noUnit);
    assert.equal(byId(r, "beans").consumed, null);
    assert.equal(byId(r, "beans").cost, null);
    assert.equal(byId(r, "beans").unconvertible, 1);
  });

  it("товар без рецепта не даёт расхода", () => {
    const r = consumptionReport([{ productId: "снек", qty: 100 }], recipeOf, priceOf);
    assert.equal(r.ingredients.length, 0);
    assert.equal(r.totalCost, 0);
  });

  it("нулевое/отрицательное количество игнорируется", () => {
    const r = consumptionReport(
      [{ productId: "latte", qty: 0 }, { productId: "latte", qty: -3 }],
      recipeOf,
      priceOf,
    );
    assert.equal(r.ingredients.length, 0);
  });
});
