import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  auditLog,
  coffeeBunkerConfig,
  coffeeConsumable,
  coffeeContainerReturn,
  coffeeContainerTare,
  coffeeIngredient,
  coffeeLocation,
  coffeeMachinePlacement,
  coffeeProduct,
  coffeeRefill,
  coffeeSale,
  coffeeStock,
  coffeeWashLog,
  coffeeWashSchedule,
  entity,
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
  washSchedule?: unknown[];
  /** Карточки реестра (entity) — кандидаты привязки точек. */
  registry?: unknown[];
  returns?: unknown[];
  /** История размещений аппарат↔точка (открытые = endDate null). */
  placements?: unknown[];
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
    if (t === coffeeWashSchedule) return tables.washSchedule ?? [];
    if (t === entity) return tables.registry ?? [];
    if (t === coffeeContainerReturn) return tables.returns ?? [];
    if (t === coffeeMachinePlacement) return tables.placements ?? [];
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
    if (t === coffeeWashSchedule) return "coffee_wash_schedule";
    if (t === entity) return "entity";
    if (t === coffeeContainerReturn) return "coffee_container_return";
    if (t === coffeeMachinePlacement) return "coffee_machine_placement";
    if (t === auditLog) return "audit_log";
    return "unknown";
  };

  const selectChain = (t: unknown) => {
    const rows = tableOf(t);
    const chain = {
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve(rows),
      innerJoin: () => chain,
      leftJoin: () => chain,
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

describe("CoffeeService: сверка по всем точкам сразу (reconcileAllLocations)", () => {
  const tare = [{ containerNumber: 1, position: 7, tareWeight: 620 }];
  const ingredients = [{ id: "ing-coffee", name: "Кофе" }];
  const products = [{ id: "prod-americano", name: "Американо", recipe: [{ ingredientId: "ing-coffee", quantity: 18, unit: "г" }] }];
  const locations = [
    { id: "loc-1", name: "AH", sortOrder: 0, isActive: true },
    { id: "loc-2", name: "Grand clinic", sortOrder: 1, isActive: true },
  ];

  it("группирует сверку по точкам, точки без данных в периоде не попадают в ответ", async () => {
    const refills = [
      { id: "r1", locationId: "loc-1", position: 7, containerNumber: 1, ingredientId: "ing-coffee", filledWeight: 1200, measuredBefore: null, enteredDate: "2026-08-01" },
      { id: "r2", locationId: "loc-1", position: 7, containerNumber: 1, ingredientId: "ing-coffee", filledWeight: 1200, measuredBefore: 630, enteredDate: "2026-08-02" },
    ];
    // Факт loc-1: 580 − 10 = 570г. Ожидание: 5 × 18 = 90г — аномалия.
    const sales = [{ locationId: "loc-1", productId: "prod-americano", loggedDate: "2026-08-02", quantity: 5 }];
    const { db } = coffeeDb({ refills, sales, products, ingredients, tare, locations });
    const svc = new CoffeeService(db);
    const res = await svc.reconcileAllLocations("2026-08-01", "2026-08-02");
    assert.equal(res.length, 1, "loc-2 без заливок/продаж — сверять нечего");
    assert.equal(res[0]!.locationId, "loc-1");
    assert.equal(res[0]!.locationName, "AH");
    const coffee = res[0]!.rows.find((r) => r.ingredientId === "ing-coffee")!;
    assert.equal(coffee.reconcile.status, "anomaly");
  });

  it("две точки с данными — каждая своей группой, факт не путается между точками", async () => {
    const refills = [
      { id: "r1", locationId: "loc-1", position: 7, containerNumber: 1, ingredientId: "ing-coffee", filledWeight: 1200, measuredBefore: null, enteredDate: "2026-08-01" },
      { id: "r2", locationId: "loc-1", position: 7, containerNumber: 1, ingredientId: "ing-coffee", filledWeight: 1200, measuredBefore: 850, enteredDate: "2026-08-02" },
      { id: "r3", locationId: "loc-2", position: 7, containerNumber: 1, ingredientId: "ing-coffee", filledWeight: 1200, measuredBefore: null, enteredDate: "2026-08-01" },
      { id: "r4", locationId: "loc-2", position: 7, containerNumber: 1, ingredientId: "ing-coffee", filledWeight: 1200, measuredBefore: 850, enteredDate: "2026-08-02" },
    ];
    // Обе точки: факт 350г. loc-1 — 20 чашек (ожидание 360, ok). loc-2 — 5 чашек (ожидание 90, anomaly).
    const sales = [
      { locationId: "loc-1", productId: "prod-americano", loggedDate: "2026-08-02", quantity: 20 },
      { locationId: "loc-2", productId: "prod-americano", loggedDate: "2026-08-02", quantity: 5 },
    ];
    const { db } = coffeeDb({ refills, sales, products, ingredients, tare, locations });
    const svc = new CoffeeService(db);
    const res = await svc.reconcileAllLocations("2026-08-01", "2026-08-02");
    assert.equal(res.length, 2);
    const g1 = res.find((g) => g.locationId === "loc-1")!;
    const g2 = res.find((g) => g.locationId === "loc-2")!;
    assert.equal(g1.rows.find((r) => r.ingredientId === "ing-coffee")!.reconcile.status, "ok");
    assert.equal(g2.rows.find((r) => r.ingredientId === "ing-coffee")!.reconcile.status, "anomaly");
  });

  it("факт из возвратов наборов: без «замеров до» сверка всё равно считается", async () => {
    // Одна заливка без measuredBefore (как вся импортированная история) +
    // возврат набора. Строки несут ключи обеих выборок сервиса:
    // enteredDate (сырая) и date/locationName (джойн containerActuals).
    const refills = [
      {
        id: "r1", locationId: "loc-1", position: 7, containerNumber: 1, ingredientId: null,
        filledWeight: 1200, measuredBefore: null, enteredDate: "2026-08-01",
        date: "2026-08-01", locationName: "AH",
      },
    ];
    const returns = [{ position: 7, containerNumber: 1, weight: 630, returnedDate: "2026-08-02" }];
    const bunkerConfig = [
      { position: 7, ingredientId: "ing-coffee", ingredientName: "Кофе", purchasePrice: null, targetFillWeight: null },
    ];
    // Факт: нетто 580 − нетто 10 = 570г. Ожидание: 5 × 18 = 90г — аномалия.
    const sales = [{ locationId: "loc-1", productId: "prod-americano", loggedDate: "2026-08-02", quantity: 5 }];
    const { db } = coffeeDb({ refills, returns, bunkerConfig, sales, products, ingredients, tare, locations });
    const svc = new CoffeeService(db);
    const res = await svc.reconcileAllLocations("2026-08-01", "2026-08-02");
    const coffee = res.find((g) => g.locationId === "loc-1")!.rows.find((r) => r.ingredientId === "ing-coffee")!;
    assert.equal(coffee.actualGrams, 570, "факт пришёл из пары заливка→возврат, а не из замеров");
    assert.equal(coffee.reconcile.status, "anomaly");
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

describe("CoffeeService: расписание мойки (washSchedule*)", () => {
  const DAY = 86_400_000;
  const locations = [{ id: "loc-1", name: "AH", sortOrder: 0, isActive: true }];

  it("setWashSchedule — без хотя бы одной частоты бросает ошибку", async () => {
    const { db } = coffeeDb({});
    const svc = new CoffeeService(db);
    await assert.rejects(svc.setWashSchedule({ locationId: "loc-1", position: 7 }));
  });

  it("setWashSchedule — новый план (нет существующего) заводит строку", async () => {
    const { db, inserts } = coffeeDb({ locations, washSchedule: [] });
    const svc = new CoffeeService(db);
    const res = await svc.setWashSchedule({ locationId: "loc-1", position: 7, frequencyDays: 7 });
    assert.equal(res.locationName, "AH");
    assert.equal(res.frequencyDays, 7);
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0]!.table, "coffee_wash_schedule");
  });

  it("setWashSchedule — существующий план (та же точка/бункер) обновляется, не дублируется", async () => {
    const { db, inserts, updates } = coffeeDb({
      locations,
      washSchedule: [{ id: "sched-1", locationId: "loc-1", position: 7, frequencyDays: 7, frequencyCups: null, isActive: true, notes: null }],
    });
    const svc = new CoffeeService(db);
    const res = await svc.setWashSchedule({ locationId: "loc-1", position: 7, frequencyDays: 10 });
    assert.equal(res.id, "sched-1");
    assert.equal(inserts.length, 0, "не должен дублировать план");
    assert.equal(updates.length, 1);
    assert.equal((updates[0]!.values as Record<string, unknown>).frequencyDays, 10);
  });

  it("removeWashSchedule — неизвестный id бросает 404, не молчаливый успех", async () => {
    const { db } = coffeeDb({ washSchedule: [] });
    const svc = new CoffeeService(db);
    await assert.rejects(svc.removeWashSchedule("missing-id"));
  });

  it("removeWashSchedule — известный id удаляет и подтверждает", async () => {
    const { db, deletes } = coffeeDb({ washSchedule: [{ id: "sched-1" }] });
    const svc = new CoffeeService(db);
    const res = await svc.removeWashSchedule("sched-1");
    assert.deepEqual(res, { ok: true });
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0]!.table, "coffee_wash_schedule");
  });

  it("washScheduleStatus — по дням: не мыли ни разу → overdue сразу (не 'ok' по умолчанию)", async () => {
    const washSchedule = [{ id: "s1", locationId: "loc-1", position: 7, frequencyDays: 7, frequencyCups: null, isActive: true, notes: null }];
    const { db } = coffeeDb({ locations, washSchedule, washLog: [], sales: [] });
    const svc = new CoffeeService(db);
    const [row] = await svc.washScheduleStatus();
    assert.equal(row!.status, "overdue");
    assert.equal(row!.lastWashAt, null);
    assert.equal(row!.nextDueAt, null, "эталонной даты без факта мойки нет");
  });

  it("washScheduleStatus — по дням: помыли недавно → ok, срок посчитан от последней мойки", async () => {
    const lastWash = new Date(Date.now() - 2 * DAY);
    const washSchedule = [{ id: "s1", locationId: "loc-1", position: 7, frequencyDays: 7, frequencyCups: null, isActive: true, notes: null }];
    const washLog = [{ locationId: "loc-1", position: 7, performedAt: lastWash }];
    const { db } = coffeeDb({ locations, washSchedule, washLog, sales: [] });
    const svc = new CoffeeService(db);
    const [row] = await svc.washScheduleStatus();
    assert.equal(row!.status, "ok");
    assert.equal(row!.daysSinceWash, 2);
    assert.equal(row!.nextDueAt, new Date(lastWash.getTime() + 7 * DAY).toISOString());
  });

  it("washScheduleStatus — по дням: срок вышел → overdue", async () => {
    const lastWash = new Date(Date.now() - 10 * DAY);
    const washSchedule = [{ id: "s1", locationId: "loc-1", position: 7, frequencyDays: 7, frequencyCups: null, isActive: true, notes: null }];
    const washLog = [{ locationId: "loc-1", position: 7, performedAt: lastWash }];
    const { db } = coffeeDb({ locations, washSchedule, washLog, sales: [] });
    const svc = new CoffeeService(db);
    const [row] = await svc.washScheduleStatus();
    assert.equal(row!.status, "overdue");
  });

  it("washScheduleStatus — по чашкам: считает продажи ТОЛЬКО после дня последней мойки", async () => {
    const lastWash = new Date(Date.now() - 3 * DAY);
    const lastWashDay = lastWash.toISOString().slice(0, 10);
    const dayBefore = new Date(lastWash.getTime() - DAY).toISOString().slice(0, 10);
    const dayAfter = new Date(lastWash.getTime() + DAY).toISOString().slice(0, 10);
    const washSchedule = [{ id: "s1", locationId: "loc-1", position: null, frequencyDays: null, frequencyCups: 50, isActive: true, notes: null }];
    const washLog = [{ locationId: "loc-1", position: null, performedAt: lastWash }];
    const sales = [
      { locationId: "loc-1", loggedDate: dayBefore, quantity: 999 }, // до мойки — не считается
      { locationId: "loc-1", loggedDate: lastWashDay, quantity: 999 }, // в день мойки — не считается (см. docstring)
      { locationId: "loc-1", loggedDate: dayAfter, quantity: 30 },
    ];
    const { db } = coffeeDb({ locations, washSchedule, washLog, sales });
    const svc = new CoffeeService(db);
    const [row] = await svc.washScheduleStatus();
    assert.equal(row!.cupsSinceWash, 30);
    assert.equal(row!.status, "ok"); // 30 < 50
  });

  it("washScheduleStatus — по чашкам: превышен порог → overdue, даже если по дням ещё рано", async () => {
    const lastWash = new Date(Date.now() - DAY);
    const dayAfter = new Date(lastWash.getTime() + DAY).toISOString().slice(0, 10);
    const washSchedule = [{ id: "s1", locationId: "loc-1", position: null, frequencyDays: 30, frequencyCups: 50, isActive: true, notes: null }];
    const washLog = [{ locationId: "loc-1", position: null, performedAt: lastWash }];
    const sales = [{ locationId: "loc-1", loggedDate: dayAfter, quantity: 60 }];
    const { db } = coffeeDb({ locations, washSchedule, washLog, sales });
    const svc = new CoffeeService(db);
    const [row] = await svc.washScheduleStatus();
    assert.equal(row!.status, "overdue");
  });

  it("washSchedules — список планов отдаёт всё, включая выключенные", async () => {
    const washSchedule = [
      { id: "s1", locationId: "loc-1", locationName: "AH", position: 7, frequencyDays: 7, frequencyCups: null, isActive: true, notes: null },
      { id: "s2", locationId: "loc-1", locationName: "AH", position: null, frequencyDays: 14, frequencyCups: null, isActive: false, notes: null },
    ];
    const { db } = coffeeDb({ washSchedule });
    const svc = new CoffeeService(db);
    const res = await svc.washSchedules();
    assert.equal(res.length, 2);
    assert.ok(res.every((r) => r.locationName === "AH"));
  });
});

describe("CoffeeService: привязка точек к автоматам реестра", () => {
  // Стаб не фильтрует .where(): проверки существования в linkLocation видят
  // первую строку скормленного массива — тесты кормят только релевантные строки.
  const loc = (over: Record<string, unknown> = {}) => ({
    id: "loc-1",
    name: "American Hospital",
    isActive: true,
    entityId: null,
    machineName: null,
    machineRef: null,
    sortOrder: 0,
    ...over,
  });

  it("linkLocation — неизвестная точка отклоняется, не молчаливый успех", async () => {
    const { db } = coffeeDb({ locations: [] });
    const svc = new CoffeeService(db);
    await assert.rejects(svc.linkLocation("missing", "ent-1"));
  });

  it("linkLocation — карточка не-автомата (type≠machine) отклоняется", async () => {
    const { db } = coffeeDb({ locations: [loc()], registry: [{ id: "ent-1", type: "contractor", name: "Olma" }] });
    const svc = new CoffeeService(db);
    await assert.rejects(svc.linkLocation("loc-1", "ent-1"));
  });

  it("linkLocation — валидная привязка пишет entityId; null снимает связь", async () => {
    const { db, updates } = coffeeDb({
      locations: [loc()],
      registry: [{ id: "ent-1", type: "machine", name: "Кофемашина AH" }],
    });
    const svc = new CoffeeService(db);
    await svc.linkLocation("loc-1", "ent-1");
    await svc.linkLocation("loc-1", null);
    // Привязка теперь ведёт ещё и историю размещений — смотрим только кэш точки.
    const locUpdates = updates.filter((u) => u.table === "coffee_location");
    assert.equal(locUpdates.length, 2);
    assert.equal((locUpdates[0]!.values as Record<string, unknown>).entityId, "ent-1");
    assert.equal((locUpdates[1]!.values as Record<string, unknown>).entityId, null);
  });

  it("machineCandidates — отдаёт только осмысленный адрес точки (пустая строка → null)", async () => {
    const registry = [
      { id: "m1", type: "machine", name: "Автомат 1", externalRef: "199", attrs: { точка: "American Hospital" } },
      { id: "m2", type: "machine", name: "Автомат 2", externalRef: null, attrs: { точка: "  " } },
    ];
    const { db } = coffeeDb({ registry });
    const svc = new CoffeeService(db);
    const res = await svc.machineCandidates();
    assert.equal(res.find((m) => m.entityId === "m1")!.point, "American Hospital");
    assert.equal(res.find((m) => m.entityId === "m2")!.point, null);
  });

  it("autoLinkLocations — однозначное совпадение по адресу точки привязывается (регистр/ё не мешают)", async () => {
    const registry = [
      { id: "m1", type: "machine", name: "Кофемашина №1", externalRef: "101", attrs: { точка: "AMERICAN  hospital" } },
    ];
    const { db, updates } = coffeeDb({ locations: [loc()], registry });
    const svc = new CoffeeService(db);
    const res = await svc.autoLinkLocations();
    assert.equal(res.linked, 1);
    assert.deepEqual(res.ambiguous, []);
    assert.deepEqual(res.unmatched, []);
    const locUpdate = updates.find((u) => u.table === "coffee_location")!;
    assert.equal((locUpdate.values as Record<string, unknown>).entityId, "m1");
  });

  it("autoLinkLocations — два автомата на одном адресе → неоднозначно, НЕ привязывается", async () => {
    const registry = [
      { id: "m1", type: "machine", name: "Автомат A", externalRef: "1", attrs: { точка: "American Hospital" } },
      { id: "m2", type: "machine", name: "Автомат B", externalRef: "2", attrs: { точка: "American Hospital" } },
    ];
    const { db, updates } = coffeeDb({ locations: [loc()], registry });
    const svc = new CoffeeService(db);
    const res = await svc.autoLinkLocations();
    assert.equal(res.linked, 0);
    assert.deepEqual(res.ambiguous, ["American Hospital"]);
    assert.equal(updates.length, 0);
  });

  it("autoLinkLocations — уже привязанная точка не перетирается", async () => {
    const registry = [
      { id: "m1", type: "machine", name: "Автомат A", externalRef: "1", attrs: { точка: "American Hospital" } },
    ];
    const { db, updates } = coffeeDb({ locations: [loc({ entityId: "m-old" })], registry });
    const svc = new CoffeeService(db);
    const res = await svc.autoLinkLocations();
    assert.equal(res.linked, 0);
    assert.equal(updates.length, 0);
  });

  it("autoLinkLocations — нет кандидатов → в unmatched, без выдумывания", async () => {
    const { db, updates } = coffeeDb({ locations: [loc({ name: "Grand clinic" })], registry: [] });
    const svc = new CoffeeService(db);
    const res = await svc.autoLinkLocations();
    assert.deepEqual(res.unmatched, ["Grand clinic"]);
    assert.equal(updates.length, 0);
  });
});

describe("CoffeeService: история размещений (аппарат ↔ точка с периодами)", () => {
  const loc = () => ({ id: "loc-1", name: "AH", isActive: true, entityId: "ent-old", machineName: null, machineRef: null, sortOrder: 0 });
  const machine = (id: string) => ({ id, type: "machine", name: `Автомат ${id}` });

  it("перестановка аппарата закрывает открытое размещение и открывает новое", async () => {
    const { db, inserts, updates } = coffeeDb({
      locations: [loc()],
      registry: [machine("ent-new")],
      placements: [{ id: "p1", locationId: "loc-1", entityId: "ent-old", endDate: null }],
    });
    const svc = new CoffeeService(db);
    await svc.linkLocation("loc-1", "ent-new");

    // Старые периоды закрыты сегодняшним днём (точки и нового аппарата).
    const closes = updates.filter((u) => u.table === "coffee_machine_placement");
    assert.ok(closes.length >= 1, "открытое размещение точки закрывается");
    for (const c of closes) {
      assert.match(String((c.values as Record<string, unknown>).endDate), /^\d{4}-\d{2}-\d{2}$/);
    }

    // Новое размещение открыто с сегодняшней даты.
    const opened = inserts.find((i) => i.table === "coffee_machine_placement")!;
    const row = opened.values as Record<string, unknown>;
    assert.equal(row.locationId, "loc-1");
    assert.equal(row.entityId, "ent-new");
    assert.match(String(row.startDate), /^\d{4}-\d{2}-\d{2}$/);
  });

  it("повторная привязка того же аппарата — период-дубль не открывается", async () => {
    const { db, inserts, updates } = coffeeDb({
      locations: [loc()],
      registry: [machine("ent-old")],
      placements: [{ id: "p1", locationId: "loc-1", entityId: "ent-old", endDate: null }],
    });
    const svc = new CoffeeService(db);
    await svc.linkLocation("loc-1", "ent-old");
    assert.equal(inserts.filter((i) => i.table === "coffee_machine_placement").length, 0);
    assert.equal(updates.filter((u) => u.table === "coffee_machine_placement").length, 0, "история не трогается");
  });

  it("снятие связи (null) закрывает размещение, ничего не открывая", async () => {
    const { db, inserts, updates } = coffeeDb({
      locations: [loc()],
      placements: [{ id: "p1", locationId: "loc-1", entityId: "ent-old", endDate: null }],
    });
    const svc = new CoffeeService(db);
    await svc.linkLocation("loc-1", null);
    assert.equal(inserts.filter((i) => i.table === "coffee_machine_placement").length, 0);
    assert.equal(updates.filter((u) => u.table === "coffee_machine_placement").length, 1);
  });

  it("placements() отдаёт историю с именами точки и аппарата", async () => {
    const { db } = coffeeDb({
      placements: [
        { id: "p1", locationId: "loc-1", locationName: "AH", entityId: "m1", machineName: "Автомат 1", machineRef: "199", startDate: "2026-01-01", endDate: null, note: null },
      ],
    });
    const svc = new CoffeeService(db);
    const rows = await svc.placements();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.endDate, null);
  });
});

describe("CoffeeService: правка точек и журнала из панели", () => {
  it("createLocation: короткое имя отклоняется, годное — пишется с аудитом", async () => {
    const { db, inserts } = coffeeDb({});
    const svc = new CoffeeService(db);
    await assert.rejects(svc.createLocation(" x "));
    await svc.createLocation("  Новая точка  ");
    const loc = inserts.find((i) => i.table === "coffee_location")!;
    assert.equal((loc.values as Record<string, unknown>).name, "Новая точка", "имя триммится");
    const audit = inserts.find((i) => i.table === "audit_log")!;
    assert.equal((audit.values as Record<string, unknown>).action, "coffee.location.create");
  });

  it("updateLocation: переименование пишет before/after в аудит; пустой patch — no-op", async () => {
    const { db, updates, inserts } = coffeeDb({
      locations: [{ id: "loc-1", name: "Старое имя", isActive: true, entityId: null, sortOrder: 0 }],
    });
    const svc = new CoffeeService(db);
    await svc.updateLocation("loc-1", {});
    assert.equal(updates.length, 0, "нечего менять — не трогаем базу");
    await svc.updateLocation("loc-1", { name: "Новое имя", isActive: false });
    assert.equal(updates.filter((u) => u.table === "coffee_location").length, 1);
    const audit = inserts.find((i) => i.table === "audit_log")!.values as Record<string, Record<string, unknown>>;
    assert.equal(audit.before!.name, "Старое имя");
    assert.equal(audit.after!.name, "Новое имя");
  });

  it("deleteRefill: строка целиком уходит в аудит, потом удаляется; неизвестный id — отказ", async () => {
    const row = { id: "r1", locationId: "loc-1", position: 7, filledWeight: 1200, enteredDate: "2026-08-01" };
    const { db, deletes, inserts } = coffeeDb({ refills: [row] });
    const svc = new CoffeeService(db);
    await svc.deleteRefill("r1");
    assert.equal(deletes.filter((d) => d.table === "coffee_refill").length, 1);
    const audit = inserts.find((i) => i.table === "audit_log")!.values as Record<string, unknown>;
    assert.equal(audit.action, "coffee.refill.delete");
    assert.deepEqual(audit.before, row, "удалённое сохранено целиком — восстановимо глазами");

    const empty = new CoffeeService(coffeeDb({ refills: [] }).db);
    await assert.rejects(empty.deleteRefill("missing"));
  });

  it("deleteContainerReturn: то же для возвратов", async () => {
    const row = { id: "ret-1", position: 1, containerNumber: 27, weight: 787, returnedDate: "2026-07-30" };
    const { db, deletes, inserts } = coffeeDb({ returns: [row] });
    const svc = new CoffeeService(db);
    await svc.deleteContainerReturn("ret-1");
    assert.equal(deletes.filter((d) => d.table === "coffee_container_return").length, 1);
    assert.equal((inserts.find((i) => i.table === "audit_log")!.values as Record<string, unknown>).action, "coffee.return.delete");
  });
});

describe("CoffeeService: «ошибся — исправить» (только своё + последняя запись)", () => {
  it("onlyIfCreatedBy: чужую запись бот удалить не может, свою — можно, актор в аудите", async () => {
    const row = { id: "r1", locationId: "loc-1", position: 7, filledWeight: 1200, enteredDate: "2026-08-01", createdBy: "person:p1" };
    const { db, deletes, inserts } = coffeeDb({ refills: [row] });
    const svc = new CoffeeService(db);
    await assert.rejects(
      svc.deleteRefill("r1", { actor: "person:p2", onlyIfCreatedBy: "person:p2" }),
      /не твоя запись/i,
    );
    assert.equal(deletes.length, 0, "отказ — до удаления");
    await svc.deleteRefill("r1", { actor: "person:p1", onlyIfCreatedBy: "person:p1" });
    assert.equal(deletes.filter((d) => d.table === "coffee_refill").length, 1);
    const audit = inserts.find((i) => i.table === "audit_log")!.values as Record<string, unknown>;
    assert.equal(audit.actorRef, "person:p1", "в аудите — кто удалил на самом деле, не «panel»");
  });

  it("deleteConsumable: строка расходников целиком уходит в аудит", async () => {
    const row = { id: "cons-1", locationId: "loc-1", loggedDate: "2026-08-04", water: 2, cups: 100, lids: 100, createdBy: "person:p1" };
    const { db, deletes, inserts } = coffeeDb({ consumables: [row] });
    const svc = new CoffeeService(db);
    await svc.deleteConsumable("cons-1", { actor: "person:p1", onlyIfCreatedBy: "person:p1" });
    assert.equal(deletes.filter((d) => d.table === "coffee_consumable").length, 1);
    const audit = inserts.find((i) => i.table === "audit_log")!.values as Record<string, unknown>;
    assert.equal(audit.action, "coffee.consumable.delete");
    assert.deepEqual(audit.before, row, "удалённое сохранено целиком");

    const empty = new CoffeeService(coffeeDb({}).db);
    await assert.rejects(empty.deleteConsumable("missing"));
  });

  it("lastEntry: выбирает самую свежую из трёх журналов, текст читается по-русски", async () => {
    const { db } = coffeeDb({
      refills: [
        {
          id: "r1",
          at: "2026-08-01T10:00:00Z",
          locationName: "AH",
          position: 7,
          containerNumber: 5,
          filledWeight: 1200,
          packageCount: 2,
          enteredDate: "2026-08-01",
        },
      ],
      returns: [
        { id: "ret-1", at: "2026-08-03T09:00:00Z", position: 1, containerNumber: 27, weight: 787, returnedDate: "2026-08-03" },
      ],
      consumables: [
        {
          id: "cons-1",
          at: "2026-08-02T08:00:00Z",
          locationName: "AH",
          loggedDate: "2026-08-02",
          water: 2,
          cups: 100,
          lids: 100,
        },
      ],
    });
    const svc = new CoffeeService(db);
    const { entry } = await svc.lastEntry("person:p1");
    assert.ok(entry);
    assert.equal(entry.kind, "container_return", "возврат новее заливки и расходников");
    assert.equal(entry.id, "ret-1");
    assert.match(entry.text, /возврат 2026-08-03 · набор 027 · поз\. 1 · 787г/);
  });

  it("lastEntry: записей нет — entry null (не выдумываем)", async () => {
    const svc = new CoffeeService(coffeeDb({}).db);
    const { entry } = await svc.lastEntry("person:p1");
    assert.equal(entry, null);
  });
});

describe("CoffeeService: расход по наборам (containerConsumption)", () => {
  it("пара заливка→возврат: расход в граммах, ингредиент позиции и себестоимость по цене", async () => {
    const { db } = coffeeDb({
      refills: [
        { date: "2026-01-10", position: 7, containerNumber: 5, filledWeight: 1600, locationId: "loc-1", locationName: "AH" },
      ],
      returns: [{ position: 7, containerNumber: 5, weight: 1000, returnedDate: "2026-01-17" }],
      tare: [{ containerNumber: 5, position: 7, tareWeight: 600 }],
      bunkerConfig: [
        { position: 7, ingredientId: "ing-7", ingredientName: "Кофе", purchasePrice: "80", targetFillWeight: null },
      ],
    });
    const svc = new CoffeeService(db);
    const rep = await svc.containerConsumption("2026-01-01", "2026-01-31");
    assert.equal(rep.rows.length, 1);
    assert.equal(rep.rows[0]!.consumedGrams, 600, "нетто 1000 − нетто 400");
    assert.equal(rep.rows[0]!.ingredient, "Кофе");
    assert.equal(rep.locations.length, 1);
    assert.equal(rep.locations[0]!.grams, 600);
    assert.equal(rep.locations[0]!.cost, 48000, "600г × 80 сум/г");
    assert.equal(rep.totalGrams, 600);
    assert.equal(rep.totalCost, 48000);
  });

  it("нет тары пары — расход честно неизвестен: unknownPairs, стоимость null (не 0)", async () => {
    const { db } = coffeeDb({
      refills: [
        { date: "2026-01-10", position: 3, containerNumber: 9, filledWeight: 1600, locationId: "loc-1", locationName: "AH" },
      ],
      returns: [{ position: 3, containerNumber: 9, weight: 1000, returnedDate: "2026-01-17" }],
      tare: [],
      bunkerConfig: [],
    });
    const svc = new CoffeeService(db);
    const rep = await svc.containerConsumption("2026-01-01", "2026-01-31");
    assert.equal(rep.rows[0]!.consumedGrams, null);
    assert.equal(rep.locations[0]!.unknownPairs, 1);
    assert.equal(rep.locations[0]!.grams, 0);
    assert.equal(rep.locations[0]!.cost, null);
    assert.equal(rep.totalCost, null);
  });
});

describe("CoffeeService: возвраты наборов (recordContainerReturn/containerReturns)", () => {
  it("recordContainerReturn — пишет строку с брутто-весом как есть", async () => {
    const { db, inserts } = coffeeDb({});
    const svc = new CoffeeService(db);
    await svc.recordContainerReturn({ position: 1, containerNumber: 27, weight: 787, returnedDate: "2026-07-30", locationNote: "Кпп остатки" });
    const row = inserts.find((i) => i.table === "coffee_container_return")!.values as Record<string, unknown>;
    assert.equal(row.position, 1);
    assert.equal(row.containerNumber, 27);
    assert.equal(row.weight, 787);
    assert.equal(row.locationNote, "Кпп остатки");
  });

  it("containerReturns — чистый остаток через тару (набор, позиция); нет тары → null, не 0", async () => {
    const returns = [
      { id: "r1", position: 1, containerNumber: 27, weight: 787, returnedDate: "2026-07-30", locationNote: null, createdBy: null, createdAt: new Date() },
      { id: "r2", position: 5, containerNumber: 13, weight: 1078, returnedDate: "2026-07-31", locationNote: null, createdBy: null, createdAt: new Date() },
    ];
    const tare = [{ containerNumber: 27, position: 1, tareWeight: 620 }]; // для набора 13 тары нет
    const { db } = coffeeDb({ returns, tare });
    const svc = new CoffeeService(db);
    const res = await svc.containerReturns();
    assert.equal(res.find((r) => r.id === "r1")!.netWeight, 167); // 787 − 620
    assert.equal(res.find((r) => r.id === "r2")!.netWeight, null, "тара не заведена — остаток неизвестен, а не 0");
  });
});
