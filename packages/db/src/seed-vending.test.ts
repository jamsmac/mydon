import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeProductName } from "@mydon/shared";
import { vendingAlias, vendingProduct, vendingStock } from "./schema";
import { VENDING_ALIASES, VENDING_PRICELIST, packOf, seedVendingAliases } from "./seed-vending";

describe("Прайс вендинга (Приложение А)", () => {
  it("имена уникальны, цены положительны", () => {
    const names = VENDING_PRICELIST.map((p) => p.name);
    assert.equal(new Set(names).size, names.length, "дублей имён быть не должно");
    assert.ok(VENDING_PRICELIST.every((p) => p.price > 0), "цена должна быть положительной");
  });

  it("кратность по правилу 02.08.2026: напитки 12, снеки 10", () => {
    assert.equal(packOf("drink"), 12);
    assert.equal(packOf("snack"), 10);
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
