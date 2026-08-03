import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  coffeeBunkerConfig,
  coffeeConsumable,
  coffeeContainerTare,
  coffeeIngredient,
  coffeeLocation,
  coffeeProduct,
  coffeeRefill,
  coffeeSale,
  coffeeWashLog,
} from "@mydon/db";
import { CoffeeService } from "./coffee.service";

/**
 * Стаб БД: различает таблицы по ссылке (тот же приём, что и в
 * vending.service.test.ts). `.where()`/`.orderBy()`/`.limit()` НЕ фильтруют —
 * тесты кормят уже подходящие строки, как и остальные стабы в этом репо;
 * insert/update/delete копят вызовы для проверки.
 */
function coffeeDb(tables: {
  locations?: unknown[];
  bunkerConfig?: unknown[];
  ingredients?: unknown[];
  tare?: unknown[];
  refills?: unknown[];
  sales?: unknown[];
  products?: unknown[];
  consumables?: unknown[];
  washLog?: unknown[];
}) {
  const inserts: { table: string; values: unknown }[] = [];
  const updates: { table: string; values: unknown }[] = [];
  const deletes: { table: string }[] = [];

  const tableOf = (t: unknown): unknown[] => {
    if (t === coffeeLocation) return tables.locations ?? [];
    if (t === coffeeBunkerConfig) return tables.bunkerConfig ?? [];
    if (t === coffeeIngredient) return tables.ingredients ?? [];
    if (t === coffeeContainerTare) return tables.tare ?? [];
    if (t === coffeeRefill) return tables.refills ?? [];
    if (t === coffeeSale) return tables.sales ?? [];
    if (t === coffeeProduct) return tables.products ?? [];
    if (t === coffeeConsumable) return tables.consumables ?? [];
    if (t === coffeeWashLog) return tables.washLog ?? [];
    return [];
  };
  const nameOf = (t: unknown): string => {
    if (t === coffeeLocation) return "coffee_location";
    if (t === coffeeBunkerConfig) return "coffee_bunker_config";
    if (t === coffeeIngredient) return "coffee_ingredient";
    if (t === coffeeContainerTare) return "coffee_container_tare";
    if (t === coffeeRefill) return "coffee_refill";
    if (t === coffeeSale) return "coffee_sale";
    if (t === coffeeConsumable) return "coffee_consumable";
    if (t === coffeeWashLog) return "coffee_wash_log";
    if (t === coffeeProduct) return "coffee_product";
    return "unknown";
  };

  const selectChain = (t: unknown) => {
    const rows = tableOf(t);
    const chain = {
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve(rows),
      innerJoin: () => chain,
      then: (resolve: (v: unknown[]) => void) => resolve(rows),
    };
    return chain;
  };

  const db = {
    select: (_cols?: unknown) => ({ from: (t: unknown) => selectChain(t) }),
    insert: (t: unknown) => ({
      values: (v: unknown) => {
        inserts.push({ table: nameOf(t), values: v });
        return {
          returning: async () => (Array.isArray(v) ? v : [v]).map((row, i) => ({ id: `new-${nameOf(t)}-${i}`, ...(row as object) })),
          onConflictDoNothing: async () => undefined,
          onConflictDoUpdate: async () => undefined,
        };
      },
    }),
    update: (t: unknown) => ({
      set: (v: unknown) => ({
        where: async () => {
          updates.push({ table: nameOf(t), values: v });
          return undefined;
        },
      }),
    }),
    delete: (t: unknown) => ({
      where: async () => {
        deletes.push({ table: nameOf(t) });
        return undefined;
      },
    }),
  } as never;

  return { db, inserts, updates, deletes };
}

