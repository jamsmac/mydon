import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  entity,
  event,
  machineCard,
  machineSale,
  productSale,
  purchase,
  systemConfig,
  vendingAlias,
  vendingProduct,
  vendingStock,
} from "@mydon/db";
import { MAX_SLOTS_PER_MACHINE, VendingService } from "./vending.service";

type Row = { machineSerial: string; coilId: string; productName: string | null; capacity: number; quantity: number };
type SaleRow = { machineSerial: string; productName: string; quantity: number; capturedAt: Date };
type ProdRow = {
  id?: string;
  name: string;
  purchasePrice: string | null;
  packSize: number;
  excludedFromPurchase?: boolean;
  fixedPurchaseQty?: number | null;
};
type AliasRow = { productId: string; alias: string };

/**
 * Таблицы реестра автоматов и настроек: их читает `purchase()` (фильтр «в строю»
 * и маршрут). Стабы обязаны отдавать по ним ПУСТО, иначе строки слотов
 * притворятся карточками автоматов. Пустой реестр = автомат без карточки =
 * в строю, поэтому старые ожидания не меняются.
 */
const РЕЕСТР: unknown[] = [entity, machineCard, systemConfig];

/**
 * Стаб БД: machines()/deficitSummary() читают `select().from()`. `deficitSummary()`
 * тоже резолвит алиасы (loadProductIndex()) — по умолчанию пустые, отдельные тесты
 * передают их явно.
 */
function readDb(rows: Row[], aliases: AliasRow[] = [], products: ProdRow[] = []) {
  return {
    select: () => ({
      from: async (t: unknown) =>
        t === vendingAlias
          ? aliases
          : t === vendingProduct
            ? products
            : РЕЕСТР.includes(t)
              ? []
              : rows,
    }),
  } as never;
}

/** Стаб БД для прогноза: слоты, продажи, алиасы — различаем по ссылке. */
function forecastDb(slots: Row[], sales: SaleRow[], aliases: AliasRow[] = [], products: ProdRow[] = []) {
  return {
    select: () => ({
      from: async (t: unknown) =>
        t === productSale
          ? sales
          : t === vendingAlias
            ? aliases
            : t === vendingProduct
              ? products
              : РЕЕСТР.includes(t)
                ? []
                : slots,
    }),
  } as never;
}

type StockRow = { productName: string; quantity: number; countedAt: Date };

/** Стаб БД для закупа: слоты + продажи + прайс + склад + алиасы, различаем по ссылке. */
function purchaseDb(slots: Row[], sales: SaleRow[], products: ProdRow[], stock: StockRow[] = [], aliases: AliasRow[] = []) {
  return {
    select: () => ({
      from: async (t: unknown) =>
        t === productSale
          ? sales
          : t === vendingProduct
            ? products
            : t === vendingStock
              ? stock
              : t === vendingAlias
                ? aliases
                : РЕЕСТР.includes(t)
                  ? []
                  : slots,
    }),
  } as never;
}

/**
 * Стаб БД для ingest: копит вставки. `aliases`/`products` кормят
 * loadProductIndex() (вне транзакции); `stockRows` — предзагрузку остатка ДО
 * пересчёта внутри транзакции (единственный select там — фильтр по имени
 * стабу не нужен, ingestStock сам сверяет by-name из полного среза).
 */
function writeDb(
  aliases: unknown[] = [],
  products: unknown[] = [],
  stockRows: unknown[] = [],
  /** Карточки автоматов реестра — для привязки слотов к entity. */
  machineCards: { id: string; ref: string | null }[] = [],
) {
  const inserts: { table: string; values: unknown }[] = [];
  // Реальные строки vending_stock всегда имеют countedAt (NOT NULL) — большинство
  // тестов его не задают, раз речь не про порядок во времени; эпоха 0 заведомо
  // «старее» любого countedAt в тестах, так что обычные сценарии недостачи/
  // излишка ведут себя как раньше без правки каждого литерала.
  const stockRowsWithCountedAt = stockRows.map((r) => ({ countedAt: new Date(0), ...(r as object) }));
  /** Слоты, убранные как исчезнувшие: возвращаем то, что задали тестом. */
  const pruneRows: { id: string }[] = [];
  /** Заставить уборку упасть — проверяем, что снимок при этом уцелел. */
  let pruneFails = false;
  const failPrune = () => {
    pruneFails = true;
  };
  const tx = {
    select: () => ({ from: async () => stockRowsWithCountedAt }),
    delete: () => ({
      where: () => ({
        returning: async () => {
          if (pruneFails) throw new Error("уборка не удалась (тест)");
          return pruneRows.splice(0, pruneRows.length);
        },
      }),
    }),
    insert: (table: { [Symbol.toStringTag]?: string }) => ({
      values: (v: unknown) => {
        const name = tableName(table);
        inserts.push({ table: name, values: v });
        return { onConflictDoUpdate: () => Promise.resolve() };
      },
    }),
  };
  // loadProductIndex() читает vending_alias затем vending_product — различаем по счётчику.
  // Карточки автоматов (entity) читаются с .where() и по счётчику не идут:
  // иначе привязка слотов сдвигала бы очередь алиасов и товаров.
  let call = 0;
  const db = {
    delete: () => ({
      where: () => ({
        returning: async () => {
          if (pruneFails) throw new Error("уборка не удалась (тест)");
          return pruneRows.splice(0, pruneRows.length);
        },
      }),
    }),
    select: () => ({
      from: (t: unknown) => {
        if (t === entity) {
          // Thenable + .where(): machineIdBySerial() фильтрует по типу.
          const rows = Promise.resolve(machineCards);
          return { where: () => rows, then: rows.then.bind(rows) };
        }
        const rows = Promise.resolve(call++ === 0 ? aliases : products);
        return { where: () => rows, then: rows.then.bind(rows) };
      },
    }),
    insert: (table: { [Symbol.toStringTag]?: string }) => ({
      values: (v: unknown) => {
        inserts.push({ table: tableName(table), values: v });
        return Promise.resolve();
      },
    }),
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
  } as never;
  return { db, inserts, pruneRows, failPrune };
}
function tableName(t: unknown): string {
  // Журнал событий узнаём по личности: эвристика по ключам его не различает.
  if (t === event) return "event";
  // drizzle-таблица знает своё имя; для стаба достаточно эвристики по ключам.
  const keys = Object.keys((t ?? {}) as Record<string, unknown>);
  return keys.includes("capturedAt") && !keys.includes("syncedAt") ? "slot_snapshot" : "machine_slot";
}

const slot = (machineSerial: string, coilId: string, productName: string | null, capacity: number, quantity: number): Row => ({
  machineSerial,
  coilId,
  productName,
  capacity,
  quantity,
});

describe("Вендинг Core: дефицит по автоматам (Фаза 1c)", () => {
  it("считает дефицит/заполненность, статус, сортировку", async () => {
    const rows = [
      // AH: два валидных слота — дефицит (6-0)+(6-1)=11
      slot("AH", "31", "Montella", 6, 0),
      slot("AH", "34", "CocaCola", 6, 1),
      // NOSLOT: слоты без товара → no_slots, в конце
      slot("NOSLOT", "1", null, 6, 0),
    ];
    const svc = new VendingService(readDb(rows));
    const machines = await svc.machines();
    const ah = machines.find((m) => m.serial === "AH")!;
    assert.equal(ah.status, "ok");
    assert.equal(ah.deficit, 11);
    assert.equal(ah.capacity, 12);
    assert.equal(ah.fillRate, 8); // round(1/12*100)
    // no_slots-автомат уходит в конец.
    assert.equal(machines[machines.length - 1].serial, "NOSLOT");
    assert.equal(machines[machines.length - 1].status, "no_slots");
  });

  it("сводная потребность по товарам — только ok, с разбивкой", async () => {
    const rows = [
      slot("AH", "31", "Montella", 6, 0), // деф 6
      slot("Olma", "40", "Montella", 6, 3), // деф 3
      slot("Olma", "41", "Fanta", 6, 6), // деф 0 — не в сводке
    ];
    const svc = new VendingService(readDb(rows));
    const summary = await svc.deficitSummary();
    const m = summary.find((s) => s.product === "Montella")!;
    assert.equal(m.total, 9);
    assert.deepEqual(m.perMachine, { AH: 6, Olma: 3 });
    assert.ok(!summary.some((s) => s.product === "Fanta"), "нулевой дефицит не попадает в сводку");
  });

  it("два сырых имени одного канона — одна строка сводки, а не две (item 38)", async () => {
    const rows = [
      slot("AH", "31", "Montella", 6, 0), // деф 6
      slot("Olma", "40", "18+", 6, 3), // деф 3, другое сырое имя того же товара
    ];
    const aliases: AliasRow[] = [
      { productId: "p1", alias: "Montella" },
      { productId: "p1", alias: "18+" },
    ];
    const products: ProdRow[] = [{ id: "p1", name: "Montella Вода минеральная 330ml", purchasePrice: null, packSize: 1 }];
    const svc = new VendingService(readDb(rows, aliases, products));
    const summary = await svc.deficitSummary();
    assert.equal(summary.filter((s) => s.product.startsWith("Montella") || s.product === "18+").length, 1);
    const m = summary.find((s) => s.product === "Montella Вода минеральная 330ml")!;
    assert.equal(m.total, 9);
    assert.deepEqual(m.perMachine, { AH: 6, Olma: 3 });
  });
});

