import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Conversations } from "./conversation";
import type { PersonRow } from "./core-client";
import { handleStaffCallback, handleStaffMessage } from "./staff";

/**
 * Устойчивость обхода — по находкам аудита 17.08.2026.
 *
 * Все проверки идут ЧЕРЕЗ ДИСПЕТЧЕР (handleStaffMessage / handleStaffCallback),
 * а не через обработчики напрямую. Это принципиально: прошлая регрессия
 * (мёртвый текстовый ввод расходников) пережила 1763 зелёных теста именно
 * потому, что тесты звали обработчик в обход маршрутизации.
 */

const ME: PersonRow = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Рустам",
  role: "оператор",
  roles: ["operator"],
  tgUsername: "rustam",
  tgChatId: "555",
  active: "yes",
} as PersonRow;

const LOC = "44444444-4444-4444-8444-444444444444";
const CHAT = 555;

function deps(over: Record<string, unknown> = {}) {
  const calls: { kind: string; input?: Record<string, unknown> }[] = [];
  const core = {
    coffeeLocations: async () => [{ id: LOC, name: "Olma office", isActive: true }],
    coffeeBunkerConfig: async () => [{ position: 7, ingredientId: "ing", ingredientName: "Кофе", packageWeight: 1000 }],
    coffeeTare: async () => [{ containerNumber: 7, position: 7, tareWeight: 600 }],
    recentRefills: async () => [],
    submitCoffeeRefill: async (input: Record<string, unknown>) => {
      calls.push({ kind: "refill", input });
      return { id: "r1" };
    },
    recordCoffeeConsumable: async (input: Record<string, unknown>) => {
      calls.push({ kind: "consumable", input });
      return { id: "c1" };
    },
    myTasks: async () => [],
    unassignedTasks: async () => [],
    ...over,
  };
  return { d: { core, conversations: new Conversations() } as never, calls };
}

const CB = (d: never, data: string) => handleStaffCallback(CHAT, data, ME, d);
const TX = async (d: never, text: string) => (await handleStaffMessage(CHAT, text, ME, d)).reply;

/** Довести до меню точки: одна записанная заливка. */
async function toVisitMenu(d: never) {
  const start = await TX(d, "☕ Заливка бункера");
  await CB(d, start.keyboard!.inline_keyboard[0][0].callback_data!);
  await CB(d, "cf:pos:7");
  for (const c of "7") await CB(d, "cf:n:" + c);
  await CB(d, "cf:n:ok"); // набор
  await CB(d, "cf:n:skip"); // бункер был пуст
  for (const c of "1600") await CB(d, "cf:n:" + c);
  return CB(d, "cf:n:ok"); // вес → запись
}

describe("Обход: отмена не уносит точку", () => {
  it("«Отмена» на выборе бункера возвращает в меню точки, а не в начало", async () => {
    const { d, calls } = deps();
    await toVisitMenu(d);
    await CB(d, "cv:more");
    const res = await CB(d, "cf:cancel");
    assert.match(res.message!, /Ты на точке «Olma office»/, "точка осталась выбранной");
    assert.match(JSON.stringify(res.keyboard), /cv:more/, "меню точки вернулось");
    assert.equal(calls.length, 1, "записанная заливка не потеряна");
  });

  it("«Отмена» расходников тоже оставляет на точке", async () => {
    const { d } = deps();
    await toVisitMenu(d);
    await CB(d, "cv:cons");
    const res = await CB(d, "cc:cancel");
    assert.match(res.message!, /Ты на точке «Olma office»/);
    assert.match(JSON.stringify(res.keyboard), /cv:more/);
  });

  it("«Отмена» с ЧУЖОГО экрана не гасит текущий мастер", async () => {
    const { d } = deps();
    await toVisitMenu(d);
    await CB(d, "cv:cons"); // идём в расходники
    for (const c of "2") await CB(d, "cc:n:" + c);
    // Наверху в чате висит старый экран заливки со своей «Отмена».
    const res = await CB(d, "cf:cancel");
    assert.match(res.message!, /устарела|не действует/i);
    // Набранная вода цела: продолжаем расходники дальше.
    const next = await CB(d, "cc:n:ok");
    assert.match(next.edit!.text, /Стакан/i, "ввод расходников не сброшен");
  });
});

describe("Обход: устаревшие кнопки", () => {
  it("двойное «Готово» не говорит «начни заново» и не толкает на дубль", async () => {
    const { d, calls } = deps();
    await toVisitMenu(d);
    const again = await CB(d, "cf:n:ok"); // то же нажатие ещё раз
    assert.doesNotMatch(again.message ?? "", /начни заново/i);
    assert.match(again.message!, /уже сохранена/i);
    assert.equal(calls.length, 1, "второй записи нет");
  });

  it("«Следующая точка» не стирает другой начатый мастер", async () => {
    const { d } = deps();
    await toVisitMenu(d);
    await CB(d, "cv:done"); // точка закрыта
    // Человек занялся другим: начал мастер новой карточки.
    await TX(d, "🆕 Новая карточка");
    const stale = await CB(d, "cv:next");
    assert.match(stale.answer, /устарела/i, "всплывающий ответ на нажатие");
    assert.match(stale.message!, /не дописано другое/i);
    // Мастер карточки жив: следующий текст всё ещё принимает он.
    const after = await TX(d, "Кофемашина №5");
    assert.doesNotMatch(after.text, /Какая точка/i, "заливка не перехватила ввод");
  });
});

describe("Обход: кнопка нижнего меню продолжает точку", () => {
  it("«Расходники» с нижней клавиатуры не сбрасывает обход", async () => {
    const { d } = deps();
    await toVisitMenu(d);
    const res = await TX(d, "💧 Расходники");
    assert.match(res.text, /Вода/i, "сразу спрашиваем воду");
    assert.doesNotMatch(res.text, /какой точки/i, "точку второй раз не спрашиваем");
    assert.doesNotMatch(res.text, /не дописано/i, "и не пугаем ложной потерей");
  });

  it("«Заливка бункера» с нижней клавиатуры ведёт к бункеру, а не к выбору точки", async () => {
    const { d } = deps();
    await toVisitMenu(d);
    const res = await TX(d, "☕ Заливка бункера");
    assert.match(res.text, /Какой бункер/i);
    assert.doesNotMatch(res.text, /Какая точка/i);
  });
});

describe("Обход: сбой Core не ломает состояние", () => {
  it("«Ещё бункер» при недоступном Core оставляет обход живым", async () => {
    let fail = true;
    const { d } = deps({
      coffeeBunkerConfig: async () => {
        if (fail) throw new Error("ECONNRESET");
        return [{ position: 7, ingredientId: "ing", ingredientName: "Кофе" }];
      },
    });
    // Первая заливка нужна до сбоя — конфиг спрашивается на шаге позиции.
    fail = false;
    await toVisitMenu(d);
    fail = true;
    await CB(d, "cv:more").catch(() => undefined);
    // Сеть вернулась — повторное нажатие обязано найти обход и сработать.
    fail = false;
    const retry = await CB(d, "cv:more");
    assert.match(retry.message ?? "", /Какой бункер/i, "обход уцелел, клавиатура пришла");
  });
});
