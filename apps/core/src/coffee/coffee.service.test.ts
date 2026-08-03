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
  coffeeStock,
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
  stock?: unknown[];
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
    if (t === coffeeStock) return tables.stock ?? [];
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
    if (t === coffeeStock) return "coffee_stock";
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
    transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb(db),
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

  it("цена заведена — считает себестоимость факта и ожидания; цены нет — null, не 0", async () => {
    const refills = [
      { id: "r1", position: 7, containerNumber: 1, ingredientId: "ing-coffee", filledWeight: 1200, measuredBefore: null, enteredDate: "2026-08-01" },
      { id: "r2", position: 7, containerNumber: 1, ingredientId: "ing-coffee", filledWeight: 1200, measuredBefore: 850, enteredDate: "2026-08-02" },
    ];
    const products = [{ id: "prod-americano", name: "Американо", recipe: [{ ingredientId: "ing-coffee", quantity: 18, unit: "г" }] }];
    const sales = [{ locationId: "loc-1", productId: "prod-americano", loggedDate: "2026-08-02", quantity: 20 }];

    const priced = [{ id: "ing-coffee", name: "Кофе", purchasePrice: "80.0000" }];
    const { db: dbPriced } = coffeeDb({ refills, sales, products, ingredients: priced, tare });
    const priced1 = (await new CoffeeService(dbPriced).reconcileLocation("loc-1", "2026-08-01", "2026-08-02")).find(
      (r) => r.ingredientId === "ing-coffee",
    )!;
    assert.equal(priced1.actualGrams, 350);
    assert.equal(priced1.costActual, 28000); // 350 × 80
    assert.equal(priced1.costExpected, 28800); // 360 × 80

    const { db: dbNoPrice } = coffeeDb({ refills, sales, products, ingredients, tare });
    const noPrice = (await new CoffeeService(dbNoPrice).reconcileLocation("loc-1", "2026-08-01", "2026-08-02")).find(
      (r) => r.ingredientId === "ing-coffee",
    )!;
    assert.equal(noPrice.costActual, null, "цена не заведена — себестоимость неизвестна, а не 0");
    assert.equal(noPrice.costExpected, null);
  });
});

describe("CoffeeService: настройки — цена ингредиента", () => {
  it("setIngredientPrice — обновляет цену по id", async () => {
    const { db, updates } = coffeeDb({});
    const svc = new CoffeeService(db);
    await svc.setIngredientPrice("ing-coffee", 82.5);
    assert.equal(updates.length, 1);
    assert.equal(updates[0]!.table, "coffee_ingredient");
    assert.equal((updates[0]!.values as Record<string, unknown>).purchasePrice, "82.5");
  });

  it("bunkerConfig — отдаёт purchasePrice числом, а не строкой numeric", async () => {
    const { db } = coffeeDb({
      bunkerConfig: [{ position: 7, ingredientId: "ing-coffee", ingredientName: "Кофе", purchasePrice: "80.0000" }],
    });
    const svc = new CoffeeService(db);
    const rows = await svc.bunkerConfig();
    assert.equal(rows[0]!.purchasePrice, 80);
    assert.equal(typeof rows[0]!.purchasePrice, "number");
  });
});

describe("CoffeeService: недолив заливки (targetFillWeight/fillStatusByLocation)", () => {
  it("setTargetFillWeight — обновляет эталон по (позиция, ингредиент)", async () => {
    const { db, updates } = coffeeDb({});
    const svc = new CoffeeService(db);
    await svc.setTargetFillWeight(7, "ing-coffee", 600);
    assert.equal(updates.length, 1);
    assert.equal(updates[0]!.table, "coffee_bunker_config");
    assert.equal((updates[0]!.values as Record<string, unknown>).targetFillWeight, 600);
  });

  it("fillStatusByLocation — считает недолив по последней заливке против эталона позиции/ингредиента", async () => {
    const refills = [
      { locationId: "loc-1", locationName: "AH", position: 7, ingredientId: "ing-coffee", containerNumber: 1, filledWeight: 1200, enteredDate: "2026-08-01" },
      // Свежее — заливка почти пустая (недолив): брутто 700, тара 620 → чистый 80 при эталоне 600.
      { locationId: "loc-1", locationName: "AH", position: 7, ingredientId: "ing-coffee", containerNumber: 1, filledWeight: 700, enteredDate: "2026-08-02" },
    ];
    const tare = [{ containerNumber: 1, position: 7, tareWeight: 620 }];
    const bunkerConfig = [{ position: 7, ingredientId: "ing-coffee", ingredientName: "Кофе", targetFillWeight: 600 }];
    const { db } = coffeeDb({ refills, tare, bunkerConfig });
    const svc = new CoffeeService(db);
    const res = await svc.fillStatusByLocation();
    assert.equal(res.length, 1);
    assert.equal(res[0]!.netFillWeight, 80); // 700 − 620, самая свежая заливка
    assert.equal(res[0]!.targetFillWeight, 600);
    assert.equal(res[0]!.status, "underfill");
  });

  it("fillStatusByLocation — эталон не задан → unknown, не молчаливый ok", async () => {
    const refills = [
      { locationId: "loc-1", locationName: "AH", position: 7, ingredientId: "ing-coffee", containerNumber: 1, filledWeight: 1200, enteredDate: "2026-08-01" },
    ];
    const tare = [{ containerNumber: 1, position: 7, tareWeight: 620 }];
    const bunkerConfig = [{ position: 7, ingredientId: "ing-coffee", ingredientName: "Кофе", targetFillWeight: null }];
    const { db } = coffeeDb({ refills, tare, bunkerConfig });
    const svc = new CoffeeService(db);
    const res = await svc.fillStatusByLocation();
    assert.equal(res[0]!.status, "unknown");
  });
});

