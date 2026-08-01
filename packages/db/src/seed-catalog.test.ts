import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CATALOG, CATALOG_SOURCE, catalogEntities } from "./seed-catalog";

describe("Стартовый каталог Snack & Drinks", () => {
  const rows = catalogEntities("org-1");

  it("сорок позиций — как в доноре (db/03_seed.sql)", () => {
    assert.equal(rows.length, 40);
  });

  it("имена уникальны — иначе идемпотентность по имени пропустит дубль", () => {
    const names = new Set(rows.map((r) => r.name));
    assert.equal(names.size, rows.length);
  });

  it("у каждой позиции положительная цена продажи", () => {
    for (const r of rows) {
      const p = r.attrs["цена продажи"];
      assert.ok(typeof p === "number" && p > 0, `цена не задана: ${r.name}`);
    }
  });

  it("все карточки — товар на перепродажу, а не рецепт", () => {
    for (const r of rows) {
      assert.equal(r.type, "product");
      assert.equal(r.attrs["вид"], "перепродажа");
    }
  });

  it("цена ПОКУПКИ пуста — её впишет владелец (без неё не посчитать наценку)", () => {
    for (const r of rows) {
      assert.equal(r.attrs["цена покупки"], undefined);
    }
  });

  it("заведены от источника — придут в очередь утверждения, а не как факт", () => {
    for (const r of rows) {
      assert.equal(r.createdFrom, CATALOG_SOURCE);
      assert.equal(r.attrs["источник"], CATALOG_SOURCE);
    }
  });

  it("группа только напитки или снеки; фасовка и категория заполнены", () => {
    for (const r of rows) {
      assert.ok(r.attrs["группа"] === "напитки" || r.attrs["группа"] === "снеки", r.name);
      assert.ok(String(r.attrs["фасовка"] ?? "").length > 0, `нет фасовки: ${r.name}`);
      assert.ok(String(r.attrs["категория товара"] ?? "").length > 0, `нет категории: ${r.name}`);
    }
  });

  it("orgId прокидывается во все строки", () => {
    for (const r of rows) assert.equal(r.orgId, "org-1");
  });

  it("категорий восемь — состав донора сохранён", () => {
    assert.equal(CATALOG.length, 8);
  });
});
