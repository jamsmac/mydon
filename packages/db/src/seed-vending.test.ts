import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeProductName } from "@mydon/shared";
import { vendingAlias, vendingProduct, vendingStock } from "./schema";
import {
  DONOR_PRICE_DIFFS,
  VENDING_ALIASES,
  VENDING_PRICELIST,
  VENDING_PURCHASE_RULES,
  packOf,
  seedVendingAliases,
  seedVendingRules,
} from "./seed-vending";

describe("Прайс вендинга (Приложение А)", () => {
  it("имена уникальны, цены положительны", () => {
    const names = VENDING_PRICELIST.map((p) => p.name);
    assert.equal(new Set(names).size, names.length, "дублей имён быть не должно");
    assert.ok(VENDING_PRICELIST.every((p) => p.price > 0), "цена должна быть положительной");
  });

  it("кратность по правилу 02.08.2026: напитки 12, снеки 10", () => {
    assert.equal(packOf("drink"), 12);
    assert.equal(packOf("snack"), 10);
    // Тот же источник кратности спрашивает overlay правил (строка «нетронута»),
    // а категория в vending_product шире категорий прайса.
    assert.equal(packOf("other"), 10);
  });

  it("совпадает с контрольным примером по ключевым позициям", () => {
    const by = new Map(VENDING_PRICELIST.map((p) => [p.name, p]));
    // Числа из Приложения Г/А — сверка, чтобы прайс не разъехался.
    assert.equal(by.get("Montella Вода минеральная 330ml")?.price, 2090);
    assert.equal(by.get("СуперКонтик Шоколадный вкус 100gr")?.price, 5000);
    assert.equal(by.get("Snickers 50gr")?.category, "snack");
    // Фискальный каталог напитков (реестр владельца, ИКПУ/Multikassa) —
    // закупочная цена стабильна между периодами до/после 26.08.2025.
    assert.equal(by.get("Red Bull CAN 0,25")?.price, 16500);
    assert.equal(by.get("Coca-Cola Classic CAN 0,25")?.category, "drink");
    assert.equal(by.get("Coca-Cola Classic CAN 0,25")?.price, 4999.16);
  });
});

describe("Алиасы вендинга (реальные листы остатков)", () => {
  const names = new Set(VENDING_PRICELIST.map((p) => p.name));

  it("каждый алиас указывает на существующий товар прайса", () => {
    const orphan = VENDING_ALIASES.filter((a) => !names.has(a.product)).map((a) => `${a.alias} → ${a.product}`);
    assert.deepEqual(orphan, [], `алиасы без товара в прайсе: ${orphan.join("; ")}`);
  });

  it("нет двух алиасов с одним нормализованным ключом на разные товары", () => {
    const seen = new Map<string, string>();
    const clash: string[] = [];
    for (const a of VENDING_ALIASES) {
      const key = normalizeProductName(a.alias);
      const prev = seen.get(key);
      if (prev && prev !== a.product) clash.push(`${a.alias}: ${prev} vs ${a.product}`);
      seen.set(key, a.product);
    }
    assert.deepEqual(clash, [], `конфликт алиасов: ${clash.join("; ")}`);
  });
});

