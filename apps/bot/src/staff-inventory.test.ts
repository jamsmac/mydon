import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Conversations } from "./conversation";
import type { EntityRow, PersonRow } from "./core-client";
import {
  fmtQty,
  handleInventoryCallback,
  handleInventoryCount,
  isInventoryTrigger,
  parseInventoryCallback,
  parseQty,
  startInventory,
} from "./staff-inventory";

const ME: PersonRow = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Рустам",
  role: "оператор",
  tgUsername: "rustam",
  tgChatId: "555",
  active: "yes",
};

const WH = "44444444-4444-4444-8444-444444444444";
const WH2 = "55555555-5555-4555-8555-555555555555";
const ING = "66666666-6666-4666-8666-666666666666";

function entity(id: string, name: string, type: string): EntityRow {
  return { id, name, type, externalRef: null, attrs: {} };
}

/** Заглушка Core: списки + баланс + запись пересчёта с записью вызовов. */
function stubCore(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const core = {
    warehouses: async () => [entity(WH, "Основной", "warehouse")],
    ingredients: async () => [entity(ING, "Зёрна", "ingredient")],
    stockBalance: async (warehouseId: string, ingredientId: string) => ({
      warehouseId,
      warehouseName: "Основной",
      ingredientId,
      ingredientName: "Зёрна",
      baseUnit: "кг",
      qty: 10,
      unconvertible: 0,
    }),
    stocktake: async (input: Record<string, unknown>) => {
      calls.push(`stocktake:${input.warehouseId}:${input.ingredientId}:${input.actual}:${input.countedBy}`);
      const actual = Number(input.actual);
      const delta = Math.round((actual - 10) * 1000) / 1000;
      return {
        changed: delta !== 0,
        before: 10,
        actual,
        delta,
        unit: "кг",
        ingredientName: "Зёрна",
        warehouseName: "Основной",
        movementId: delta !== 0 ? "mv-1" : null,
      };
    },
    ...over,
  } as never;
  return { core, calls };
}

describe("Разбор ввода инвентаризации", () => {
  it("число: целое, точка и запятая", () => {
    assert.equal(parseQty("8"), 8);
    assert.equal(parseQty("8.5"), 8.5);
    assert.equal(parseQty("8,5"), 8.5);
    assert.equal(parseQty(" 12 "), 12);
    assert.equal(parseQty("-3"), null, "отрицательное не число");
    assert.equal(parseQty("много"), null);
    assert.equal(parseQty(""), null);
  });

  it("кнопки: строгий формат", () => {
    assert.deepEqual(parseInventoryCallback(`i:wh:${WH}`), { kind: "warehouse", id: WH });
    assert.deepEqual(parseInventoryCallback(`i:ing:${ING}`), { kind: "ingredient", id: ING });
    assert.deepEqual(parseInventoryCallback("i:cancel"), { kind: "cancel" });
    assert.equal(parseInventoryCallback("i:wh:не-uuid"), null);
    assert.equal(parseInventoryCallback("r:type:ingredient"), null);
  });

  it("триггер ловит понятные слова", () => {
    assert.ok(isInventoryTrigger("инвентаризация"));
    assert.ok(isInventoryTrigger("пересчёт склада"));
    assert.ok(isInventoryTrigger("переучёт"));
    assert.ok(!isInventoryTrigger("задачи"));
  });

  it("fmtQty без хвостовых нулей", () => {
    assert.equal(fmtQty(8), "8");
    assert.equal(fmtQty(8.5), "8.5");
    assert.equal(fmtQty(1.4999999), "1.5");
  });
});

