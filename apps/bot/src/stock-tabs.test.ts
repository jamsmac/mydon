import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseStockTab, stockTabItems, stockTabRow } from "./stock-tabs";
import { parseIntakeCallback } from "./staff-intake";
import { parseInventoryCallback } from "./staff-inventory";

describe("Вкладки «Сырьё / Товары» складских мастеров (У6)", () => {
  it("товары — только на перепродажу; рецептурные в приход не попадают", async () => {
    const core = {
      ingredients: async () => [{ id: "i1", type: "ingredient", name: "Кофе", externalRef: null, attrs: {} }],
      searchEntities: async () => [
        { id: "p1", type: "product", name: "Snickers", externalRef: null, attrs: { вид: "перепродажа" } },
        { id: "p2", type: "product", name: "Латте", externalRef: null, attrs: { вид: "рецепт" } },
        { id: "p3", type: "product", name: "Без вида", externalRef: null, attrs: {} },
      ],
    } as never;
    assert.deepEqual((await stockTabItems(core, "ing")).map((x) => x.name), ["Кофе"]);
    assert.deepEqual((await stockTabItems(core, "prod")).map((x) => x.name), ["Snickers"]);
  });

  it("ряд вкладок помечает текущую и живёт в пространстве мастера", () => {
    const row = stockTabRow("n", "prod");
    assert.deepEqual(row.map((b) => b.callback_data), ["n:tab:ing", "n:tab:prod"]);
    assert.ok(row[1].text.startsWith("• "));
    assert.ok(!row[0].text.startsWith("• "));
    assert.equal(parseStockTab("n", "n:tab:prod"), "prod");
    assert.equal(parseStockTab("n", "i:tab:prod"), null, "чужой префикс");
    assert.equal(parseStockTab("n", "n:tab:xxx"), null);
  });

  it("парсеры прихода и инвентаризации понимают вкладку", () => {
    assert.deepEqual(parseIntakeCallback("n:tab:prod"), { kind: "tab", tab: "prod" });
    assert.deepEqual(parseInventoryCallback("i:tab:ing"), { kind: "tab", tab: "ing" });
    assert.equal(parseIntakeCallback("i:tab:ing"), null);
  });
});