describe("Вендинг Core: прогноз расхода (§5.6)", () => {
  it("daysLeft = остаток / (продажи7/7), только ok-автоматы, свежий батч продаж", async () => {
    const t1 = new Date("2026-07-30T00:00:00Z"); // старый батч — игнор
    const t2 = new Date("2026-08-02T00:00:00Z"); // свежий
    const slots: Row[] = [
      // AH ok: Montella остаток 2 (валиден), Fanta остаток 6 (продаж нет)
      { machineSerial: "AH", coilId: "31", productName: "Montella", capacity: 6, quantity: 2 },
      { machineSerial: "AH", coilId: "32", productName: "Fanta", capacity: 6, quantity: 6 },
      // NOSLOT: без назначенных слотов → не ok, его остаток в прогноз не идёт
      { machineSerial: "NOSLOT", coilId: "1", productName: null, capacity: 6, quantity: 0 },
    ];
    const sales: SaleRow[] = [
      { machineSerial: "AH", productName: "Montella", quantity: 999, capturedAt: t1 }, // старый — игнор
      { machineSerial: "AH", productName: "Montella", quantity: 14, capturedAt: t2 }, // sold7=14 → daily=2
    ];
    const svc = new VendingService(forecastDb(slots, sales));
    const { all, critical } = await svc.forecast();

    const montella = all.find((r) => r.product === "Montella")!;
    assert.equal(montella.inMachines, 2);
    assert.equal(montella.daily, 2);
    assert.equal(montella.daysLeft, 1); // 2 / 2
    // Fanta без продаж → хватит «навсегда», не критичен.
    const fanta = all.find((r) => r.product === "Fanta")!;
    assert.equal(fanta.daysLeft, Infinity);
    // Критичны только те, чей запас ≤ 3 дней.
    assert.deepEqual(critical.map((r) => r.product), ["Montella"]);
  });

  it("остаток и продажи под разными сырыми именами одного канона сходятся в один прогноз (item 38)", async () => {
    const t2 = new Date("2026-08-02T00:00:00Z");
    const slots: Row[] = [
      { machineSerial: "AH", coilId: "31", productName: "Montella", capacity: 6, quantity: 2 },
      { machineSerial: "Olma", coilId: "1", productName: "18+", capacity: 6, quantity: 3 },
    ];
    const sales: SaleRow[] = [
      { machineSerial: "AH", productName: "Montella", quantity: 7, capturedAt: t2 },
      { machineSerial: "Olma", productName: "18+", quantity: 7, capturedAt: t2 },
    ];
    const aliases: AliasRow[] = [
      { productId: "p1", alias: "Montella" },
      { productId: "p1", alias: "18+" },
    ];
    const products: ProdRow[] = [{ id: "p1", name: "Montella Вода минеральная 330ml", purchasePrice: null, packSize: 1 }];
    const svc = new VendingService(forecastDb(slots, sales, aliases, products));
    const { all } = await svc.forecast();

    const rows = all.filter((r) => r.product === "Montella" || r.product === "18+" || r.product === "Montella Вода минеральная 330ml");
    assert.equal(rows.length, 1, "должна остаться одна строка прогноза под каноном");
    const canon = all.find((r) => r.product === "Montella Вода минеральная 330ml")!;
    assert.equal(canon.inMachines, 5); // 2+3
    assert.equal(canon.daily, 2); // (7+7)/7
  });
});

describe("Вендинг Core: приём продаж — идемпотентность батча (§5.6)", () => {
  /**
   * Стаб БД для ingestSales: копит вызовы insert(...).onConflictDoUpdate(...).
   * Реальный unique-индекс (миграция 0024) эти тесты не проверяют — только то,
   * что код идёт через upsert с правильным target, а не голый insert
   * (проверка самого constraint — вне мокового unit-теста, найдено внешним
   * аудитом п.13: нет реальных DB-тестов на конкурентность/ограничения).
   */
  function ingestSalesDb(machineCards: { id: string; ref: string | null }[] = []) {
    const calls: { table: "product_sale" | "machine_sale"; values: Record<string, unknown>; target: unknown[] }[] = [];
    const tx = {
      insert: (table: unknown) => ({
        values: (v: Record<string, unknown>) => ({
          onConflictDoUpdate: (opts: { target: unknown[]; set: Record<string, unknown> }) => {
            calls.push({ table: table === productSale ? "product_sale" : "machine_sale", values: v, target: opts.target });
            return Promise.resolve(undefined);
          },
        }),
      }),
    };
    // Приём продаж теперь читает карточки автоматов, чтобы проставить
    // machine_id: без этого продажи Ourvend знали только серийник.
    const db = {
      select: () => ({
        from: () => {
          const rows = Promise.resolve(machineCards);
          return { where: () => rows, then: rows.then.bind(rows) };
        },
      }),
      transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
    } as never;
    return { db, calls };
  }

  const payload = {
    capturedAt: "2026-08-02T00:00:00Z",
    periodStart: "2026-07-26T00:00:00Z",
    periodEnd: "2026-08-02T00:00:00Z",
    productSales: [{ serial: "AH", product: "Montella", quantity: 5 }],
    machineSales: [{ serial: "AH", totalAmount: 12345.6, totalCount: 7 }],
  };

  it("продажи по товарам и по автоматам идут через upsert, не голый insert", async () => {
    const { db, calls } = ingestSalesDb();
    const res = await new VendingService(db).ingestSales(payload);

    assert.equal(res.productRows, 1);
    assert.equal(res.machineRows, 1);
    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.find((c) => c.table === "product_sale")!.target,
      [productSale.machineSerial, productSale.productName, productSale.capturedAt],
    );
    assert.deepEqual(
      calls.find((c) => c.table === "machine_sale")!.target,
      [machineSale.machineSerial, machineSale.capturedAt],
    );
  });

  it("повторная доставка того же батча (тот же capturedAt/автомат/товар) конфликтует по ключу идемпотентности, а не создаёт вторую строку (найдено внешним аудитом, P1)", async () => {
    const { db, calls } = ingestSalesDb();
    const svc = new VendingService(db);
    await svc.ingestSales(payload);
    await svc.ingestSales(payload); // ретрай того же батча — сеть оборвалась после первой доставки

    const productCalls = calls.filter((c) => c.table === "product_sale");
    assert.equal(productCalls.length, 2); // оба раза — insert...onConflictDoUpdate с одним и тем же target
    assert.deepEqual(productCalls[0]!.target, productCalls[1]!.target);
    assert.deepEqual(productCalls[0]!.values, productCalls[1]!.values);
  });
});

describe("Вендинг Core: сводный закуп (§5.4–5.5)", () => {
  const t = new Date("2026-08-02T00:00:00Z");
  // Один ok-автомат: Montella нужна 4 (есть цена+продажи), Dead нужна 2 (цена
  // есть, продаж нет → «не закупать»), NoPrice нужна 3 (нет цены → на разбор).
  const slots: Row[] = [
    { machineSerial: "AH", coilId: "1", productName: "Montella", capacity: 6, quantity: 2 },
    { machineSerial: "AH", coilId: "2", productName: "Dead", capacity: 5, quantity: 3 },
    { machineSerial: "AH", coilId: "3", productName: "NoPrice", capacity: 6, quantity: 3 },
  ];
  const sales: SaleRow[] = [
    { machineSerial: "AH", productName: "Montella", quantity: 14, capturedAt: t },
    { machineSerial: "AH", productName: "NoPrice", quantity: 5, capturedAt: t }, // продажи есть, цены нет
  ];
  const products: ProdRow[] = [
    { name: "Montella", purchasePrice: "5000.00", packSize: 12 },
    { name: "Dead", purchasePrice: "3000.00", packSize: 10 },
    // NoPrice отсутствует в прайсе намеренно.
  ];

  it("округляет до упаковки, считает обе суммы и переплату по товару с ценой и продажами", async () => {
    const svc = new VendingService(purchaseDb(slots, sales, products));
    const s = await svc.purchase();

    const montella = s.items.find((i) => i.product === "Montella")!;
    assert.equal(montella.buy, 4); // дефицит 6−2, склад 0
    assert.equal(montella.order, 12); // ceil(4/12)*12
    assert.equal(montella.costExact, 20000); // 4×5000
    assert.equal(montella.costRounded, 60000); // 12×5000
    assert.equal(s.overpay, 40000);
  });

  it("товар без продаж выносит в excludedNoSales и не включает в денежные итоги", async () => {
    const svc = new VendingService(purchaseDb(slots, sales, products));
    const s = await svc.purchase();
    assert.deepEqual(s.excludedNoSales.map((i) => i.product), ["Dead"]);
    // В items только Montella (Dead исключён, NoPrice без цены, но продажи?)
    assert.ok(!s.items.some((i) => i.product === "Dead"));
  });

  it("товар без цены помечает noPrice и держит вне денежных итогов, но в items", async () => {
    const svc = new VendingService(purchaseDb(slots, sales, products));
    const s = await svc.purchase();
    assert.ok(s.noPrice.includes("NoPrice"));
    assert.ok(s.items.some((i) => i.product === "NoPrice")); // есть продажи → участвует
    assert.equal(s.costRounded, 60000); // деньги — только Montella
  });

  it("остаток склада вычитается из потребности: buy = need − stock (§5.4)", async () => {
    // Склад Montella 1 → нехватка 4−1=3, но округление до упаковки 12 то же.
    const stock: StockRow[] = [{ productName: "Montella", quantity: 1, countedAt: t }];
    const svc = new VendingService(purchaseDb(slots, sales, products, stock));
    const s = await svc.purchase();
    const montella = s.items.find((i) => i.product === "Montella")!;
    assert.equal(montella.stock, 1);
    assert.equal(montella.covered, 1); // min(1, 4)
    assert.equal(montella.buy, 3); // max(0, 4−1)
    assert.equal(montella.order, 12); // ceil(3/12)*12
    assert.equal(montella.costExact, 15000); // 3×5000
  });

  it("склад покрывает потребность полностью — товар выпадает из закупа (buy=0)", async () => {
    const stock: StockRow[] = [{ productName: "Montella", quantity: 10, countedAt: t }];
    const svc = new VendingService(purchaseDb(slots, sales, products, stock));
    const s = await svc.purchase();
    const montella = s.items.find((i) => i.product === "Montella")!;
    assert.equal(montella.buy, 0);
    assert.equal(montella.order, 0); // buy 0 → заказывать нечего
    assert.equal(montella.surplus, 6); // 10 − 4
    assert.equal(s.costRounded, 0); // единственная денежная позиция закрыта складом
  });

  it(
    "два разных сырых имени слота на один канон — ОДНА позиция закупа с суммарной " +
      "потребностью и разбивкой по автоматам, а не две отдельные строки с раздельным " +
      "дефицитом и продажами (item 38, найдено внешним аудитом)",
    async () => {
      // Один и тот же товар записан в разных автоматах разными Ourvend-именами
      // («Montella» и «18+») — рукописный лист сборщика их не различает.
      const aliasSlots: Row[] = [
        { machineSerial: "AH", coilId: "1", productName: "Montella", capacity: 6, quantity: 2 }, // деф 4
        { machineSerial: "Olma", coilId: "1", productName: "18+", capacity: 6, quantity: 1 }, // деф 5
      ];
      // Продажи собраны Ourvend тоже под сырыми именами — обе должны сойтись на каноне.
      const aliasSales: SaleRow[] = [
        { machineSerial: "AH", productName: "Montella", quantity: 7, capturedAt: t },
        { machineSerial: "Olma", productName: "18+", quantity: 7, capturedAt: t },
      ];
      const aliasProducts: ProdRow[] = [{ id: "p1", name: "Montella Вода минеральная 330ml", purchasePrice: "5000.00", packSize: 12 }];
      const aliases: AliasRow[] = [
        { productId: "p1", alias: "Montella" },
        { productId: "p1", alias: "18+" },
      ];
      // Остаток склада тоже в каноне (как пишет ingestStock) — должен вычесться
      // из ОБЩЕЙ потребности, а не из одной из двух раздельных позиций.
      const stock: StockRow[] = [{ productName: "Montella Вода минеральная 330ml", quantity: 1, countedAt: t }];

      const svc = new VendingService(purchaseDb(aliasSlots, aliasSales, aliasProducts, stock, aliases));
      const s = await svc.purchase();

      const rows = s.items.filter((i) => i.product === "Montella Вода минеральная 330ml");
      assert.equal(rows.length, 1, "должна остаться одна позиция под каноном, а не по одной на сырое имя");
      const item = rows[0]!;
      assert.deepEqual(item.perMachine, { AH: 4, Olma: 5 }); // разбивка по автоматам сохранена
      assert.equal(item.need, 9); // 4+5, а не два раза по 4 и 5 раздельно
      assert.equal(item.stock, 1); // склад найден по канону
      assert.equal(item.buy, 8); // 9−1
      assert.equal(item.noSales, false); // продажи под обоими сырыми именами сошлись на каноне (7+7=14>0)

      assert.ok(!s.items.some((i) => i.product === "Montella" || i.product === "18+"), "сырые имена не должны утекать в items");
    },
  );
});

