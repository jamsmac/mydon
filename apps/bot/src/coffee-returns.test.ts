import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Conversations } from "./conversation";
import { handleStaffMessage } from "./staff";
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
    // Журнал пуст: гейт «пересланный старый список» по умолчанию не мешает.
    containerReturns: async () => [] as { position: number; containerNumber: number; weight: number; returnedDate: string }[],
    // Тары нет — все строки «информативные» (пустые бункеры не различаются).
    coffeeTare: async () => [] as { containerNumber: number; position: number; tareWeight: number | null }[],
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

  it("разбирает свои кнопки и не трогает чужие", () => {
    assert.deepEqual(parseCoffeeConsumableCallback("cc:save"), { kind: "save" });
    assert.deepEqual(parseCoffeeConsumableCallback("cc:fix:cups"), { kind: "fix", field: "cups" });
    assert.deepEqual(parseCoffeeConsumableCallback("cc:n:7"), { kind: "num", press: { kind: "digit", digit: "7" } });
    assert.equal(parseCoffeeConsumableCallback("cf:n:7"), null, "клавиатура заливки — не наша");
  });

  it("по одному числу кнопками: вода → стаканы → крышки → проверка → запись", async () => {
    const { core, calls } = stubCore();
    const conversations = new Conversations();
    const deps = { core, conversations };
    const press = (p: unknown) => handleCoffeeConsumableCallback(555, { kind: "num", press: p } as never, ME, deps);
    const digits = async (d: string) => {
      for (const c of d) await press({ kind: "digit", digit: c });
    };

    await startCoffeeConsumable(555, deps);
    const first = await handleCoffeeConsumableCallback(555, { kind: "location", id: LOC }, ME, deps);
    assert.match(first.message!.text, /Вода/i, "первым спрашиваем воду");

    await digits("2");
    const afterWater = await press({ kind: "done" });
    assert.match(afterWater.edit!.text, /Стакан/i, "дальше стаканчики");

    await digits("100");
    const afterCups = await press({ kind: "done" });
    assert.match(afterCups.edit!.text, /Крышк/i);

    await digits("3");
    const confirm = await press({ kind: "done" });
    assert.match(confirm.edit!.text, /проверь/i, "перед записью показываем всё вместе");
    assert.match(confirm.edit!.text, /Вода: 2/);
    assert.match(confirm.edit!.text, /Стаканчики: 100/);
    assert.match(confirm.edit!.text, /Крышки: 3/);
    assert.equal(calls.length, 0, "до подтверждения ничего не записано");

    const saved = await handleCoffeeConsumableCallback(555, { kind: "save" }, ME, deps);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, "consumable");
    assert.deepEqual([calls[0].input.water, calls[0].input.cups, calls[0].input.lids], [2, 100, 3]);
    assert.equal(calls[0].input.createdBy, `person:${ME.id}`);
    assert.match(saved.edit!.text, /✅ Расходники записаны/);
    assert.match(JSON.stringify(saved.edit!.keyboard), /cv:more/, "возвращаемся в меню точки");
  });

  it("«пропустить» = ноль: не привозил — тоже факт", async () => {
    const { core, calls } = stubCore();
    const conversations = new Conversations();
    const deps = { core, conversations };
    await startCoffeeConsumable(555, deps);
    await handleCoffeeConsumableCallback(555, { kind: "location", id: LOC }, ME, deps);
    for (let i = 0; i < 3; i++) {
      await handleCoffeeConsumableCallback(555, { kind: "num", press: { kind: "skip" } }, ME, deps);
    }
    await handleCoffeeConsumableCallback(555, { kind: "save" }, ME, deps);
    assert.deepEqual([calls[0].input.water, calls[0].input.cups, calls[0].input.lids], [0, 0, 0]);
  });

  it("правка одной строки не сбрасывает две другие", async () => {
    const { core, calls } = stubCore();
    const conversations = new Conversations();
    const deps = { core, conversations };
    await startCoffeeConsumable(555, deps);
    await handleCoffeeConsumableCallback(555, { kind: "location", id: LOC }, ME, deps);
    await handleCoffeeConsumableCounts(555, "2 100 3", ME, deps);

    const fix = await handleCoffeeConsumableCallback(555, { kind: "fix", field: "cups" }, ME, deps);
    assert.match(fix.edit!.text, /Стакан/i);
    for (const c of "150") {
      await handleCoffeeConsumableCallback(555, { kind: "num", press: { kind: "digit", digit: c } }, ME, deps);
    }
    const back = await handleCoffeeConsumableCallback(555, { kind: "num", press: { kind: "done" } }, ME, deps);
    assert.match(back.edit!.text, /Вода: 2/, "вода уцелела");
    assert.match(back.edit!.text, /Стаканчики: 150/, "стаканчики поправлены");
    assert.match(back.edit!.text, /Крышки: 3/, "крышки уцелели");

    await handleCoffeeConsumableCallback(555, { kind: "save" }, ME, deps);
    assert.deepEqual([calls[0].input.water, calls[0].input.cups, calls[0].input.lids], [2, 150, 3]);
  });

  it("три числа одной строкой по-прежнему работают — ведут на проверку", async () => {
    const { core, calls } = stubCore();
    const conversations = new Conversations();
    const deps = { core, conversations };
    await startCoffeeConsumable(555, deps);
    await handleCoffeeConsumableCallback(555, { kind: "location", id: LOC }, ME, deps);
    const reply = await handleCoffeeConsumableCounts(555, "2 100 3", ME, deps);
    assert.match(reply.text, /проверь/i);
    assert.equal(calls.length, 0, "старый способ тоже требует подтверждения");
  });

  it("непонятное число — подсказка, визард жив", async () => {
    const { core, calls } = stubCore();
    const conversations = new Conversations();
    conversations.start(555, "coffee-consumable", "water", { locationId: LOC, locationName: "AH" });
    const reply = await handleCoffeeConsumableCounts(555, "много всего", ME, { core, conversations });
    assert.equal(calls.length, 0);
    assert.match(reply.text, /Не понял число/);
    assert.ok(conversations.get(555), "визард не сброшен — можно повторить ввод");
  });
});

