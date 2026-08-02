import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeProductName } from "@mydon/shared";
import { VENDING_ALIASES, VENDING_PRICELIST, packOf } from "./seed-vending";

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
    assert.equal(by.get("RedBull Classic 250 ml")?.price, 16000);
    assert.equal(by.get("СуперКонтик Шоколадный вкус 100gr")?.price, 5000);
    assert.equal(by.get("CocaCola Classic CAN 250ml")?.category, "drink");
    assert.equal(by.get("Snickers 50gr")?.category, "snack");
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