describe("Вендинг Core: отправка закупа на утверждение (§5.7)", () => {
  const t = new Date("2026-08-02T00:00:00Z");
  const slots: Row[] = [{ machineSerial: "AH", coilId: "1", productName: "Montella", capacity: 6, quantity: 2 }];
  const sales: SaleRow[] = [{ machineSerial: "AH", productName: "Montella", quantity: 14, capturedAt: t }];
  const products: ProdRow[] = [{ name: "Montella", purchasePrice: "5000.00", packSize: 12 }];

  /** Стаб очереди согласований: копит запросы, отдаёт id. */
  function approvalsStub() {
    const requests: { agent: string; action: string; tier: string; payload?: Record<string, unknown> }[] = [];
    const svc = {
      request: async (input: { agent: string; action: string; tier: string; payload?: Record<string, unknown> }) => {
        requests.push(input);
        return { id: `ap-${requests.length}` };
      },
    };
    return { svc, requests };
  }

  it("создаёт заявку со снимком закупа и суммой в действии", async () => {
    const { svc, requests } = approvalsStub();
    const vending = new VendingService(purchaseDb(slots, sales, products), svc);
    const res = await vending.submitPurchase("owner");

    assert.equal(res.submitted, true);
    assert.equal(res.approvalId, "ap-1");
    assert.equal(res.positions, 1);
    assert.equal(res.costRounded, 60000); // order 12 × 5000

    assert.equal(requests.length, 1);
    const r = requests[0]!;
    assert.equal(r.agent, "vending");
    assert.equal(r.tier, "T2");
    assert.match(r.action, /Закуп вендинга: 1 поз/);
    const po = (r.payload as { purchaseOrder: { positions: unknown[]; costRounded: number } }).purchaseOrder;
    assert.equal(po.positions.length, 1);
    assert.equal(po.costRounded, 60000);
  });

  it("нечего заказывать — заявку не создаёт", async () => {
    const { svc, requests } = approvalsStub();
    // Слот заполнен под завязку → дефицита нет.
    const full: Row[] = [{ machineSerial: "AH", coilId: "1", productName: "Montella", capacity: 6, quantity: 6 }];
    const vending = new VendingService(purchaseDb(full, sales, products), svc);
    const res = await vending.submitPurchase("owner");
    assert.equal(res.submitted, false);
    assert.equal(requests.length, 0);
    assert.match(res.reason ?? "", /нечего/i);
  });

  it("без подключённой очереди согласований — явная ошибка", async () => {
    const vending = new VendingService(purchaseDb(slots, sales, products));
    await assert.rejects(() => vending.submitPurchase(), /ApprovalsService не подключён/);
  });
});