describe("CoffeeService: настройки — ингредиенты по позиции бункера", () => {
  it("новый ингредиент — заводит его и добавляет назначение на позицию", async () => {
    const { db, inserts } = coffeeDb({ ingredients: [] });
    const svc = new CoffeeService(db);
    await svc.addBunkerIngredient(3, "Матча");
    const ingredientInsert = inserts.find((i) => i.table === "coffee_ingredient");
    assert.ok(ingredientInsert, "должен завести ингредиент");
    const configInsert = inserts.find((i) => i.table === "coffee_bunker_config");
    assert.ok(configInsert, "должен добавить назначение на позицию");
  });

  it("ингредиент уже есть — не заводит второй раз, только назначение на позицию", async () => {
    const { db, inserts } = coffeeDb({ ingredients: [{ id: "ing-1", name: "Кофе" }] });
    const svc = new CoffeeService(db);
    const res = await svc.addBunkerIngredient(7, "Кофе");
    assert.equal(res.ingredientId, "ing-1");
    assert.ok(!inserts.some((i) => i.table === "coffee_ingredient"), "не должен дублировать ингредиент");
    assert.ok(inserts.some((i) => i.table === "coffee_bunker_config"));
  });

  it("removeBunkerIngredient — удаляет строку назначения", async () => {
    const { db, deletes } = coffeeDb({});
    const svc = new CoffeeService(db);
    await svc.removeBunkerIngredient(3, "ing-1");
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0]!.table, "coffee_bunker_config");
  });
});

describe("CoffeeService: ввод данных — заливка бункера", () => {
  it("submitRefill — дефолты: packageCount=1, необязательные поля null", async () => {
    const { db, inserts } = coffeeDb({});
    const svc = new CoffeeService(db);
    await svc.submitRefill({ locationId: "loc-1", position: 1, filledWeight: 1200, enteredDate: "2026-08-03" });
    const row = inserts.find((i) => i.table === "coffee_refill")!.values as Record<string, unknown>;
    assert.equal(row.packageCount, 1);
    assert.equal(row.containerNumber, null);
    assert.equal(row.measuredBefore, null);
    assert.equal(row.filledWeight, 1200);
  });

  it("recordConsumable — upsert по (точка, дата), дефолты нулевые", async () => {
    const { db, inserts } = coffeeDb({});
    const svc = new CoffeeService(db);
    await svc.recordConsumable({ locationId: "loc-1", loggedDate: "2026-08-03" });
    const row = inserts.find((i) => i.table === "coffee_consumable")!.values as Record<string, unknown>;
    assert.equal(row.water, 0);
    assert.equal(row.cups, 0);
    assert.equal(row.lids, 0);
  });
});

describe("CoffeeService: сводная таблица по точкам", () => {
  it("locationSummary — последняя заливка на (точка, позиция), точки без заливок тоже видны", async () => {
    const { db } = coffeeDb({
      locations: [{ id: "l1", name: "AH", sortOrder: 0, isActive: true }, { id: "l2", name: "Grand clinic", sortOrder: 1, isActive: true }],
      refills: [
        { locationName: "AH", position: 1, packageCount: 1, filledWeight: 600, enteredDate: "2026-08-01" },
        { locationName: "AH", position: 1, packageCount: 2, filledWeight: 1200, enteredDate: "2026-08-02" }, // свежее — должна остаться эта
      ],
    });
    const svc = new CoffeeService(db);
    const rows = await svc.locationSummary();
    const ah = rows.find((r) => r.location === "AH")!;
    assert.deepEqual(ah.byPosition[1], { packageCount: 2, weight: 1200 });
    const grand = rows.find((r) => r.location === "Grand clinic")!;
    assert.deepEqual(grand.byPosition, {});
  });
});

