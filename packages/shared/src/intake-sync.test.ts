import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planPurchaseIntake, type PurchaseInput, type ResolvedIngredient } from "./intake-sync";

const P = (o: Partial<PurchaseInput> & { id: string; product: string }): PurchaseInput => ({
  source: "stock",
  unit: "кг",
  qty: 5,
  unitPrice: 80000,
  dt: "2026-08-01",
  ...o,
});

describe("Синк прихода: план из закупок", () => {
  const cards: Record<string, ResolvedIngredient> = {
    "зёрна кофе": { ingredientId: "beans", baseUnit: "кг" },
    "молоко": { ingredientId: "milk", baseUnit: "л" },
    "стакан": { ingredientId: "cup", baseUnit: "шт" },
  };
  const resolve = (p: PurchaseInput): ResolvedIngredient | null =>
    cards[p.product.toLowerCase()] ?? null;

  it("сводит закупку к приходу с ключом идемпотентности", () => {
    const plan = planPurchaseIntake([P({ id: "1", product: "Зёрна кофе" })], resolve);
    assert.equal(plan.intakes.length, 1);
    assert.deepEqual(plan.intakes[0], {
      extId: "purchase:1",
      ingredientId: "beans",
      qty: 5,
      unit: "кг",
      unitPrice: 80000,
      dt: "2026-08-01",
    });
  });

  it("единица прихода отличается от базовой, но сводима — принимаем", () => {
    // молоко в мл при базовой «л» — сводимо, приход проходит.
    const plan = planPurchaseIntake([P({ id: "2", product: "Молоко", unit: "мл", qty: 2000 })], resolve);
    assert.equal(plan.intakes.length, 1);
    assert.equal(plan.intakes[0].unit, "мл");
  });

  it("товар без карточки ингредиента — в noCard, не в приход", () => {
    const plan = planPurchaseIntake([P({ id: "3", product: "Сникерс" })], resolve);
    assert.equal(plan.intakes.length, 0);
    assert.deepEqual(plan.noCard, [{ product: "Сникерс", qty: 5 }]);
  });

  it("несводимая единица — в badUnit с причиной", () => {
    // зёрна (базовая «кг») пришли в «л» — вес↔объём не свести.
    const plan = planPurchaseIntake([P({ id: "4", product: "Зёрна кофе", unit: "л" })], resolve);
    assert.equal(plan.intakes.length, 0);
    assert.deepEqual(plan.badUnit, [{ product: "Зёрна кофе", unit: "л" }]);
  });

  it("чужая единица (не из справочника) — в badUnit", () => {
    const plan = planPurchaseIntake([P({ id: "5", product: "Стакан", unit: "pcs" })], resolve);
    assert.equal(plan.intakes.length, 0);
    assert.equal(plan.badUnit.length, 1);
  });

  it("нулевое количество игнорируется молча", () => {
    const plan = planPurchaseIntake([P({ id: "6", product: "Молоко", qty: 0 })], resolve);
    assert.equal(plan.intakes.length, 0);
    assert.equal(plan.noCard.length, 0);
    assert.equal(plan.badUnit.length, 0);
  });

  it("ингредиент без базовой единицы — приход в его единице проходит", () => {
    const noBase = (): ResolvedIngredient => ({ ingredientId: "x", baseUnit: null });
    const plan = planPurchaseIntake([P({ id: "7", product: "Нечто", unit: "шт", qty: 3 })], noBase);
    assert.equal(plan.intakes.length, 1);
    assert.equal(plan.intakes[0].unit, "шт");
  });
});