describe("Вендинг Core: приёмка накладной на склад (§5.7)", () => {
  type OrderRow = { id: string; status: string; positions: unknown[] };
  /**
   * Стаб БД приёмки: отдаёт накладную, копит апдейт статуса/приход/события.
   * `aliases`/`products` — только для тестов с `distributed` (loadProductIndex
   * читает их вне транзакции); без distributed этот select не вызывается.
   */
  function receiveDb(
    order: OrderRow | null,
    aliases: unknown[] = [],
    products: unknown[] = [],
    opts: { updateReturnsEmpty?: boolean } = {},
  ) {
    const stockUpserts: Record<string, unknown>[] = [];
    const updates: Record<string, unknown>[] = [];
    const events: Record<string, unknown>[] = [];
    const purchases: Record<string, unknown>[] = [];
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => (order ? [order] : []),
            orderBy: () => ({ limit: async () => (order ? [order] : []) }),
          }),
        }),
      }),
      // .returning() имитирует условный UPDATE...WHERE status IN (...): пустой
      // массив — «проиграли гонку», кто-то другой уже перевёл накладную в
      // received между нашим SELECT и этим UPDATE (opts.updateReturnsEmpty).
      update: () => ({
        set: (v: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              updates.push(v);
              if (opts.updateReturnsEmpty || !order) return [];
              return [{ ...order, ...v }];
            },
          }),
        }),
      }),
      insert: (table: unknown) => ({
        values: (v: Record<string, unknown> | Record<string, unknown>[]) => {
          if (table === vendingStock) {
            stockUpserts.push(v as Record<string, unknown>);
            return { onConflictDoUpdate: async () => undefined };
          }
          if (table === purchase) {
            purchases.push(...(v as Record<string, unknown>[]));
            return { onConflictDoNothing: async () => undefined };
          }
          if (table === event) events.push(v as Record<string, unknown>);
          return Promise.resolve(undefined);
        },
      }),
    };
    // loadProductIndex() читает vendingAlias затем vendingProduct — различаем по счётчику.
    let call = 0;
    const db = {
      select: () => ({ from: async () => (call++ === 0 ? aliases : products) }),
      transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
    } as never;
    return { db, stockUpserts, updates, events, purchases };
  }

  it("приёмка увеличивает остаток на заказанное и переводит в received", async () => {
    const order: OrderRow = {
      id: "o1",
      status: "approved",
      positions: [
        { product: "Montella", order: 12 },
        { product: "Fanta", order: 12 },
        { product: "  ", order: 5 }, // пустое имя → мимо
        { product: "Zero", order: 0 }, // ноль → мимо
      ],
    };
    const { db, stockUpserts, updates, events } = receiveDb(order);
    const res = await new VendingService(db).receiveOrder();

    assert.equal(res.received, true);
    assert.equal(res.orderId, "o1");
    assert.equal(res.replenished, 2);
    assert.equal(res.units, 24);
    assert.equal(updates[0]!.status, "received");
    assert.ok(updates[0]!.receivedAt instanceof Date);
    assert.equal(updates[0]!.receivedBy, "owner");
    assert.equal(stockUpserts.length, 2);
    assert.equal(stockUpserts[0]!.productName, "Montella");
    assert.equal(stockUpserts[0]!.quantity, 12);
    assert.equal(events[0]!.type, "vending.purchase_order.received");
  });

  it("накладная уже принята — приёмку не повторяем", async () => {
    const { db, stockUpserts } = receiveDb({ id: "o1", status: "received", positions: [] });
    const res = await new VendingService(db).receiveOrder();
    assert.equal(res.received, false);
    assert.equal(stockUpserts.length, 0);
    assert.match(res.reason ?? "", /уже принята/i);
  });

  it("непринятых накладных нет — понятная причина", async () => {
    const { db } = receiveDb(null);
    const res = await new VendingService(db).receiveOrder();
    assert.equal(res.received, false);
    assert.match(res.reason ?? "", /нет/i);
  });

  it("отменённая накладная — отдельная причина, не «уже принята» (найдено ревью)", async () => {
    const { db, stockUpserts } = receiveDb({ id: "o1", status: "cancelled", positions: [] });
    const res = await new VendingService(db).receiveOrder("o1");
    assert.equal(res.received, false);
    assert.equal(stockUpserts.length, 0);
    assert.match(res.reason ?? "", /отменена/i);
    assert.doesNotMatch(res.reason ?? "", /уже принята/i);
  });

  it("гонка: конкурентный запрос уже перевёл накладную в received между SELECT и UPDATE — остаток не зачисляется дважды (найдено внешним аудитом)", async () => {
    // SELECT ещё видит approved (order.status), но условный
    // UPDATE...RETURNING (opts.updateReturnsEmpty) имитирует, что параллельная
    // приёмка уже выиграла гонку и статус реально уже received.
    const order: OrderRow = { id: "o1", status: "approved", positions: [{ product: "TUC", order: 10 }] };
    const { db, stockUpserts } = receiveDb(order, [], [], { updateReturnsEmpty: true });
    const res = await new VendingService(db).receiveOrder();

    assert.equal(res.received, false);
    assert.match(res.reason ?? "", /уже принята/i);
    assert.equal(stockUpserts.length, 0); // остаток НЕ зачислен второй раз
  });

  it("распределение по автоматам уменьшает зачисление на склад (реальный процесс, лист «Snack склад»)", async () => {
    // Было 0, закуп 10, сразу 5 в автомат — на складе должно остаться только 5.
    const order: OrderRow = { id: "o1", status: "approved", positions: [{ product: "TUC", order: 10 }] };
    const { db, stockUpserts } = receiveDb(order);
    const res = await new VendingService(db).receiveOrder(undefined, "owner", { TUC: 5 });

    assert.equal(res.units, 5); // на складе
    assert.equal(res.distributedUnits, 5); // в автоматах
    assert.equal(stockUpserts.length, 1);
    assert.equal(stockUpserts[0]!.quantity, 5);
  });

  it("распределено больше заказанного — отсекается до order, склад не уходит в минус", async () => {
    const order: OrderRow = { id: "o1", status: "approved", positions: [{ product: "TUC", order: 10 }] };
    const { db, stockUpserts } = receiveDb(order);
    const res = await new VendingService(db).receiveOrder(undefined, "owner", { TUC: 15 });

    assert.equal(res.distributedUnits, 10); // не больше order
    assert.equal(res.units, 0);
    assert.equal(stockUpserts.length, 0); // toWarehouse=0 → нечего вставлять
  });

  it("распределение по алиасу резолвится к канону — то же пространство имён, что и склад §5.4", async () => {
    const order: OrderRow = {
      id: "o1",
      status: "approved",
      positions: [{ product: "Montella Вода минеральная 330ml", order: 24 }],
    };
    const { db, stockUpserts } = receiveDb(
      order,
      [{ productId: "p1", alias: "Montella" }],
      [{ id: "p1", name: "Montella Вода минеральная 330ml" }],
    );
    const res = await new VendingService(db).receiveOrder(undefined, "owner", { montella: 10 });

    assert.equal(res.distributedUnits, 10);
    assert.equal(res.units, 14);
    assert.equal(stockUpserts[0]!.quantity, 14);
  });

  it("без distributed — как раньше: весь order идёт на склад", async () => {
    const order: OrderRow = { id: "o1", status: "approved", positions: [{ product: "TUC", order: 10 }] };
    const { db } = receiveDb(order);
    const res = await new VendingService(db).receiveOrder();
    assert.equal(res.distributedUnits, 0);
    assert.equal(res.units, 10);
  });

  it("нечисловое/дробное значение в distributed — запись игнорируем, приёмку не роняем (найдено адверсариал-ревью)", async () => {
    const order: OrderRow = { id: "o1", status: "approved", positions: [{ product: "TUC", order: 10 }] };
    const { db, stockUpserts } = receiveDb(order);
    const res = await new VendingService(db).receiveOrder(undefined, "owner", {
      TUC: "not-a-number" as unknown as number,
    });

    assert.equal(res.distributedUnits, 0);
    assert.equal(res.units, 10); // весь order — на склад, будто distributed не передавали
    assert.deepEqual(res.unmatchedDistribution, []); // невалидная запись даже не попала в карту
    assert.equal(stockUpserts[0]!.quantity, 10);
  });

  it("отрицательное/дробное целое в distributed — тоже игнорируем (§5.7)", async () => {
    const order: OrderRow = { id: "o1", status: "approved", positions: [{ product: "TUC", order: 10 }] };
    const { db } = receiveDb(order);
    const res = await new VendingService(db).receiveOrder(undefined, "owner", { TUC: 2.5 });
    assert.equal(res.distributedUnits, 0);
    assert.equal(res.units, 10);
  });

  it("два алиаса одного товара в distributed суммируются, а не перезаписывают друг друга (найдено адверсариал-ревью)", async () => {
    const order: OrderRow = {
      id: "o1",
      status: "approved",
      positions: [{ product: "Montella Вода минеральная 330ml", order: 30 }],
    };
    const { db, stockUpserts } = receiveDb(
      order,
      [
        { productId: "p1", alias: "Montella" },
        { productId: "p1", alias: "Montella pet 0.33" },
      ],
      [{ id: "p1", name: "Montella Вода минеральная 330ml" }],
    );
    const res = await new VendingService(db).receiveOrder(undefined, "owner", {
      Montella: 5,
      "Montella pet 0.33": 8,
    });

    assert.equal(res.distributedUnits, 13); // 5+8, не 8 (последний не должен затирать первый)
    assert.equal(res.units, 17); // 30-13
    assert.equal(stockUpserts[0]!.quantity, 17);
  });

  it("distributed без совпадения ни с одной позицией — не роняет приёмку, весь order на склад, но видно в unmatchedDistribution (найдено адверсариал-ревью)", async () => {
    const order: OrderRow = { id: "o1", status: "approved", positions: [{ product: "TUC", order: 10 }] };
    const { db, stockUpserts } = receiveDb(order);
    const res = await new VendingService(db).receiveOrder(undefined, "owner", { Flint: 5 });

    assert.equal(res.distributedUnits, 0);
    assert.equal(res.units, 10); // не нашли совпадения — всё на склад, как раньше
    assert.deepEqual(res.unmatchedDistribution, ["Flint"]);
    assert.equal(stockUpserts[0]!.quantity, 10);
  });

  it("сопоставление позиции и distributed без учёта регистра/пробелов даже без алиаса", async () => {
    const order: OrderRow = { id: "o1", status: "approved", positions: [{ product: "TUC", order: 10 }] };
    const { db, stockUpserts } = receiveDb(order);
    const res = await new VendingService(db).receiveOrder(undefined, "owner", { "  tuc  ": 4 });

    assert.equal(res.distributedUnits, 4);
    assert.equal(res.units, 6);
    assert.deepEqual(res.unmatchedDistribution, []);
    assert.equal(stockUpserts[0]!.quantity, 6);
  });

  it("мост П3: позиции накладной становятся строками журнала прихода", async () => {
    const order: OrderRow = {
      id: "abcdef12-0000-0000-0000-000000000000",
      status: "approved",
      positions: [
        { product: "Montella", order: 12, price: 8500 },
        { product: "Fanta", order: 6 }, // цены нет → unitPrice null, не 0
        { product: "Zero", order: 4, price: 0 }, // 0 = «цены нет», не ноль сум
      ],
    };
    const { db, purchases, events } = receiveDb(order);
    const res = await new VendingService(db).receiveOrder();

    assert.equal(res.recordedPurchases, 3);
    assert.equal(purchases.length, 3);
    const m = purchases.find((p) => p.product === "Montella")!;
    assert.equal(m.extId, `${order.id}:montella`);
    assert.equal(m.source, "vending-order");
    assert.equal(m.qty, "12");
    assert.equal(m.unitPrice, "8500.00");
    assert.equal(m.total, "102000.00");
    assert.match(String(m.dt), /^\d{4}-\d{2}-\d{2}$/);
    const f = purchases.find((p) => p.product === "Fanta")!;
    assert.equal(f.unitPrice, null);
    assert.equal(f.total, null);
    const z = purchases.find((p) => p.product === "Zero")!;
    assert.equal(z.unitPrice, null);
    const payload = events[0]!.payload as { recordedPurchases: number };
    assert.equal(payload.recordedPurchases, 3);
  });

  it("мост П3: полностью розданная позиция всё равно попадает в журнал (закуплена целиком)", async () => {
    const order: OrderRow = {
      id: "o1",
      status: "approved",
      positions: [{ product: "TUC", order: 5, price: 12000 }],
    };
    const { db, purchases, stockUpserts } = receiveDb(order);
    const res = await new VendingService(db).receiveOrder(undefined, "owner", { TUC: 5 });

    assert.equal(res.units, 0, "весь заказ роздан мимо склада");
    assert.equal(stockUpserts.length, 0);
    assert.equal(purchases.length, 1, "журнал фиксирует закуп, а не только приход на склад");
    assert.equal(purchases[0]!.qty, "5");
  });

  it("мост П3: пустые позиции не рождают строк журнала", async () => {
    const order: OrderRow = { id: "o1", status: "approved", positions: [{ product: " ", order: 5 }] };
    const { db, purchases } = receiveDb(order);
    const res = await new VendingService(db).receiveOrder();
    assert.equal(res.recordedPurchases, 0);
    assert.equal(purchases.length, 0);
  });

  it("мост П3 молчит при живом зеркале mydon-stock — иначе журнал двоил бы закуп (найдено адверсариал-ревью)", async () => {
    const order: OrderRow = { id: "o1", status: "approved", positions: [{ product: "TUC", order: 5, price: 12000 }] };
    const { db, purchases, stockUpserts } = receiveDb(order);
    process.env.STOCK_DATABASE_URL = "postgresql://stock.example/db";
    try {
      const res = await new VendingService(db).receiveOrder();
      assert.equal(res.received, true, "приёмка работает как раньше");
      assert.equal(stockUpserts.length, 1, "склад зачисляется как раньше");
      assert.equal(res.recordedPurchases, 0);
      assert.equal(purchases.length, 0, "строк vending-order нет, пока закуп зеркалится из stock");
    } finally {
      delete process.env.STOCK_DATABASE_URL;
    }
  });

  it("мост П3: дубль канона в positions сливается в одну строку, distributed не применяется дважды", async () => {
    const order: OrderRow = {
      id: "o1",
      status: "approved",
      // Слоты «Кола»/«кола» без алиаса дают две позиции одного канона.
      positions: [
        { product: "Кола", order: 10, price: 5000 },
        { product: "кола", order: 8, price: 5000 },
      ],
    };
    const { db, purchases } = receiveDb(order);
    const res = await new VendingService(db).receiveOrder(undefined, "owner", { кола: 8 });

    assert.equal(purchases.length, 1, "один extId — одна строка журнала");
    assert.equal(purchases[0]!.qty, "18");
    assert.equal(purchases[0]!.total, "90000.00");
    assert.equal(res.recordedPurchases, 1);
    // Раздача 8 списывается ОДИН раз (с первой позиции), не с каждой копии.
    assert.equal(res.distributedUnits, 8);
    assert.equal(res.units, 10, "склад получает 18 − 8, а не 18 − 16");
  });

  it("мост П3: потолки магнитуд — кривая цена уходит в null, гигантское qty не пишется в журнал", async () => {
    const order: OrderRow = {
      id: "o1",
      status: "approved",
      positions: [
        { product: "TUC", order: 5, price: 99_000_000_000 },
        { product: "Flint", order: 2_000_000_000, price: 5000 },
      ],
    };
    const { db, purchases } = receiveDb(order);
    await new VendingService(db).receiveOrder();
    const tuc = purchases.find((p) => p.product === "TUC")!;
    assert.equal(tuc.unitPrice, null, "цена за пределами numeric(15,2)-здравого смысла = «цены нет»");
    assert.ok(!purchases.some((p) => p.product === "Flint"), "qty за потолком не попадает в журнал");
  });
});