describe("CoffeeService: склад ингредиентов (ingestCoffeeStock/coffeeStockLevels)", () => {
  it("первый ввод по ингредиенту (в складе строки ещё не было) — не расхождение", async () => {
    const { db, inserts } = coffeeDb({ stock: [], ingredients: [{ id: "ing-1", name: "Кофе", purchasePrice: null }] });
    const svc = new CoffeeService(db);
    const res = await svc.ingestCoffeeStock([{ ingredientId: "ing-1", quantity: 5000 }]);
    assert.deepEqual(res.adjustments, []);
    assert.equal(res.items, 1);
    const stockInsert = inserts.find((i) => i.table === "coffee_stock");
    assert.ok(stockInsert);
    assert.equal((stockInsert!.values as Record<string, unknown>).quantity, 5000);
  });

  it("недостача при пересчёте оценена по цене ингредиента (сум/г)", async () => {
    const stock = [{ ingredientId: "ing-1", quantity: 5000, countedAt: new Date("2026-08-01T00:00:00Z") }];
    const ingredients = [{ id: "ing-1", name: "Кофе", purchasePrice: "0.5000" }];
    const { db } = coffeeDb({ stock, ingredients });
    const svc = new CoffeeService(db);
    const res = await svc.ingestCoffeeStock([{ ingredientId: "ing-1", quantity: 4800 }], "2026-08-02T00:00:00Z");
    assert.equal(res.adjustments.length, 1);
    const a = res.adjustments[0]!;
    assert.equal(a.ingredientName, "Кофе");
    assert.equal(a.before, 5000);
    assert.equal(a.after, 4800);
    assert.equal(a.delta, -200);
    assert.equal(a.value, 100); // 200 г × 0.5 сум/г
    assert.equal(a.noPrice, false);
  });

  it("без цены у ингредиента — value 0, noPrice=true, но расхождение видно (unknown ≠ zero)", async () => {
    const stock = [{ ingredientId: "ing-1", quantity: 1000, countedAt: new Date("2026-08-01T00:00:00Z") }];
    const ingredients = [{ id: "ing-1", name: "Матча", purchasePrice: null }];
    const { db } = coffeeDb({ stock, ingredients });
    const svc = new CoffeeService(db);
    const res = await svc.ingestCoffeeStock([{ ingredientId: "ing-1", quantity: 900 }], "2026-08-02T00:00:00Z");
    assert.equal(res.adjustments[0]!.value, 0);
    assert.equal(res.adjustments[0]!.noPrice, true);
  });

  it("количество не изменилось — не расхождение, но остаток всё равно перезаписывается", async () => {
    const stock = [{ ingredientId: "ing-1", quantity: 1000, countedAt: new Date("2026-08-01T00:00:00Z") }];
    const ingredients = [{ id: "ing-1", name: "Сахар", purchasePrice: "0.1" }];
    const { db, inserts } = coffeeDb({ stock, ingredients });
    const svc = new CoffeeService(db);
    const res = await svc.ingestCoffeeStock([{ ingredientId: "ing-1", quantity: 1000 }], "2026-08-02T00:00:00Z");
    assert.deepEqual(res.adjustments, []);
    assert.ok(inserts.some((i) => i.table === "coffee_stock"));
  });

  it("опоздавший пересчёт (countedAt старше уже сохранённого) — пропускается целиком", async () => {
    const stock = [{ ingredientId: "ing-1", quantity: 1000, countedAt: new Date("2026-08-02T12:00:00Z") }];
    const ingredients = [{ id: "ing-1", name: "Кофе", purchasePrice: "0.5" }];
    const { db, inserts } = coffeeDb({ stock, ingredients });
    const svc = new CoffeeService(db);
    const res = await svc.ingestCoffeeStock(
      [{ ingredientId: "ing-1", quantity: 1 }],
      "2026-08-02T09:00:00Z", // раньше уже сохранённого 12:00
    );
    assert.deepEqual(res.adjustments, []);
    assert.equal(inserts.length, 0);
  });

  it("coffeeStockLevels — отдаёт остаток по всем ингредиентам, отсортированный по имени", async () => {
    const stock = [
      { ingredientId: "ing-2", quantity: 300, countedAt: new Date("2026-08-02T00:00:00Z") },
      { ingredientId: "ing-1", quantity: 5000, countedAt: new Date("2026-08-02T00:00:00Z") },
    ];
    const ingredients = [
      { id: "ing-1", name: "Кофе" },
      { id: "ing-2", name: "Ароматизатор" },
    ];
    const { db } = coffeeDb({ stock, ingredients });
    const svc = new CoffeeService(db);
    const res = await svc.coffeeStockLevels();
    assert.equal(res.length, 2);
    assert.equal(res[0]!.ingredientName, "Ароматизатор");
    assert.equal(res[1]!.ingredientName, "Кофе");
  });
});