describe("seedVendingAliases: перенос остатка склада на канон (регресс)", () => {
  /** Стаб: select().from(table) различает три таблицы по ссылке. */
  function seedDb(products: unknown[], existingAliases: unknown[], stockRows: unknown[]) {
    const aliasInserts: unknown[] = [];
    const stockUpdates: unknown[] = [];
    const db = {
      select: () => ({
        from: async (t: unknown) =>
          t === vendingProduct ? products : t === vendingAlias ? existingAliases : t === vendingStock ? stockRows : [],
      }),
      insert: () => ({
        values: (v: unknown[]) => {
          aliasInserts.push(...v);
          return Promise.resolve(undefined);
        },
      }),
      update: () => ({
        set: (v: unknown) => ({
          where: () => {
            stockUpdates.push(v);
            return Promise.resolve(undefined);
          },
        }),
      }),
      // Вставка алиасов и перенос склада идут одной транзакцией (M4): стаб
      // отдаёт сам себя транзакцией — записи по-прежнему копятся в те же списки.
      transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb(db),
    } as never;
    return { db, aliasInserts, stockUpdates };
  }

  it("строка склада под сырым именем переносится на канон, когда добавляется алиас", async () => {
    // До алиаса владелец вводил остаток сырым именем «Montella» — строка легла
    // под ним. Без переноса следующий пересчёт искал бы «до» под каноном, не
    // нашёл бы и молча потерял недостачу/излишек (найдено адверсариал-ревью).
    const products = [{ id: "p1", name: "Montella Вода минеральная 330ml" }];
    const stockRows = [{ productName: "Montella", updatedAt: new Date("2026-08-01T00:00:00Z") }];
    const { db, stockUpdates } = seedDb(products, [], stockRows);
    const res = await seedVendingAliases(db);
    assert.equal(res.stockRenamed, 1);
    assert.ok(stockUpdates.some((v) => (v as { productName: string }).productName === "Montella Вода минеральная 330ml"));
  });

  it("канон уже существует — старую сырую строку не трогаем (неясно, какая настоящая)", async () => {
    const products = [{ id: "p1", name: "Montella Вода минеральная 330ml" }];
    const stockRows = [
      { productName: "Montella", updatedAt: new Date("2026-08-01T00:00:00Z") },
      { productName: "Montella Вода минеральная 330ml", updatedAt: new Date("2026-08-02T00:00:00Z") },
    ];
    const { db, stockUpdates } = seedDb(products, [], stockRows);
    const res = await seedVendingAliases(db);
    assert.equal(res.stockRenamed, 0);
    assert.equal(stockUpdates.length, 0);
  });

  it("нет строки склада под сырым именем — переносить нечего", async () => {
    const products = [{ id: "p1", name: "Montella Вода минеральная 330ml" }];
    const { db, stockUpdates } = seedDb(products, [], []);
    const res = await seedVendingAliases(db);
    assert.equal(res.stockRenamed, 0);
    assert.equal(stockUpdates.length, 0);
  });

  it("два алиаса на один канон переносят строку только один раз (не задваивают счётчик)", async () => {
    // «Montella» и «Montella pet 0.33» — оба алиаса ведут на один товар;
    // сырая строка склада только одна («Montella») и переносится единожды.
    const products = [{ id: "p1", name: "Montella Вода минеральная 330ml" }];
    const stockRows = [{ productName: "Montella", updatedAt: new Date("2026-08-01T00:00:00Z") }];
    const { db, stockUpdates } = seedDb(products, [], stockRows);
    const res = await seedVendingAliases(db);
    assert.equal(res.stockRenamed, 1);
    assert.equal(stockUpdates.length, 1);
  });
});

describe("Сид вендинга: правила закупа владельца (П5a)", () => {
  const names = new Set(VENDING_PRICELIST.map((p) => p.name));
  it("каждое правило ссылается на товар прайса", () => {
    for (const r of VENDING_PURCHASE_RULES) assert.ok(names.has(r.product), r.product);
  });
  it("11 исключений, 2 фикс-количества, блоки 6/5 у энергетиков и чипсов (procurement-rules.json 24.08.2026)", () => {
    assert.equal(VENDING_PURCHASE_RULES.filter((r) => r.excludedFromPurchase).length, 11);
    assert.deepEqual(
      VENDING_PURCHASE_RULES.filter((r) => r.fixedPurchaseQty).map((r) => [r.product, r.fixedPurchaseQty]),
      [["СуперКонтик Шоколадный вкус 100gr", 50], ["Snickers 50gr", 48]],
    );
    const pack = (n: string) => VENDING_PURCHASE_RULES.find((r) => r.product === n)?.packSize;
    assert.equal(pack("Red Bull CAN 0,25"), 6);
    assert.equal(pack("Lays Рифлёные Сметана и лук 70gr"), 5);
  });
  it("каждый алиас ссылается на товар прайса", () => {
    for (const a of VENDING_ALIASES) assert.ok(names.has(a.product), a.alias);
  });

  it("имена со склада прода резолвятся в товар прайса (сверка 24.08.2026)", () => {
    // Без этих алиасов строки склада осиротели и план покупал заново то, что
    // уже лежало на полке (на сверке — 295 190 сум лишнего закупа).
    const byKey = new Map(VENDING_ALIASES.map((a) => [normalizeProductName(a.alias), a.product]));
    const ожидаем: [string, string][] = [
      ["MOXITO FRESH LIMON CAN 0.5", "Moxito Fresh CAN 0,5"],
      ["Coca-Cola Zero CAN 0.25", "Coca-Cola ZeroS CAN 0.25"],
      ["O'zbegim Tea 0.45", "Ozbegim Tea Mango Moychechak 450ml"],
      ["Red Bull", "Red Bull CAN 0,25"],
    ];
    for (const [склад, канон] of ожидаем) {
      assert.equal(byKey.get(normalizeProductName(склад)), канон, склад);
      assert.ok(names.has(канон), канон);
    }
  });

  it("расхождения цен «на разбор» ссылаются на товар прайса и реально расходятся", () => {
    for (const d of DONOR_PRICE_DIFFS) {
      assert.ok(names.has(d.product), d.product);
      const прайс = VENDING_PRICELIST.find((p) => p.name === d.product)!;
      assert.equal(прайс.price, d.seed, `${d.product}: цена прайса разошлась с таблицей «на разбор»`);
      assert.notEqual(d.seed, d.donor, d.product);
    }
  });
});