/** Карточка товара в стабе цены/правил: поля правил закупа нужны тесту П5a. */
type ProductRow = {
  id: string;
  name: string;
  purchasePrice: string | null;
  packSize?: number;
  excludedFromPurchase?: boolean;
  fixedPurchaseQty?: number | null;
};
/**
 * Стаб: loadProductIndex() читает alias/product (thenable from), поиск
 * карточки — where→limit; транзакция копит update и события.
 */
function priceDb(productRow: ProductRow | null, aliases: unknown[] = [], products: unknown[] = []) {
  const updates: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const audits: Record<string, unknown>[] = [];
  const tx = {
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => {
          updates.push(v);
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (v: Record<string, unknown>) => {
        (table === event ? events : audits).push(v);
      },
    }),
  };
  let call = 0;
  const db = {
    select: () => ({
      from: () => {
        const rows = Promise.resolve(call++ === 0 ? aliases : products);
        return {
          where: () => ({ limit: async () => (productRow ? [productRow] : []) }),
          then: rows.then.bind(rows),
        };
      },
    }),
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
  } as never;
  return { db, updates, events, audits };
}

describe("Вендинг Core: правка закупочной цены (П3)", () => {
  it("первая цена (текущей нет) проходит без гейта и пишет событие с аудитом", async () => {
    const { db, updates, events, audits } = priceDb({ id: "p1", name: "TUC", purchasePrice: null });
    const res = await new VendingService(db).setProductPrice("TUC", 12000, "owner");

    assert.equal(res.ok, true);
    assert.equal(res.product, "TUC");
    assert.equal(res.oldPrice, null);
    assert.equal(updates[0]!.purchasePrice, "12000.00");
    assert.equal(events[0]!.type, "vending.price_changed");
    assert.equal(audits[0]!.action, "vending.product.set_price");
  });

  it("гейт: отклонение больше 20% без подтверждения — отказ, цена не тронута", async () => {
    const { db, updates } = priceDb({ id: "p1", name: "TUC", purchasePrice: "10000" });
    const res = await new VendingService(db).setProductPrice("TUC", 15000);

    assert.equal(res.ok, false);
    assert.equal(res.reason, "spike");
    assert.equal(res.deviationPct, 50);
    assert.equal(res.oldPrice, 10000);
    assert.equal(updates.length, 0);
  });

  it("гейт снимается confirmed=true", async () => {
    const { db, updates } = priceDb({ id: "p1", name: "TUC", purchasePrice: "10000" });
    const res = await new VendingService(db).setProductPrice("TUC", 15000, "owner", true);
    assert.equal(res.ok, true);
    assert.equal(updates[0]!.purchasePrice, "15000.00");
  });

  it("в пределах порога — без подтверждения", async () => {
    const { db } = priceDb({ id: "p1", name: "TUC", purchasePrice: "10000" });
    const res = await new VendingService(db).setProductPrice("TUC", 11500);
    assert.equal(res.ok, true);
  });

  it("алиас резолвится в канон до поиска карточки", async () => {
    const { db } = priceDb({ id: "p1", name: "TUC", purchasePrice: null }, [{ productId: "p1", alias: "тук" }], [
      { id: "p1", name: "TUC", purchasePrice: null, packSize: 1 },
    ]);
    const res = await new VendingService(db).setProductPrice("тук", 9000);
    assert.equal(res.ok, true);
    assert.equal(res.product, "TUC");
  });

  it("незнакомый товар — not_found, ничего не пишем", async () => {
    const { db, updates, events } = priceDb(null);
    const res = await new VendingService(db).setProductPrice("Чипсы новые", 9000);
    assert.equal(res.ok, false);
    assert.equal(res.reason, "not_found");
    assert.equal(updates.length, 0);
    assert.equal(events.length, 0);
  });

  it("мусорный вход (0, NaN, пустое имя) — отказ до записи", async () => {
    const { db } = priceDb(null);
    assert.equal((await new VendingService(db).setProductPrice("TUC", 0)).ok, false);
    assert.equal((await new VendingService(db).setProductPrice("TUC", Number.NaN)).ok, false);
    assert.equal((await new VendingService(db).setProductPrice("  ", 100)).ok, false);
  });
});

