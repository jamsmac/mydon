import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Conversations } from "./conversation";
import type { PersonRow } from "./core-client";
import {
  handleCoffeeConsumableCallback,
  handleCoffeeConsumableCounts,
  isCoffeeConsumableTrigger,
  parseCoffeeConsumableCallback,
  parseConsumableCounts,
  recordContainerReturns,
  startCoffeeConsumable,
  tryParseContainerReturns,
} from "./coffee-returns";

const ME: PersonRow = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Рустам",
  role: "техник",
  tgUsername: "rustam",
  tgChatId: "555",
  active: "yes",
};

const LOC = "44444444-4444-4444-8444-444444444444";

function stubCore(over: Record<string, unknown> = {}) {
  const calls: { kind: string; input: Record<string, unknown> }[] = [];
  const core = {
    coffeeLocations: async () => [{ id: LOC, name: "American Hospital", isActive: true }],
    recordContainerReturn: async (input: Record<string, unknown>) => {
      calls.push({ kind: "return", input });
      return { id: `ret-${calls.length}` };
    },
    recordCoffeeConsumable: async (input: Record<string, unknown>) => {
      calls.push({ kind: "consumable", input });
      return { id: "cons-1" };
    },
    ...over,
  } as never;
  return { core, calls };
}

describe("Возвраты наборов в боте — привычный формат группы", () => {
  it("сообщение «позиция. набор. вес» распознаётся без триггер-слов", () => {
    const parsed = tryParseContainerReturns("Кпп остатки\n1. 026. 1119\n2. 019. 1944");
    assert.ok(parsed);
    assert.equal(parsed.returns.length, 2);
    assert.equal(parsed.locationNote, "Кпп остатки");
  });

  it("обычный текст — не возвраты (null, сообщение идёт дальше по цепочке)", () => {
    assert.equal(tryParseContainerReturns("задачи"), null);
    assert.equal(tryParseContainerReturns("помыл бункер"), null);
  });

  it("каждая строка уходит в Core с датой «сегодня», точкой и автором", async () => {
    const { core, calls } = stubCore();
    const parsed = tryParseContainerReturns("Кпп остатки\n1. 026. 1119\n7. 007. 1116");
    assert.ok(parsed);
    const reply = await recordContainerReturns(parsed, ME, { core, conversations: new Conversations() });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].input.position, 1);
    assert.equal(calls[0].input.containerNumber, 26);
    assert.equal(calls[0].input.weight, 1119);
    assert.equal(calls[0].input.locationNote, "Кпп остатки");
    assert.equal(calls[0].input.createdBy, `person:${ME.id}`);
    assert.match(String(calls[0].input.returnedDate), /^\d{4}-\d{2}-\d{2}$/);
    assert.match(reply.text, /2 наборов/);
    assert.match(reply.text, /Кпп остатки/);
  });

  it("кривые строки не теряются молча — в ответе предупреждение", async () => {
    const { core, calls } = stubCore();
    const parsed = tryParseContainerReturns("1. 026. 1119\n9. 030. 700");
    assert.ok(parsed);
    const reply = await recordContainerReturns(parsed, ME, { core, conversations: new Conversations() });
    assert.equal(calls.length, 1);
    assert.match(reply.text, /Не разобрал 1 строк/);
  });
});

describe("Расходники (вода/стаканчики/крышки) в боте", () => {
  it("триггер: «вода», «расходники»; не срабатывает на прочее", () => {
    assert.equal(isCoffeeConsumableTrigger("вода"), true);
    assert.equal(isCoffeeConsumableTrigger("расходники"), true);
    assert.equal(isCoffeeConsumableTrigger("бункер"), false);
  });

  it("parseConsumableCounts: три числа; мусор — null", () => {
    assert.deepEqual(parseConsumableCounts("2 100 100"), { water: 2, cups: 100, lids: 100 });
    assert.equal(parseConsumableCounts("2 100"), null);
    assert.equal(parseConsumableCounts("вода два"), null);
  });

  it("полный путь: точка кнопкой → три числа → upsert за сегодня", async () => {
    const { core, calls } = stubCore();
    const conversations = new Conversations();
    const deps = { core, conversations };

    const start = await startCoffeeConsumable(555, deps);
    assert.match(start.text, /какой точки/i);
    assert.ok(start.keyboard);

    const cb = parseCoffeeConsumableCallback(`cc:loc:${LOC}`);
    assert.ok(cb && cb.kind === "location");
    await handleCoffeeConsumableCallback(555, cb, deps);

    const reply = await handleCoffeeConsumableCounts(555, "2 100 3", ME, deps);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, "consumable");
    assert.equal(calls[0].input.locationId, LOC);
    assert.deepEqual(
      [calls[0].input.water, calls[0].input.cups, calls[0].input.lids],
      [2, 100, 3],
    );
    assert.equal(calls[0].input.createdBy, `person:${ME.id}`);
    assert.match(reply.text, /American Hospital/);
    assert.equal(conversations.get(555), null, "визард закрыт после записи");
  });

  it("непонятные числа — подсказка, визард жив", async () => {
    const { core, calls } = stubCore();
    const conversations = new Conversations();
    conversations.start(555, "coffee-consumable", "counts", { locationId: LOC, locationName: "AH" });
    const reply = await handleCoffeeConsumableCounts(555, "много всего", ME, { core, conversations });
    assert.equal(calls.length, 0);
    assert.match(reply.text, /Три числа|три числа/);
    assert.ok(conversations.get(555), "визард не сброшен — можно повторить ввод");
  });
});