describe("seedVendingRules: правки владельца сильнее сида (M5/A9)", () => {
  type Row = {
    id: string;
    name: string;
    category: "drink" | "snack" | "other";
    packSize: number;
    excludedFromPurchase: boolean;
    fixedPurchaseQty: number | null;
  };
  function rulesDb(rows: Row[]) {
    const updated: { id: string; set: Record<string, unknown> }[] = [];
    const db = {
      select: () => ({ from: async () => rows }),
      update: () => ({
        set: (v: Record<string, unknown>) => ({
          where: () => {
            updated.push({ id: "?", set: v });
            return Promise.resolve(undefined);
          },
        }),
      }),
    } as never;
    return { db, updated };
  }
  const нетронутый = (name: string, category: Row["category"]): Row => ({
    id: name,
    name,
    category,
    packSize: category === "drink" ? 12 : 10,
    excludedFromPurchase: false,
    fixedPurchaseQty: null,
  });

  it("нетронутая строка получает правило", async () => {
    const { db, updated } = rulesDb([нетронутый("Red Bull CAN 0,25", "drink")]);
    const res = await seedVendingRules(db);
    assert.equal(res.applied, 1);
    assert.deepEqual(res.skipped, []);
    assert.equal(updated[0]!.set.packSize, 6);
  });

  it("строку с правкой владельца пропускает и называет её", async () => {
    // Владелец поставил блок 24 из бота — повторный прогон сида не имеет права
    // вернуть 6 молча.
    const тронут: Row = { ...нетронутый("Red Bull CAN 0,25", "drink"), packSize: 24 };
    const { db, updated } = rulesDb([тронут]);
    const res = await seedVendingRules(db);
    assert.equal(res.applied, 0);
    assert.deepEqual(res.skipped, ["Red Bull CAN 0,25"]);
    assert.equal(updated.length, 0);
  });

  it("исключение и фикс владельца тоже считаются правкой", async () => {
    const сИсключением: Row = { ...нетронутый("Twix 50gr", "snack"), excludedFromPurchase: true };
    const сФиксом: Row = { ...нетронутый("Snickers 50gr", "snack"), fixedPurchaseQty: 24 };
    const { db, updated } = rulesDb([сИсключением, сФиксом]);
    const res = await seedVendingRules(db);
    assert.equal(res.applied, 0);
    assert.deepEqual(res.skipped.sort(), ["Snickers 50gr", "Twix 50gr"]);
    assert.equal(updated.length, 0);
  });

  it("товара нет в прайсе — в unknown, а не молча мимо", async () => {
    const { db } = rulesDb([]);
    const res = await seedVendingRules(db);
    assert.equal(res.applied, 0);
    assert.equal(res.unknown.length, VENDING_PURCHASE_RULES.length);
  });
});