describe("Вендинг Core: инвентаризация склада (§5.4)", () => {
  it("перезаписывает остаток по товару (upsert), пустое имя пропускает", async () => {
    const { db, inserts } = writeDb();
    const svc = new VendingService(db);
    const res = await svc.ingestStock({
      countedAt: "2026-08-02T09:00:00Z",
      items: [
        { product: "Montella", quantity: 24 },
        { product: "  ", quantity: 5 }, // пустое имя → пропуск
      ],
    });
    assert.deepEqual(res, { items: 2, adjustments: [] }); // счётчик по входу, расхождений нет (склад пуст)
    // Записана только валидная позиция.
    assert.equal(inserts.length, 1);
    const v = inserts[0]!.values as { productName: string; quantity: number };
    assert.equal(v.productName, "Montella");
    assert.equal(v.quantity, 24);
  });

  it("имя-вариант приводится к канону через алиас (регистр не важен)", async () => {
    const { db, inserts } = writeDb(
      [{ productId: "p1", alias: "Montella" }],
      [{ id: "p1", name: "Montella Вода минеральная 330ml" }],
    );
    const svc = new VendingService(db);
    await svc.ingestStock({ items: [{ product: "montella", quantity: 7 }] });
    const v = inserts[0]!.values as { productName: string };
    assert.equal(v.productName, "Montella Вода минеральная 330ml");
  });

  it("неизвестное имя (нет алиаса) остаётся как есть — на разбор позже", async () => {
    const { db, inserts } = writeDb([], []);
    const svc = new VendingService(db);
    await svc.ingestStock({ items: [{ product: "Новый Товар", quantity: 3 }] });
    const v = inserts[0]!.values as { productName: string };
    assert.equal(v.productName, "Новый Товар");
  });

  it("недостача при пересчёте: было 55 → стало 54, оценена по цене (реальный лист 02.08.2026)", async () => {
    const products = [{ id: "p1", name: "Montella Вода минеральная 330ml", purchasePrice: "2090.00" }];
    const stock = [{ productName: "Montella Вода минеральная 330ml", quantity: 55 }];
    const { db, inserts } = writeDb(
      [{ productId: "p1", alias: "Montella pet 0.33" }],
      products,
      stock,
    );
    const svc = new VendingService(db);
    const res = await svc.ingestStock({ items: [{ product: "Montella pet 0.33", quantity: 54 }] });

    assert.equal(res.adjustments.length, 1);
    const a = res.adjustments[0]!;
    assert.equal(a.product, "Montella Вода минеральная 330ml");
    assert.equal(a.before, 55);
    assert.equal(a.after, 54);
    assert.equal(a.delta, -1); // недостача
    assert.equal(a.value, 2090); // |delta| × цена
    assert.equal(a.noPrice, false);

    // Расхождение попадает в журнал (событие + audit), не только в ответ метода.
    const ev = inserts.find((i) => (i.values as { type?: string }).type === "vending.stock.recounted");
    assert.ok(ev, "должно быть событие о пересчёте");
    const audit = inserts.find((i) => (i.values as { action?: string }).action === "vending.stock.recount");
    assert.ok(audit, "должна быть запись в журнале действий");
  });

  it("излишек при пересчёте — тоже расхождение, но со знаком плюс", async () => {
    const stock = [{ productName: "Fanta Classic CAN 250ml", quantity: 7 }];
    const { db } = writeDb([], [], stock);
    const svc = new VendingService(db);
    const res = await svc.ingestStock({ items: [{ product: "Fanta Classic CAN 250ml", quantity: 19 }] });
    assert.equal(res.adjustments.length, 1);
    assert.equal(res.adjustments[0]!.delta, 12);
  });

  it("без цены в прайсе — value 0, noPrice=true, но расхождение видно", async () => {
    const stock = [{ productName: "Новый Товар", quantity: 10 }];
    const { db } = writeDb([], [], stock);
    const svc = new VendingService(db);
    const res = await svc.ingestStock({ items: [{ product: "Новый Товар", quantity: 8 }] });
    assert.equal(res.adjustments[0]!.value, 0);
    assert.equal(res.adjustments[0]!.noPrice, true);
  });

  it("цена с копейками не даёт «грязный» хвост float — value округлён до копеек", async () => {
    // 3 × 2090.55 = 6271.6499999999996 в чистом IEEE-754 — без округления это
    // легло бы в неизменяемый журнал как есть (найдено адверсариал-ревью).
    const products = [{ id: "p1", name: "Товар с копейками", purchasePrice: "2090.55" }];
    const stock = [{ productName: "Товар с копейками", quantity: 10 }];
    const { db } = writeDb([], products, stock);
    const svc = new VendingService(db);
    const res = await svc.ingestStock({ items: [{ product: "Товар с копейками", quantity: 7 }] });
    assert.equal(res.adjustments[0]!.value, 6271.65);
  });

  it("событие пересчёта пишет ПЕРЕДАННОГО actor, а не жёстко owner", async () => {
    const stock = [{ productName: "Fanta Classic CAN 250ml", quantity: 7 }];
    const { db, inserts } = writeDb([], [], stock);
    const svc = new VendingService(db);
    await svc.ingestStock({ items: [{ product: "Fanta Classic CAN 250ml", quantity: 19 }] }, "manager");
    const ev = inserts.find((i) => (i.values as { type?: string }).type === "vending.stock.recounted");
    assert.equal((ev!.values as { source: string }).source, "manager");
  });

  it("опоздавший пересчёт (countedAt старше уже сохранённого) — не откатывает остаток и не считается расхождением (найдено внешним аудитом, P2)", async () => {
    const stock = [
      { productName: "Montella Вода минеральная 330ml", quantity: 54, countedAt: new Date("2026-08-02T12:00:00Z") },
    ];
    const { db, inserts } = writeDb([], [], stock);
    const svc = new VendingService(db);
    const res = await svc.ingestStock({
      countedAt: "2026-08-02T09:00:00Z", // раньше уже сохранённого 12:00 — опоздавшее сообщение
      items: [{ product: "Montella Вода минеральная 330ml", quantity: 999 }],
    });

    assert.deepEqual(res.adjustments, []); // мнимого расхождения по устаревшим данным нет
    assert.equal(inserts.length, 0); // и более новый остаток не перезаписан старым
  });

  it("первый ввод по товару (в складе строки ещё не было) — не расхождение", async () => {
    const { db } = writeDb([], [], []); // склад пуст — ничего сравнивать
    const svc = new VendingService(db);
    const res = await svc.ingestStock({ items: [{ product: "Совершенно новый", quantity: 30 }] });
    assert.deepEqual(res.adjustments, []);
  });

  it("количество не изменилось — не расхождение (не шумим по пустякам)", async () => {
    const stock = [{ productName: "Sprite 250ml", quantity: 19 }];
    const { db } = writeDb([], [], stock);
    const svc = new VendingService(db);
    const res = await svc.ingestStock({ items: [{ product: "Sprite 250ml", quantity: 19 }] });
    assert.deepEqual(res.adjustments, []);
  });

  it("два алиаса на ОДИН канон в одной инвентаризации — одна дельта, не две (регресс)", async () => {
    // «Montella pet 0.33» и «montella zero 0.33» — оба ведут на один товар.
    // Реальная смена: было 7 → стало 12 (последняя позиция в списке). Наивный
    // снимок «до» один раз на батч даёт ДВЕ дельты от устаревшего 7 — баг,
    // пойманный адверсариал-ревью до релиза.
    const canonical = "Montella Вода минеральная 330ml";
    const products = [{ id: "p1", name: canonical, purchasePrice: "2090.00" }];
    const aliases = [
      { productId: "p1", alias: "Montella pet 0.33" },
      { productId: "p1", alias: "montella zero 0.33" },
    ];
    const stock = [{ productName: canonical, quantity: 7 }];
    const { db, inserts } = writeDb(aliases, products, stock);
    const svc = new VendingService(db);

    const res = await svc.ingestStock({
      items: [
        { product: "Montella pet 0.33", quantity: 10 },
        { product: "montella zero 0.33", quantity: 12 },
      ],
    });

    assert.equal(res.adjustments.length, 1, "должна быть ровно одна дельта на канонический товар");
    const a = res.adjustments[0]!;
    assert.equal(a.before, 7);
    assert.equal(a.after, 12); // последняя позиция в списке побеждает
    assert.equal(a.delta, 5);
    assert.equal(a.value, 5 * 2090);

    // И записан склад — тоже РОВНО одной строкой на канон (не дважды).
    const stockInserts = inserts.filter((i) => (i.values as { productName?: string }).productName === canonical);
    assert.equal(stockInserts.length, 1);
    assert.equal((stockInserts[0]!.values as { quantity: number }).quantity, 12);
  });
});

describe("Вендинг Core: приём слотов", () => {
  it("пишет актуальный слот и снапшот, считает is_valid", async () => {
    const { db, inserts } = writeDb();
    const svc = new VendingService(db);
    const res = await svc.ingestSlots({
      machines: [{ serial: "AH", slots: [{ coilId: "31", product: "Montella", capacity: 6, quantity: 0 }] }],
    });
    assert.deepEqual(res, { machines: 1, slots: 1, linked: 0, pruned: 0, pruneErrors: [], skipped: [] });
    // Один слот → одна строка планограммы + одна строка истории.
    assert.equal(inserts.filter((i) => i.table === "machine_slot").length, 1);
    assert.equal(inserts.filter((i) => i.table === "slot_snapshot").length, 1);
    const ms = inserts.find((i) => i.table === "machine_slot")!.values as { isValid: boolean; productName: string | null };
    assert.equal(ms.isValid, true); // 0 < 6 ≤ 100
    assert.equal(ms.productName, "Montella");
  });

  it("пустое имя товара → null (слот не назначен), вместимость 0 → невалиден", async () => {
    const { db, inserts } = writeDb();
    const svc = new VendingService(db);
    await svc.ingestSlots({ machines: [{ serial: "M", slots: [{ coilId: "1", product: "  ", capacity: 0, quantity: 0 }] }] });
    const ms = inserts.find((i) => i.table === "machine_slot")!.values as { isValid: boolean; productName: string | null };
    assert.equal(ms.productName, null);
    assert.equal(ms.isValid, false);
  });

  it("привязывает слот к карточке, даже если в реестре серийник с приставкой c", async () => {
    // Боевой случай: Ourvend прислал «2508160376», в реестре лежит
    // «c2508160376» (форма из mydon-stock). Раньше machine_id оставался NULL.
    const { db, inserts } = writeDb([], [], [], [{ id: "ent-1", ref: "c2508160376" }]);
    const svc = new VendingService(db);
    const res = await svc.ingestSlots({
      machines: [{ serial: "2508160376", slots: [{ coilId: "1", product: "Snickers", capacity: 11, quantity: 8 }] }],
    });
    assert.equal(res.linked, 1);
    const ms = inserts.find((i) => i.table === "machine_slot")!.values as { machineId: string | null };
    assert.equal(ms.machineId, "ent-1");
  });

  it("код кофемашины на c не путается с серийником Ourvend", async () => {
    // c7a6181f0000 — живой автомат; срезать приставку у него нельзя.
    const { db, inserts } = writeDb([], [], [], [{ id: "kofe", ref: "c7a6181f0000" }]);
    const svc = new VendingService(db);
    const res = await svc.ingestSlots({
      machines: [{ serial: "c7a6181f0000", slots: [{ coilId: "1", product: "x", capacity: 1, quantity: 1 }] }],
    });
    assert.equal(res.linked, 1);
    const ms = inserts.find((i) => i.table === "machine_slot")!.values as { machineId: string | null };
    assert.equal(ms.machineId, "kofe");
  });

  it("автомат без карточки в реестре принимается, machine_id остаётся пустым", async () => {
    // 2508160355 и 2508160358 есть в Ourvend, но карточек у них нет.
    const { db, inserts } = writeDb([], [], [], [{ id: "ent-1", ref: "c2508160376" }]);
    const svc = new VendingService(db);
    const res = await svc.ingestSlots({
      machines: [{ serial: "2508160355", slots: [{ coilId: "1", product: "", capacity: 0, quantity: 0 }] }],
    });
    assert.equal(res.machines, 1);
    assert.equal(res.linked, 0);
    const ms = inserts.find((i) => i.table === "machine_slot")!.values as { machineId: string | null };
    assert.equal(ms.machineId, null);
  });

  it("раздутый автомат пропускается, остальные принимаются (а не падает весь приём)", async () => {
    // Прежде потолок стоял валидатором на входе и отменял ВЕСЬ запрос.
    const many = Array.from({ length: MAX_SLOTS_PER_MACHINE + 1 }, (_, i) => ({
      coilId: String(i + 1),
      product: "x",
      capacity: 1,
      quantity: 1,
    }));
    const { db, inserts } = writeDb();
    const svc = new VendingService(db);
    const res = await svc.ingestSlots({
      machines: [
        { serial: "РАЗДУТЫЙ", slots: many },
        { serial: "ОБЫЧНЫЙ", slots: [{ coilId: "1", product: "Twix", capacity: 11, quantity: 9 }] },
      ],
    });
    assert.equal(res.machines, 1, "принят только обычный автомат");
    assert.equal(res.slots, 1);
    assert.deepEqual(res.skipped, [
      { serial: "РАЗДУТЫЙ", slots: MAX_SLOTS_PER_MACHINE + 1, reason: "слишком много слотов" },
    ]);
    // Слоты обычного автомата записаны — приём не отменён.
    assert.equal(inserts.filter((i) => i.table === "machine_slot").length, 1);
    // И пропуск не растворился: он в журнале событий.
    assert.equal(inserts.filter((i) => i.table === "event").length, 1);
  });

  it("автомат ровно на потолке ещё принимается", async () => {
    const many = Array.from({ length: MAX_SLOTS_PER_MACHINE }, (_, i) => ({
      coilId: String(i + 1),
      product: "x",
      capacity: 1,
      quantity: 1,
    }));
    const { db } = writeDb();
    const svc = new VendingService(db);
    const res = await svc.ingestSlots({ machines: [{ serial: "НА_ГРАНИ", slots: many }] });
    assert.equal(res.machines, 1);
    assert.deepEqual(res.skipped, []);
  });

  it("потолок выше живого максимума парка (488 слотов у Olma Администрация)", () => {
    assert.ok(MAX_SLOTS_PER_MACHINE > 488, "иначе самый большой автомат парка перестанет приниматься");
  });
});