describe("Поток инвентаризации", () => {
  it("один склад — сразу к ингредиенту, минуя выбор склада", async () => {
    const conversations = new Conversations();
    const { core } = stubCore();
    const start = await startInventory(1, { core, conversations });
    assert.match(start.text, /какой ингредиент/i);
    assert.equal(conversations.get(1)?.step, "ingredient");
    assert.equal(conversations.get(1)?.data.warehouseId, WH);
  });

  it("несколько складов — сперва спрашиваем склад", async () => {
    const conversations = new Conversations();
    const { core } = stubCore({
      warehouses: async () => [entity(WH, "Основной", "warehouse"), entity(WH2, "Резерв", "warehouse")],
    });
    const deps = { core, conversations };
    const start = await startInventory(2, deps);
    assert.match(start.text, /какой склад/i);
    assert.equal(conversations.get(2)?.step, "warehouse");
    const afterWh = await handleInventoryCallback(2, { kind: "warehouse", id: WH2 }, ME, deps);
    assert.equal(conversations.get(2)?.data.warehouseId, WH2);
    assert.equal(conversations.get(2)?.step, "ingredient");
    assert.match(afterWh.message?.text ?? "", /какой ингредиент/i);
  });

  it("выбор ингредиента показывает остаток и ждёт факт", async () => {
    const conversations = new Conversations();
    const { core } = stubCore();
    const deps = { core, conversations };
    await startInventory(3, deps);
    const afterIng = await handleInventoryCallback(3, { kind: "ingredient", id: ING }, ME, deps);
    assert.match(afterIng.message?.text ?? "", /сейчас по учёту: 10 кг/i);
    assert.equal(conversations.get(3)?.step, "count");
    assert.equal(conversations.get(3)?.data.baseUnit, "кг");
  });

  it("факт меньше учёта → недостача, корректировка записана", async () => {
    const conversations = new Conversations();
    const { core, calls } = stubCore();
    const deps = { core, conversations };
    await startInventory(4, deps);
    await handleInventoryCallback(4, { kind: "ingredient", id: ING }, ME, deps);
    const res = await handleInventoryCount(4, "8", ME, deps);
    assert.match(res.text, /было 10 → стало 8 кг \(-2, недостача\)/i);
    assert.match(calls[0], new RegExp(`stocktake:${WH}:${ING}:8:person:`));
    assert.equal(conversations.get(4), null, "визард завершён");
  });

  it("факт совпал с учётом — корректировка не нужна", async () => {
    const conversations = new Conversations();
    const { core } = stubCore();
    const deps = { core, conversations };
    await startInventory(5, deps);
    await handleInventoryCallback(5, { kind: "ingredient", id: ING }, ME, deps);
    const res = await handleInventoryCount(5, "10", ME, deps);
    assert.match(res.text, /совпал с учётом/i);
  });

  it("ингредиент без единицы — пересчёт невозможен, визард закрыт", async () => {
    const conversations = new Conversations();
    const { core } = stubCore({
      stockBalance: async () => ({
        warehouseId: WH,
        warehouseName: "Основной",
        ingredientId: ING,
        ingredientName: "Зёрна",
        baseUnit: null,
        qty: null,
        unconvertible: 0,
      }),
    });
    const deps = { core, conversations };
    await startInventory(6, deps);
    const res = await handleInventoryCallback(6, { kind: "ingredient", id: ING }, ME, deps);
    assert.match(res.message?.text ?? "", /не задана единица/i);
    assert.equal(conversations.get(6), null);
  });

  it("нечисловой факт не пишет корректировку, просит число", async () => {
    const conversations = new Conversations();
    const { core, calls } = stubCore();
    const deps = { core, conversations };
    await startInventory(7, deps);
    await handleInventoryCallback(7, { kind: "ingredient", id: ING }, ME, deps);
    const res = await handleInventoryCount(7, "примерно много", ME, deps);
    assert.match(res.text, /не понял число/i);
    assert.deepEqual(calls, [], "ничего не записали");
    assert.equal(conversations.get(7)?.step, "count", "визард ждёт число дальше");
  });

  it("отмена бросает пересчёт", async () => {
    const conversations = new Conversations();
    const { core } = stubCore();
    const deps = { core, conversations };
    await startInventory(8, deps);
    const res = await handleInventoryCallback(8, { kind: "cancel" }, ME, deps);
    assert.match(res.message?.text ?? "", /отменил/i);
    assert.equal(conversations.get(8), null);
  });
});