describe("CoffeeService: сверка факт/ожидание (reconcileLocation)", () => {
  const tare = [
    { containerNumber: 1, position: 7, tareWeight: 620 },
    { containerNumber: 2, position: 7, tareWeight: 630 },
  ];
  const ingredients = [{ id: "ing-coffee", name: "Кофе" }];

  it("две заливки подряд одного ингредиента на позиции — фактический расход считается", async () => {
    const refills = [
      // Заливка 1: досыпали до 1200г брутто (набор 1, тара 620) → чистый 580.
      { id: "r1", position: 7, containerNumber: 1, ingredientId: "ing-coffee", filledWeight: 1200, measuredBefore: null, enteredDate: "2026-08-01" },
      // Заливка 2 в тот же день диапазона: перед досыпкой застали 820г брутто (набор 1, тара 620) → чистый 200.
      { id: "r2", position: 7, containerNumber: 1, ingredientId: "ing-coffee", filledWeight: 1200, measuredBefore: 820, enteredDate: "2026-08-02" },
    ];
    const { db } = coffeeDb({ refills, sales: [], products: [], ingredients, tare });
    const svc = new CoffeeService(db);
    const res = await svc.reconcileLocation("loc-1", "2026-08-01", "2026-08-02");
    const coffee = res.find((r) => r.ingredientId === "ing-coffee")!;
    assert.equal(coffee.actualGrams, 380); // 580 − 200
    assert.equal(coffee.expectedGrams, null); // продаж не было
    assert.equal(coffee.reconcile.status, "unknown"); // нечем сверить без ожидания
  });

  it("ингредиент сменился между заливками на той же позиции — расход НЕ считается (не путаем ингредиенты)", async () => {
    const refills = [
      { id: "r1", position: 3, containerNumber: 1, ingredientId: "ing-lemon", filledWeight: 630, measuredBefore: null, enteredDate: "2026-08-01" },
      { id: "r2", position: 3, containerNumber: 1, ingredientId: "ing-matcha", filledWeight: 630, measuredBefore: 100, enteredDate: "2026-08-02" },
    ];
    const { db } = coffeeDb({ refills, sales: [], products: [], ingredients: [{ id: "ing-lemon", name: "Лимонный чай" }, { id: "ing-matcha", name: "Матча" }], tare: [] });
    const svc = new CoffeeService(db);
    const res = await svc.reconcileLocation("loc-1", "2026-08-01", "2026-08-02");
    assert.deepEqual(res, []); // ни по одному ингредиенту нет ни факта, ни ожидания
  });

  it("продажи × рецепт дают ожидание, факт из веса — сверка сходится (ok)", async () => {
    const refills = [
      { id: "r1", position: 7, containerNumber: 1, ingredientId: "ing-coffee", filledWeight: 1200, measuredBefore: null, enteredDate: "2026-08-01" },
      { id: "r2", position: 7, containerNumber: 1, ingredientId: "ing-coffee", filledWeight: 1200, measuredBefore: 850, enteredDate: "2026-08-02" },
    ];
    // Расход факт: (1200−620) − (850−620) = 580 − 230 = 350г.
    // 20 чашек американо × 18г кофе = 360г ожидания — расхождение 10/360 ≈ 2.8%, в пределах порога.
    const products = [{ id: "prod-americano", name: "Американо", recipe: [{ ingredientId: "ing-coffee", quantity: 18, unit: "г" }] }];
    const sales = [{ locationId: "loc-1", productId: "prod-americano", loggedDate: "2026-08-02", quantity: 20 }];
    const { db } = coffeeDb({ refills, sales, products, ingredients, tare });
    const svc = new CoffeeService(db);
    const res = await svc.reconcileLocation("loc-1", "2026-08-01", "2026-08-02");
    const coffee = res.find((r) => r.ingredientId === "ing-coffee")!;
    assert.equal(coffee.actualGrams, 350);
    assert.equal(coffee.expectedGrams, 360);
    assert.equal(coffee.reconcile.status, "ok");
  });

  it("расхождение сверх порога — anomaly", async () => {
    const refills = [
      { id: "r1", position: 7, containerNumber: 1, ingredientId: "ing-coffee", filledWeight: 1200, measuredBefore: null, enteredDate: "2026-08-01" },
      // Почти всё выгребли (мало осталось до досыпки) — фактический расход намного больше ожидаемого.
      { id: "r2", position: 7, containerNumber: 1, ingredientId: "ing-coffee", filledWeight: 1200, measuredBefore: 630, enteredDate: "2026-08-02" },
    ];
    // Факт: 580 − 10 = 570г. Ожидание: 5 чашек × 18г = 90г — расход втрое больше ожидания.
    const products = [{ id: "prod-americano", name: "Американо", recipe: [{ ingredientId: "ing-coffee", quantity: 18, unit: "г" }] }];
    const sales = [{ locationId: "loc-1", productId: "prod-americano", loggedDate: "2026-08-02", quantity: 5 }];
    const { db } = coffeeDb({ refills, sales, products, ingredients, tare });
    const svc = new CoffeeService(db);
    const res = await svc.reconcileLocation("loc-1", "2026-08-01", "2026-08-02");
    const coffee = res.find((r) => r.ingredientId === "ing-coffee")!;
    assert.equal(coffee.reconcile.status, "anomaly");
  });
});