describe("Вендинг Core: журнал сбора — finishSyncRun (§ коллектор)", () => {
  /** Стаб: update(...).returning() отдаёт строку только если id "существует". */
  function syncRunDb(existingId: string | null) {
    const tx = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => (existingId ? [{ id: existingId }] : []),
          }),
        }),
      }),
    };
    return { update: tx.update } as never;
  }

  it("известный id — ok: true", async () => {
    const db = syncRunDb("run-1");
    const svc = new VendingService(db);
    const res = await svc.finishSyncRun("run-1", {
      status: "success",
      machinesTotal: 29,
      machinesOk: 25,
      durationMs: 1200,
    });
    assert.deepEqual(res, { ok: true });
  });

  it("неизвестный id — ok: false, а не молчаливый успех (найдено внешним аудитом, P2)", async () => {
    const db = syncRunDb(null);
    const svc = new VendingService(db);
    const res = await svc.finishSyncRun("no-such-id", {
      status: "failed",
      machinesTotal: 0,
      machinesOk: 0,
      durationMs: 500,
    });
    assert.deepEqual(res, { ok: false });
  });
});

describe("Вендинг Core: касса закупа (§5.8)", () => {
  /**
   * Стаб для recordCashSession: insert().values().returning() → строка с id
   * и createdAt (в реальной БД проставляется defaultNow(), .values() его не
   * передаёт — стаб должен достроить сам, иначе .toISOString() упадёт на undefined).
   */
  function cashInsertDb() {
    const inserted: Record<string, unknown>[] = [];
    const db = {
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          inserted.push(v);
          return { returning: async () => [{ id: "cs1", createdAt: new Date("2026-08-02T12:00:00Z"), ...v }] };
        },
      }),
    } as never;
    return { db, inserted };
  }

  it("воспроизводит реальную запись 02.08.2026 до сума и сохраняет снимок", async () => {
    const { db, inserted } = cashInsertDb();
    const svc = new VendingService(db);
    const res = await svc.recordCashSession(2_400_000, [
      { name: "корзинка", lines: [{ label: "47×2090", amount: 98_230 }] },
      { name: "базар", lines: [{ label: "снеки", amount: 376_300 }] },
      { name: "базар", lines: [{ label: "напитки", amount: 1_023_000 }] },
    ]);
    assert.equal(res.totalSpent, 1_497_530);
    assert.equal(res.remainder, 902_470);
    assert.equal(res.id, "cs1");
    // В базу уходят СТРОКОВЫЕ numeric (toFixed) — Postgres numeric ожидает текст, не число.
    assert.equal(inserted[0]!.receivedAmount, "2400000.00");
    assert.equal(inserted[0]!.remainder, "902470.00");
  });

  it("createdBy по умолчанию owner, можно переопределить", async () => {
    const { db, inserted } = cashInsertDb();
    await new VendingService(db).recordCashSession(100_000, [{ name: "базар", lines: [{ label: "X", amount: 10_000 }] }]);
    assert.equal(inserted[0]!.createdBy, "owner");

    const { db: db2, inserted: inserted2 } = cashInsertDb();
    await new VendingService(db2).recordCashSession(100_000, [], "manager");
    assert.equal(inserted2[0]!.createdBy, "manager");
  });

  it("cashSessions() читает numeric-строки как числа, свежие сверху", async () => {
    const rows = [
      {
        id: "cs2",
        receivedAmount: "2400000.00",
        categories: [{ name: "базар", lines: [], subtotal: 100 }],
        totalSpent: "1497530.00",
        remainder: "902470.00",
        createdBy: "owner",
        createdAt: new Date("2026-08-02T10:00:00Z"),
      },
    ];
    const db = { select: () => ({ from: () => ({ orderBy: () => ({ limit: async () => rows }) }) }) } as never;
    const list = await new VendingService(db).cashSessions();
    assert.equal(list[0]!.receivedAmount, 2_400_000);
    assert.equal(list[0]!.remainder, 902_470);
    assert.equal(list[0]!.createdAt, "2026-08-02T10:00:00.000Z");
  });
});

describe("Зеркало слотов умеет сокращаться", () => {
  it("исчезнувшие слоты убираются, а не живут вечно", async () => {
    // У 2508160376 вендор годами отдавал 488 позиций; после отсева фантомов их
    // 43. Upsert только добавляет и обновляет — без уборки в планограмме
    // навсегда остались бы 445 несуществующих слотов.
    const { db, pruneRows } = writeDb();
    pruneRows.push({ id: "s1" }, { id: "s2" });
    const svc = new VendingService(db);
    const res = await svc.ingestSlots({
      machines: [{ serial: "2508160376", slots: [{ coilId: "1", product: "Twix", capacity: 11, quantity: 9 }] }],
    });
    assert.equal(res.pruned, 2);
  });

  it("пустой список слотов планограмму НЕ стирает", async () => {
    // Пусто — это почти всегда сбой выгрузки, а не автомат, из которого вынули
    // все пружины. Стирать по молчанию источника значит терять данные без
    // единой ошибки.
    const { db, pruneRows } = writeDb();
    pruneRows.push({ id: "s1" }, { id: "s2" }, { id: "s3" });
    const svc = new VendingService(db);
    const res = await svc.ingestSlots({ machines: [{ serial: "ПУСТОЙ", slots: [] }] });
    assert.equal(res.pruned, 0, "уборка не должна была запуститься");
    assert.equal(res.slots, 0);
  });
});

describe("Сбой уборки не стоит снимка", () => {
  it("упавшая уборка НЕ откатывает записанные слоты", async () => {
    // 07.08.2026 уборка шла в одной транзакции с записью, и ошибка в условии
    // удаления откатывала INSERT: зеркало перестало обновляться вовсе, а не
    // просто не почистилось. Побочная функция утаскивала основную.
    const { db, inserts, failPrune } = writeDb();
    failPrune();
    const svc = new VendingService(db);
    const res = await svc.ingestSlots({
      machines: [{ serial: "2508160376", slots: [{ coilId: "1", product: "Twix", capacity: 11, quantity: 9 }] }],
    });

    assert.equal(res.slots, 1, "снимок обязан быть записан");
    assert.equal(inserts.filter((i) => i.table === "machine_slot").length, 1);
    assert.equal(res.pruned, 0);
    assert.equal(res.pruneErrors.length, 1, "о сбое уборки молчать нельзя");
    assert.equal(res.pruneErrors[0]!.serial, "2508160376");
  });

  it("сбой уборки записывается событием, а не теряется", async () => {
    const { db, inserts, failPrune } = writeDb();
    failPrune();
    const svc = new VendingService(db);
    await svc.ingestSlots({
      machines: [{ serial: "M1", slots: [{ coilId: "1", product: "x", capacity: 1, quantity: 1 }] }],
    });
    const события = inserts.filter((i) => i.table === "event");
    assert.equal(события.length, 1);
    assert.equal((события[0]!.values as { type: string }).type, "vending.slots.prune_failed");
  });

  it("сбой на одном автомате не лишает уборки остальных", async () => {
    // Каждый автомат убирается своим запросом: общий try свёл бы всю пачку
    // к судьбе первой ошибки.
    const { db } = writeDb();
    const svc = new VendingService(db);
    const res = await svc.ingestSlots({
      machines: [
        { serial: "A", slots: [{ coilId: "1", product: "x", capacity: 1, quantity: 1 }] },
        { serial: "B", slots: [{ coilId: "1", product: "y", capacity: 1, quantity: 1 }] },
      ],
    });
    assert.equal(res.machines, 2);
    assert.equal(res.pruneErrors.length, 0);
  });
});

