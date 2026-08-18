import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Conversations } from "./conversation";
import type { EntityRow, PersonRow } from "./core-client";
import {
  handleIntakeCallback,
  handleIntakeCount,
  isIntakeTrigger,
  parseIntakeCallback,
  startIntake,
} from "./staff-intake";

const ME: PersonRow = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Рустам",
  role: "оператор",
  tgUsername: "rustam",
  tgChatId: "555",
  active: "yes",
};

const WH = "44444444-4444-4444-8444-444444444444";
const ING = "66666666-6666-4666-8666-666666666666";

function entity(id: string, name: string, type: string): EntityRow {
  return { id, name, type, externalRef: null, attrs: {} };
}

/** Заглушка Core: списки + баланс (растёт после прихода) + запись прихода. */
function stubCore(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  let bal = 10;
  const core = {
    warehouses: async () => [entity(WH, "Основной", "warehouse")],
    ingredients: async () => [entity(ING, "Зёрна", "ingredient")],
    stockBalance: async (warehouseId: string, ingredientId: string) => ({
      warehouseId,
      warehouseName: "Основной",
      ingredientId,
      ingredientName: "Зёрна",
      baseUnit: "кг",
      qty: bal,
      unconvertible: 0,
    }),
    addIntake: async (input: Record<string, unknown>) => {
      calls.push(`intake:${input.warehouseId}:${input.ingredientId}:${input.qty}:${input.unit}:${input.createdBy}`);
      bal += Number(input.qty);
      return { id: "mv-1" };
    },
    ...over,
  } as never;
  return { core, calls };
}

describe("Приход: разбор входа", () => {
  it("кнопки строгого формата", () => {
    assert.deepEqual(parseIntakeCallback(`n:wh:${WH}`), { kind: "warehouse", id: WH });
    assert.deepEqual(parseIntakeCallback(`n:ing:${ING}`), { kind: "ingredient", id: ING });
    assert.deepEqual(parseIntakeCallback("n:cancel"), { kind: "cancel" });
    assert.equal(parseIntakeCallback("n:wh:не-uuid"), null);
    assert.equal(parseIntakeCallback(`i:wh:${WH}`), null, "чужое пространство инвентаризации");
  });

  it("триггер ловит слова прихода, не путая с инвентаризацией", () => {
    assert.ok(isIntakeTrigger("приход"));
    assert.ok(isIntakeTrigger("пришло сырьё"));
    assert.ok(isIntakeTrigger("завоз"));
    assert.ok(!isIntakeTrigger("инвентаризация"));
    assert.ok(!isIntakeTrigger("задачи"));
  });
});

describe("Поток прихода", () => {
  it("один склад → сразу к ингредиенту", async () => {
    const conversations = new Conversations();
    const { core } = stubCore();
    const start = await startIntake(1, { core, conversations });
    assert.match(start.text, /что пришло/i);
    assert.equal(conversations.get(1)?.step, "ingredient");
    assert.equal(conversations.get(1)?.data.warehouseId, WH);
  });

  it("выбор ингредиента показывает остаток и ждёт количество", async () => {
    const conversations = new Conversations();
    const { core } = stubCore();
    const deps = { core, conversations };
    await startIntake(2, deps);
    const afterIng = await handleIntakeCallback(2, { kind: "ingredient", id: ING }, ME, deps);
    assert.match(afterIng.message?.text ?? "", /сейчас по учёту: 10 кг/i);
    assert.match(afterIng.message?.text ?? "", /сколько пришло/i);
    assert.equal(conversations.get(2)?.step, "count");
  });

  it("ввод количества пишет приход и показывает новый остаток", async () => {
    const conversations = new Conversations();
    const { core, calls } = stubCore();
    const deps = { core, conversations };
    await startIntake(3, deps);
    await handleIntakeCallback(3, { kind: "ingredient", id: ING }, ME, deps);
    const res = await handleIntakeCount(3, "5.5", ME, deps);
    assert.match(res.text, /приход записан: \+5\.5 кг/i);
    assert.match(res.text, /стало 15\.5 кг/i);
    assert.match(calls[0], new RegExp(`intake:${WH}:${ING}:5.5:кг:person:`));
    assert.equal(conversations.get(3), null, "визард завершён");
  });

  it("ноль и мусор не пишут приход", async () => {
    const conversations = new Conversations();
    const { core, calls } = stubCore();
    const deps = { core, conversations };
    await startIntake(4, deps);
    await handleIntakeCallback(4, { kind: "ingredient", id: ING }, ME, deps);
    const zero = await handleIntakeCount(4, "0", ME, deps);
    assert.match(zero.text, /не понял число/i);
    const junk = await handleIntakeCount(4, "чуть-чуть", ME, deps);
    assert.match(junk.text, /не понял число/i);
    assert.deepEqual(calls, []);
    assert.equal(conversations.get(4)?.step, "count", "ждём число дальше");
  });

  it("ингредиент без единицы — приход невозможен, визард закрыт", async () => {
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
    await startIntake(5, deps);
    const res = await handleIntakeCallback(5, { kind: "ingredient", id: ING }, ME, deps);
    assert.match(res.message?.text ?? "", /не задана единица/i);
    assert.equal(conversations.get(5), null);
  });

  it("отмена бросает приход", async () => {
    const conversations = new Conversations();
    const { core } = stubCore();
    const deps = { core, conversations };
    await startIntake(6, deps);
    const res = await handleIntakeCallback(6, { kind: "cancel" }, ME, deps);
    assert.match(res.message?.text ?? "", /отменил/i);
    assert.equal(conversations.get(6), null);
  });
});

describe("Сбой декоративного запроса остатка не превращает успех в молчание", () => {
  it("addIntake прошёл, stockBalance упал — ответ честный: записано, второй раз не вводить", async () => {
    // Ответ после успешной записи зависел от ВТОРОГО сетевого вызова: его сбой
    // глотался, сотрудник не получал ничего и вводил число снова — двойной приход.
    let balCalls = 0;
    const { core, calls } = stubCore({
      stockBalance: async (warehouseId: string, ingredientId: string) => {
        balCalls += 1;
        if (balCalls > 1) throw new Error("Core недоступен");
        return {
          warehouseId,
          warehouseName: "Основной",
          ingredientId,
          ingredientName: "Зёрна",
          baseUnit: "кг",
          qty: 10,
          unconvertible: 0,
        };
      },
    });
    const conversations = new Conversations();
    const deps = { core, conversations };
    await startIntake(9, deps);
    await handleIntakeCallback(9, { kind: "ingredient", id: ING }, ME, deps);
    const reply = await handleIntakeCount(9, "5", ME, deps);
    assert.match(reply.text, /Приход записан/);
    assert.match(reply.text, /второй раз не вводи/);
    assert.equal(calls.filter((c) => c.startsWith("intake:")).length, 1);
    assert.equal(conversations.get(9), null, "мастер завершён — повторное число не станет вторым приходом");
  });
});