describe("Расходники ЧЕРЕЗ ДИСПЕТЧЕР (регрессия, которую тесты не ловили)", () => {
  // Прежние тесты звали handleCoffeeConsumableCounts напрямую и были зелёными,
  // пока в боте текстовый ввод был мёртв: диспетчер ждал шаг "counts", которого
  // после перехода на ввод по одному числу не существует. Проверяем путь,
  // которым идёт настоящее сообщение.
  it("одно число текстом на шаге «вода» принимается и ведёт к стаканчикам", async () => {
    const { core } = stubCore();
    const conversations = new Conversations();
    conversations.start(555, "coffee-consumable", "water", { locationId: LOC, locationName: "AH", draft: "" });
    const { reply } = await handleStaffMessage(555, "2", ME, { core, conversations } as never);
    assert.match(reply.text, /Стакан/i, "шаг продвинулся, а не повторил вопрос");
    assert.equal(conversations.get(555)?.step, "cups");
  });

  it("три числа одной строкой доходят до проверки — как обещано в коммите", async () => {
    const { core, calls } = stubCore();
    const conversations = new Conversations();
    conversations.start(555, "coffee-consumable", "water", { locationId: LOC, locationName: "AH", draft: "" });
    const { reply } = await handleStaffMessage(555, "2 100 50", ME, { core, conversations } as never);
    assert.match(reply.text, /проверь/i);
    assert.match(reply.text, /Стаканчики: 100/);
    assert.equal(calls.length, 0, "запись только после подтверждения");
  });

  it("мусор на шаге — внятный отказ, а не тот же вопрос по кругу", async () => {
    const { core } = stubCore();
    const conversations = new Conversations();
    conversations.start(555, "coffee-consumable", "cups", { locationId: LOC, locationName: "AH", draft: "" });
    const { reply } = await handleStaffMessage(555, "много", ME, { core, conversations } as never);
    assert.match(reply.text, /Не понял число/);
    assert.equal(conversations.get(555)?.step, "cups", "шаг не потерян");
  });
});

describe("Сбой посреди возвратов — молчания и потери строк больше нет", () => {
  it("частичный сбой: сводка говорит «N из M» и перечисляет строки для повтора", async () => {
    // Раньше исключение на второй строке улетало наверх: первая уже записана,
    // ответа нет, человек пересылал всё сообщение и дублировал записанное.
    const { core, calls } = stubCore({
      recordContainerReturn: async (input: Record<string, unknown>) => {
        if (input.containerNumber === 19) throw new Error("Core недоступен");
        calls.push({ kind: "return", input });
        return { id: "ret-ok" };
      },
    });
    const parsed = tryParseContainerReturns("Кпп остатки\n1. 026. 1119\n2. 019. 1944");
    assert.ok(parsed);
    const reply = await recordContainerReturns(parsed, ME, { core, conversations: new Conversations() });
    assert.match(reply.text, /1 из 2/);
    assert.match(reply.text, /отправь ТОЛЬКО их/i);
    assert.match(reply.text, /2\. 019\. 1944/, "строка для повтора — в том же формате, каким её набирают");
    assert.equal(calls.length, 1, "успешная строка записана ровно один раз");
  });

  it("полный сбой: честное «ни одна строка не записана», а не тишина и не «✅»", async () => {
    const { core } = stubCore({
      recordContainerReturn: async () => {
        throw new Error("Core недоступен");
      },
    });
    const parsed = tryParseContainerReturns("1. 026. 1119\n2. 019. 1944");
    assert.ok(parsed);
    const reply = await recordContainerReturns(parsed, ME, { core, conversations: new Conversations() });
    assert.match(reply.text, /ни одна строка не записана/i);
    assert.doesNotMatch(reply.text, /✅/);
  });
});