describe("Продажи Ourvend знают свой автомат", () => {
  it("привязка идёт по канону серийника: реестр с приставкой, вендор без", async () => {
    // Вопрос «сколько принёс ЭТОТ автомат» отвечался для mydon-stock и не
    // отвечался для Ourvend: product_sale и machine_sale несли только серийник.
    const { db, inserts } = writeDb([], [], [], [{ id: "ent-1", ref: "c2508160376" }]);
    const svc = new VendingService(db);
    await svc.ingestSales({
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-08-07T00:00:00.000Z",
      productSales: [{ serial: "2508160376", product: "Snickers", quantity: 5 }],
      machineSales: [{ serial: "2508160376", totalAmount: 561000, totalCount: 66 }],
    });
    const строки = inserts.filter((i) => (i.values as { machineSerial?: string }).machineSerial === "2508160376");
    assert.ok(строки.length >= 2, "обе таблицы продаж должны получить строку");
    for (const r of строки) {
      assert.equal((r.values as { machineId: string | null }).machineId, "ent-1");
    }
  });

  it("продажа автомата без карточки ложится и ждёт", async () => {
    // Автомат появляется в Ourvend раньше карточки — так было с 2508160355
    // и 2508160358. Отвергать такую продажу значит терять выручку.
    const { db, inserts } = writeDb([], [], [], []);
    const svc = new VendingService(db);
    await svc.ingestSales({
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-08-07T00:00:00.000Z",
      productSales: [{ serial: "2508160355", product: "Twix", quantity: 1 }],
      machineSales: [],
    });
    const строка = inserts.find((i) => (i.values as { productName?: string }).productName === "Twix")!;
    assert.equal((строка.values as { machineId: string | null }).machineId, null);
  });
});

describe("Вендинг Core: план закупа (П5a)", () => {
  type Card = { entityId: string; status: string };
  type Ent = { id: string; name: string; externalRef: string | null; type: string };
  /** Стаб: слоты, склад, товары, карточки автоматов, настройки — по ссылке на таблицу. */
  function planDb(o: {
    slots: Row[];
    stock?: StockRow[];
    products?: ProdRow[];
    aliases?: AliasRow[];
    cards?: Card[];
    entities?: Ent[];
    config?: { key: string; value: string }[];
    sales?: SaleRow[];
  }) {
    return {
      select: () => ({
        from: (t: unknown) => {
          const rows: unknown[] =
            t === vendingAlias
              ? (o.aliases ?? [])
              : t === vendingProduct
                ? (o.products ?? [])
                : t === vendingStock
                  ? (o.stock ?? [])
                  : t === machineCard
                    ? (o.cards ?? [])
                    : t === entity
                      ? (o.entities ?? [])
                      : t === systemConfig
                        ? (o.config ?? [])
                        : t === productSale
                          ? (o.sales ?? [])
                          : o.slots;
          const p = Promise.resolve(rows);
          return { where: async () => rows, then: p.then.bind(p) };
        },
      }),
    } as never;
  }
  const slots: Row[] = [
    { machineSerial: "2508160376", coilId: "1", productName: "Fanta", capacity: 5, quantity: 1 },
    { machineSerial: "2508160359", coilId: "1", productName: "Fanta", capacity: 5, quantity: 3 },
    { machineSerial: "2508160355", coilId: "1", productName: "Fanta", capacity: 5, quantity: 0 }, // SKLAD 5S — warehouse
  ];
  const entities: Ent[] = [
    { id: "m-olma", name: "Olma", externalRef: "c2508160376", type: "machine" },
    { id: "m-ah", name: "American Hospital", externalRef: "c2508160359", type: "machine" },
    { id: "m-sk", name: "SKLAD 5S", externalRef: "c2508160355", type: "machine" },
  ];
  const cards: Card[] = [
    { entityId: "m-olma", status: "in_service" },
    { entityId: "m-ah", status: "in_service" },
    { entityId: "m-sk", status: "warehouse" },
  ];
  const products: ProdRow[] = [
    { id: "p1", name: "Fanta", purchasePrice: "5167", packSize: 12, excludedFromPurchase: false, fixedPurchaseQty: null },
  ];
  // Продажи обязательны: без них позиция уходит в «не закупать — нет продаж»
  // (§5.5), закуп по ней не считается и в автоматы грузится только склад.
  const sales: SaleRow[] = [
    { machineSerial: "2508160359", productName: "Fanta", quantity: 7, capturedAt: new Date("2026-08-20T00:00:00Z") },
  ];

  it("автомат не в строю пропущен и виден в warnings; маршрут из настройки; раздача по слотам", async () => {
    const db = planDb({
      slots,
      entities,
      cards,
      products,
      sales,
      stock: [{ productName: "Fanta", quantity: 2, countedAt: new Date() }],
      config: [{ key: "VENDING_ROUTE_ORDER", value: "2508160359,2508160376" }],
    });
    const plan = await new VendingService(db).plan();
    assert.deepEqual(plan.machines.map((m) => m.serial), ["2508160359", "2508160376"]);
    assert.equal(plan.machines[0]!.name, "American Hospital");
    assert.equal(plan.machines[0]!.routeIndex, 1);
    assert.ok(plan.warnings.some((w) => w.code === "machine_skipped" && w.message.includes("SKLAD 5S")));
    // need: AH 2, Olma 4 = 6; stock 2; order 12 → fromPurchase 6, склад не трогаем
    assert.equal(plan.summary.totalFromPurchase, 6);
    assert.equal(plan.summary.totalFromStock, 0);
    assert.equal(plan.machines[0]!.slots[0]!.fromPurchase, 2);
    assert.equal(plan.stock.totalBefore, 2);
    assert.equal(plan.stock.totalAfter, 2 + 6);
    assert.equal(plan.stock.stale, false);
  });

  it("склад старше 3 дней → warning stock_stale и stock.stale=true", async () => {
    const old = new Date(Date.now() - 4 * 86_400_000);
    const db = planDb({ slots, entities, cards, products, sales, stock: [{ productName: "Fanta", quantity: 2, countedAt: old }] });
    const plan = await new VendingService(db).plan();
    assert.equal(plan.stock.stale, true);
    assert.ok(plan.warnings.some((w) => w.code === "stock_stale"));
  });

  it("без настройки маршрут — по имени автомата", async () => {
    const db = planDb({ slots, entities, cards, products, sales });
    const plan = await new VendingService(db).plan();
    assert.deepEqual(plan.machines.map((m) => m.name), ["American Hospital", "Olma"]);
  });

  it("исключённый товар уходит в excludedByRule, фикс — в order", async () => {
    const prods: ProdRow[] = [
      { id: "p1", name: "Fanta", purchasePrice: "5167", packSize: 12, excludedFromPurchase: true, fixedPurchaseQty: null },
    ];
    const db = planDb({ slots, entities, cards, products: prods, sales });
    const plan = await new VendingService(db).plan();
    assert.equal(plan.summary.items.length, 0);
    assert.equal(plan.summary.excludedByRule[0]!.product, "Fanta");
  });
});

describe("Вендинг Core: правила товара (П5a)", () => {
  it("меняет блок/исключение/фикс в транзакции с событием и аудитом; 0 снимает фикс", async () => {
    const { db, updates, events, audits } = priceDb({
      id: "p1",
      name: "TUC",
      purchasePrice: null,
      packSize: 10,
      excludedFromPurchase: false,
      fixedPurchaseQty: 5,
    });
    const res = await new VendingService(db).setProductRules(
      "TUC",
      { packSize: 5, excludedFromPurchase: true, fixedPurchaseQty: 0 },
      "owner",
    );
    assert.equal(res.ok, true);
    assert.deepEqual(updates[0], { packSize: 5, excludedFromPurchase: true, fixedPurchaseQty: null, updatedAt: updates[0]!.updatedAt });
    assert.equal(events[0]!.type, "vending.product_rules_changed");
    assert.equal(audits[0]!.action, "vending.product.set_rules");
  });

  it("товар не найден → not_found", async () => {
    const { db } = priceDb(null);
    const res = await new VendingService(db).setProductRules("Нет такого", { packSize: 5 });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "not_found");
  });
});

describe("Вендинг Core: заявка хранит разбивку по автоматам (П5a)", () => {
  // Тот же стаб, что в describe «отправка закупа на утверждение (§5.7)» выше: purchaseDb + очередь согласований.
  const t = new Date("2026-08-02T00:00:00Z");
  const slots: Row[] = [
    { machineSerial: "AH", coilId: "1", productName: "Montella", capacity: 6, quantity: 2 },
    { machineSerial: "OL", coilId: "1", productName: "Montella", capacity: 6, quantity: 3 },
  ];
  const sales: SaleRow[] = [{ machineSerial: "AH", productName: "Montella", quantity: 14, capturedAt: t }];
  const products: ProdRow[] = [{ name: "Montella", purchasePrice: "5000.00", packSize: 12 }];

  it("positions содержат perMachine/fromPurchase/fromStock/unfilled", async () => {
    const requests: { payload?: Record<string, unknown> }[] = [];
    const svc = {
      request: async (input: { payload?: Record<string, unknown> }) => {
        requests.push(input);
        return { id: "ap-1" };
      },
    };
    const vending = new VendingService(purchaseDb(slots, sales, products), svc as never);
    await vending.submitPurchase("owner");
    const po = (requests[0]!.payload as { purchaseOrder: { positions: Record<string, unknown>[] } }).purchaseOrder;
    const pos = po.positions[0]!;
    assert.deepEqual(pos.perMachine, { AH: 4, OL: 3 });
    assert.equal(pos.fromPurchase, 7); // need 7, склад 0, order 12 → в автоматы 7
    assert.equal(pos.fromStock, 0);
    assert.equal(pos.unfilled, 0);
    assert.deepEqual(
      Object.keys(pos).sort(),
      ["buy", "costRounded", "fromPurchase", "fromStock", "noPrice", "order", "pack", "perMachine", "price", "product", "unfilled"],
    );
  });
});
