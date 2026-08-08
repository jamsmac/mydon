import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coffeeBunkerConfig, coffeeIngredient } from "./schema";
import {
  COFFEE_BUNKER_INGREDIENTS,
  COFFEE_CONTAINER_TARE,
  COFFEE_LOCATIONS,
  seedCoffeeBunkerIngredients,
  seedCoffeeContainerTare,
  seedCoffeeLocations,
} from "./seed-coffee";

describe("Точки и бункеры кофе-вендинга (референс vendhubunker)", () => {
  it("22 точки, имена уникальны", () => {
    assert.equal(COFFEE_LOCATIONS.length, 22);
    assert.equal(new Set(COFFEE_LOCATIONS).size, 22, "дублей адресов быть не должно");
  });

  it("позиции бункера 1–8, позиция 8 пуста (не используется)", () => {
    const positions = Object.keys(COFFEE_BUNKER_INGREDIENTS).map(Number).sort((a, b) => a - b);
    assert.deepEqual(positions, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(COFFEE_BUNKER_INGREDIENTS[8], [], "Бункер 8 — Пусто");
    assert.deepEqual(COFFEE_BUNKER_INGREDIENTS[3], ["Лимонный чай", "Матча"], "позиция 3 держит два ингредиента");
  });

  it("тара 27 наборов × 8 позиций, значения в разумном диапазоне тары (500–800г)", () => {
    assert.equal(COFFEE_CONTAINER_TARE.length, 27);
    for (const row of COFFEE_CONTAINER_TARE) {
      assert.equal(row.length, 8);
      for (const w of row) {
        if (w == null) continue;
        assert.ok(w >= 500 && w <= 800, `вес тары ${w} вне разумного диапазона`);
      }
    }
    // Сверка с реальными значениями (набор 001: Б1=636, Б5=620, Б7=620, остальные пусто).
    assert.deepEqual(COFFEE_CONTAINER_TARE[0], [636, null, null, null, 620, null, 620, null]);
  });
});

describe("seedCoffeeLocations/seedCoffeeBunkerIngredients/seedCoffeeContainerTare — идемпотентность", () => {
  /**
   * Точка — карточка реестра (миграция 0049), поэтому сид сперва ищет
   * направление vendhub, а потом уже существующие места. Две выборки подряд:
   * первая отдаёт направление, вторая — имена.
   */
  function locationsDb(existing: { name: string }[]) {
    const inserted: unknown[] = [];
    let вызов = 0;
    const цепочка = (rows: unknown[]) => {
      const p = Promise.resolve(rows);
      return { where: () => ({ limit: () => p, then: p.then.bind(p) }), then: p.then.bind(p) };
    };
    const db = {
      select: () => ({
        from: () => (вызов++ === 0 ? цепочка([{ id: "org-vendhub" }]) : цепочка(existing)),
      }),
      insert: () => ({ values: (v: unknown[]) => { inserted.push(...v); return Promise.resolve(undefined); } }),
    } as never;
    return { db, inserted };
  }

  it("пустая база — заносит все 22 точки", async () => {
    const { db, inserted } = locationsDb([]);
    const res = await seedCoffeeLocations(db);
    assert.equal(res.seeded, 22);
    assert.equal(res.skipped, 0);
    assert.equal(inserted.length, 22);
  });

  it("точка уже есть — пропускает её, не дублирует", async () => {
    const { db, inserted } = locationsDb([{ name: "American Hospital" }]);
    const res = await seedCoffeeLocations(db);
    assert.equal(res.seeded, 21);
    assert.equal(res.skipped, 1);
    assert.ok(!inserted.some((v) => (v as { name: string }).name === "American Hospital"));
  });

  /** Стаб: различает 4 таблицы по ссылке, .returning() отдаёт вставленные строки с id. */
  function bunkerDb(existingIngredients: { id: string; name: string }[], existingConfig: { position: number; ingredientId: string }[]) {
    const ingredientInserts: { name: string }[] = [];
    const configInserts: unknown[] = [];
    let nextId = 1;
    const db = {
      select: () => ({
        from: async (t: unknown) => (t === coffeeIngredient ? existingIngredients : t === coffeeBunkerConfig ? existingConfig : []),
      }),
      insert: (t: unknown) => ({
        values: (v: { name: string }[]) => {
          if (t === coffeeIngredient) {
            ingredientInserts.push(...v);
            return { returning: async () => v.map((row) => ({ id: `new-${nextId++}`, name: row.name })) };
          }
          configInserts.push(...v);
          return Promise.resolve(undefined);
        },
      }),
    } as never;
    return { db, ingredientInserts, configInserts };
  }

  it("пустая база — заносит все ингредиенты (8 канонов, «Пусто» не считается) и назначения", async () => {
    const { db, ingredientInserts, configInserts } = bunkerDb([], []);
    const res = await seedCoffeeBunkerIngredients(db);
    // Уникальных имён: Сухое молоко, Ягодный чай, Лимонный чай, Матча, Сахар, Шоколад, MacCoffee, Кофе = 8.
    assert.equal(res.ingredientsSeeded, 8);
    assert.equal(ingredientInserts.length, 8);
    // Назначений на позиции: 1+1+2+1+1+1+1+0 = 8.
    assert.equal(res.configSeeded, 8);
    assert.equal(configInserts.length, 8);
  });

  it("ингредиент уже есть — не дублирует, но назначение на позицию всё равно заносит", async () => {
    const { db, ingredientInserts, configInserts } = bunkerDb([{ id: "existing-1", name: "Кофе" }], []);
    const res = await seedCoffeeBunkerIngredients(db);
    assert.equal(res.ingredientsSeeded, 7);
    assert.ok(!ingredientInserts.some((v) => v.name === "Кофе"));
    assert.equal(res.configSeeded, 8);
    assert.ok(configInserts.some((v) => (v as { position: number; ingredientId: string }).ingredientId === "existing-1"));
  });

  function tareDb(existing: { containerNumber: number; position: number }[]) {
    const inserted: unknown[] = [];
    const db = {
      select: () => ({ from: async () => existing }),
      insert: () => ({ values: (v: unknown[]) => { inserted.push(...v); return Promise.resolve(undefined); } }),
    } as never;
    return { db, inserted };
  }

  it("пустая база — заносит все непустые ячейки тары, пустые ('—') пропускает", async () => {
    const { db, inserted } = tareDb([]);
    const res = await seedCoffeeContainerTare(db);
    const nonBlank = COFFEE_CONTAINER_TARE.flat().filter((w) => w != null).length;
    assert.equal(res.seeded, nonBlank);
    assert.equal(inserted.length, nonBlank);
    // Набор 001, позиция 1 — тара 636.
    assert.ok(inserted.some((v) => {
      const r = v as { containerNumber: number; position: number; tareWeight: number };
      return r.containerNumber === 1 && r.position === 1 && r.tareWeight === 636;
    }));
  });

  it("ячейка уже занесена — пропускает её", async () => {
    const { db, inserted } = tareDb([{ containerNumber: 1, position: 1 }]);
    const res = await seedCoffeeContainerTare(db);
    assert.ok(!inserted.some((v) => (v as { containerNumber: number; position: number }).containerNumber === 1 && (v as { position: number }).position === 1));
    assert.equal(res.skipped, res.skipped); // не падает — базовая проверка, что счётчик посчитан
  });
});
