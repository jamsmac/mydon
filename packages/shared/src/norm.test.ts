import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normFor, parseNormRecipe, type NormRecipeLine } from "./norm";

describe("Норма расхода из состава карточки (срез F, задача 1)", () => {
  it("состав переводится в норму на партию чашек", () => {
    const r = parseNormRecipe([{ ingredient: "Кофе", qty: 8, unit: "г" }]) as NormRecipeLine[];
    const n = normFor(r, 100);
    assert.deepEqual(n.get("Кофе"), { qty: 800, unit: "г" });
  });

  it("штуки не превращаются в граммы", () => {
    // Стакан считается в штуках. Зашитая «г» теряла крупнейшую статью (факт 11).
    const n = normFor([{ ingredient: "Стакан", qty: 1, unit: "шт" }], 25252);
    assert.deepEqual(n.get("Стакан"), { qty: 25252, unit: "шт" });
  });

  it("пустой состав — не норма ноль, а признак отсутствия рецепта", () => {
    const r = parseNormRecipe(null);
    assert.ok("error" in r, "нет состава — это «не знаем», а не «ноль граммов»");
  });

  it("отрицательное количество в составе — ошибка ввода", () => {
    assert.ok("error" in parseNormRecipe([{ ingredient: "Кофе", qty: -8, unit: "г" }]));
  });
});