describe("Пересланный старый список остатков (аудит 18.08)", () => {
  const OLD = [
    { position: 1, containerNumber: 26, weight: 1119, returnedDate: "2026-08-10" },
    { position: 2, containerNumber: 19, weight: 1944, returnedDate: "2026-08-10" },
  ];

  it("все строки совпадают с журналом за прошлые дни — не записываем, объясняем", async () => {
    const { core, calls } = stubCore({ containerReturns: async () => OLD });
    const parsed = tryParseContainerReturns("Кпп остатки\n1. 026. 1119\n2. 019. 1944");
    assert.ok(parsed);
    const reply = await recordContainerReturns(parsed, ME, { core, conversations: new Conversations() });
    assert.match(reply.text, /уже записанный список/i);
    assert.match(reply.text, /по одной/i, "выход для честного совпадения назван");
    assert.equal(calls.filter((c) => (c as { kind: string }).kind === "return").length, 0);
  });

  it("хотя бы одна строка новая — список записывается целиком", async () => {
    const { core, calls } = stubCore({ containerReturns: async () => OLD });
    const parsed = tryParseContainerReturns("Кпп остатки\n1. 026. 1119\n5. 003. 777");
    assert.ok(parsed);
    await recordContainerReturns(parsed, ME, { core, conversations: new Conversations() });
    assert.equal(calls.filter((c) => (c as { kind: string }).kind === "return").length, 2);
  });

  it("одна строка проходит всегда — это и есть путь-переопределение", async () => {
    const { core, calls } = stubCore({ containerReturns: async () => OLD });
    const parsed = tryParseContainerReturns("1. 026. 1119");
    assert.ok(parsed);
    await recordContainerReturns(parsed, ME, { core, conversations: new Conversations() });
    assert.equal(calls.filter((c) => (c as { kind: string }).kind === "return").length, 1);
  });
});

describe("Гейт пересланных списков: пустые бункеры не свидетельствуют", () => {
  const OLDDAY = [
    { position: 1, containerNumber: 26, weight: 620, returnedDate: "2026-08-10" },
    { position: 2, containerNumber: 19, weight: 600, returnedDate: "2026-08-10" },
  ];
  const TARE = [
    { containerNumber: 26, position: 1, tareWeight: 620 },
    { containerNumber: 19, position: 2, tareWeight: 600 },
  ];

  it("список из одних пустых бункеров с «вчерашними» весами записывается", async () => {
    // Вес пустого набора равен таре и честно повторяется день ко дню —
    // совпадение с прошлым здесь не признак пересылки.
    const { core, calls } = stubCore({
      containerReturns: async () => OLDDAY,
      coffeeTare: async () => TARE,
    });
    const parsed = tryParseContainerReturns("1. 026. 620\n2. 019. 600");
    assert.ok(parsed);
    await recordContainerReturns(parsed, ME, { core, conversations: new Conversations() });
    assert.equal(calls.filter((c) => (c as { kind: string }).kind === "return").length, 2);
  });

  it("информативные строки со старыми весами по-прежнему отсекаются", async () => {
    const old = [
      { position: 1, containerNumber: 26, weight: 1119, returnedDate: "2026-08-10" },
      { position: 2, containerNumber: 19, weight: 1944, returnedDate: "2026-08-10" },
    ];
    const { core, calls } = stubCore({
      containerReturns: async () => old,
      coffeeTare: async () => TARE,
    });
    const parsed = tryParseContainerReturns("1. 026. 1119\n2. 019. 1944");
    assert.ok(parsed);
    const reply = await recordContainerReturns(parsed, ME, { core, conversations: new Conversations() });
    assert.match(reply.text, /уже записанный список/i);
    assert.equal(calls.filter((c) => (c as { kind: string }).kind === "return").length, 0);
  });
});
