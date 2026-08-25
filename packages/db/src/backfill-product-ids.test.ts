import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { бэкфиллWhere, resolveProductIds } from "./backfill-product-ids";
import { machineSlot, vendingStock } from "./schema";

/**
 * Текст SQL-выражения drizzle (та же техника, что в
 * `apps/core/src/vending/vending.service.test.ts`), но рекурсивная: `and(...)`
 * кладёт вложенные условия отдельным `SQL`-чанком, а не разворачивает их в
 * общий список — плоская версия текст «is null» бы не нашла.
 */
function текстSQL(x: unknown): string {
  if (x && typeof x === "object") {
    const chunks = (x as { queryChunks?: unknown[] }).queryChunks;
    if (Array.isArray(chunks)) return chunks.map(текстSQL).join("");
    const v = (x as { value?: unknown }).value;
    if (Array.isArray(v)) return v.join("");
    const name = (x as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return "";
}

const ТОВАРЫ = [
  { id: "p-cola", name: "Coca-Cola Classic 0,5" },
  { id: "p-mont", name: "Montella Вода минеральная 330ml" },
];
const АЛИАСЫ = [
  { productId: "p-mont", alias: "18+" },
  { productId: "p-mont", alias: "Montella" },
];

describe("Бэкфилл product_id: резолв имени тем же правилом, что у Core", () => {
  it("точное имя прайса резолвится в карточку", () => {
    const m = resolveProductIds(["Coca-Cola Classic 0,5"], ТОВАРЫ, АЛИАСЫ);
    assert.equal(m.get("Coca-Cola Classic 0,5"), "p-cola");
  });

  it("другое написание того же имени — тот же товар (нормализация, а не точное равенство)", () => {
    // Снимок присылает «COCA-COLA  CLASSIC 0,5», склад заведён «Coca-Cola
    // Classic 0,5». Посимвольное сравнение оставило бы строку с NULL.
    const m = resolveProductIds(["  COCA-COLA  CLASSIC 0,5 "], ТОВАРЫ, АЛИАСЫ);
    assert.equal(m.get("  COCA-COLA  CLASSIC 0,5 "), "p-cola");
  });

  it("алиас ведёт к карточке своего товара", () => {
    const m = resolveProductIds(["18+", "montella"], ТОВАРЫ, АЛИАСЫ);
    assert.equal(m.get("18+"), "p-mont");
    assert.equal(m.get("montella"), "p-mont");
  });

  it("неизвестное имя карточки не выдумывает — в карте его нет", () => {
    const m = resolveProductIds(["Загадка"], ТОВАРЫ, АЛИАСЫ);
    assert.equal(m.has("Загадка"), false, "лучше NULL и строка в отчёте, чем чужая привязка");
  });

  it("пустое имя пропускается: слот без товара — это не осиротевшая привязка", () => {
    const m = resolveProductIds(["", "   ", null], ТОВАРЫ, АЛИАСЫ);
    assert.equal(m.size, 0);
  });

  it("алиас на удалённый товар не резолвится в мусорный id", () => {
    const m = resolveProductIds(["18+"], [{ id: "p-cola", name: "Coca-Cola Classic 0,5" }], АЛИАСЫ);
    assert.equal(m.has("18+"), false);
  });
});

describe("Бэкфилл product_id: UPDATE не трогает уже привязанные строки (N2)", () => {
  it("предикат содержит `product_id IS NULL` — строку с непустой ссылкой на то же имя UPDATE не заденет", () => {
    const где = бэкфиллWhere(vendingStock.productName, vendingStock.productId, "Montella Вода минеральная 330ml");
    const выражение = текстSQL(где);
    assert.match(выражение, /product_id.*is null/, "без этого условия UPDATE обновил бы ВСЕ строки с этим именем");
    assert.match(выражение, /product_name/, "имя из UPDATE не пропало — фильтр по-прежнему точечный");
  });

  it("тот же предикат для machine_slot — таблицы устроены одинаково", () => {
    const где = бэкфиллWhere(machineSlot.productName, machineSlot.productId, "Snickers");
    const выражение = текстSQL(где);
    assert.match(выражение, /product_id.*is null/);
  });
});
