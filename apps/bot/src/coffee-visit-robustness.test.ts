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
    assert.match(retry.edit?.text ?? retry.message ?? "", /Какой бункер/i, "обход уцелел, клавиатура пришла");
  });
});

describe("Повторная проверка: дефекты, найденные во второй волне аудита", () => {
  it("D1: кнопка меню точки работает и ПОСРЕДИ подшага заливки", async () => {
    const { d } = deps();
    await toVisitMenu(d);
    await CB(d, "cv:more");           // подшаг: выбор бункера, flow=coffee-refill
    const res = await CB(d, "cv:cons"); // кнопка меню точки со старого сообщения
    assert.doesNotMatch(res.answer, /устарела/i, "это кнопка ТЕКУЩЕГО обхода");
    assert.match(res.edit?.text ?? res.message ?? "", /Вода/i, "расходники начались");
  });

  it("D3: «уже сохранена» НЕ говорится про брошенную без записи заливку", async () => {
    const { d, calls } = deps();
    await toVisitMenu(d);
    await CB(d, "cv:more");
    await CB(d, "cf:pos:7");
    for (const c of "7") await CB(d, "cf:n:" + c); // набрал набор, но не дожал
    await TX(d, "💧 Расходники");                   // ушёл нижней кнопкой — заливка брошена
    const stale = await CB(d, "cf:n:ok");            // «Готово» на старом экране заливки
    assert.doesNotMatch(stale.message ?? "", /уже сохранена/i, "записи не было — врать нельзя");
    assert.equal(calls.filter((c) => c.kind === "refill").length, 1, "в Core только первая заливка");
  });

  it("D4: «Отмена» в заливке, начатой ИЗ МЕНЮ (не обход), ведёт к выбору точки", async () => {
    const { d } = deps();
    const start = await TX(d, "☕ Заливка бункера");
    await CB(d, start.keyboard!.inline_keyboard[0][0].callback_data!);
    const res = await CB(d, "cf:cancel");
    assert.doesNotMatch(res.message ?? "", /Ты на точке/i, "обхода не было — некуда возвращать");
    assert.match(res.message ?? "", /отменил/i);
  });

  it("D5: флаг «расходники внесены» переживает повторный заход в расходники", async () => {
    const { d } = deps();
    await toVisitMenu(d);
    await CB(d, "cv:cons");
    for (let i = 0; i < 3; i++) await CB(d, "cc:n:skip");
    await CB(d, "cc:save");            // расходники записаны, consumables=true
    await CB(d, "cv:cons");            // зашёл снова
    const back = await CB(d, "cc:cancel"); // и передумал
    assert.match(JSON.stringify(back.keyboard), /внесены/, "кнопка помнит, что уже внесено");
  });

  it("D6: подпись скрытой кнопки отвечает «не готово», не трогая обход", async () => {
    const { d } = deps();
    await toVisitMenu(d);
    const res = await TX(d, "📦 Заполнил автомат");
    assert.match(res.text, /пока не готово/i);
    const more = await CB(d, "cv:more");
    assert.match(more.edit?.text ?? more.message ?? "", /Какой бункер/i, "обход жив");
  });

  it("D7: «Отмена» мойки с чужого экрана не гасит обход", async () => {
    const { d } = deps();
    await toVisitMenu(d);
    const stale = await CB(d, "cw:cancel"); // старый экран мойки
    assert.match(stale.answer, /устарела/i);
    const more = await CB(d, "cv:more");
    assert.match(more.edit?.text ?? more.message ?? "", /Какой бункер/i, "обход жив");
  });

  it("D2: уход нижней кнопкой посреди ввода предупреждает о брошенных цифрах", async () => {
    const { d } = deps();
    await toVisitMenu(d);
    await CB(d, "cv:more");
    await CB(d, "cf:pos:7");
    for (const c of "16") await CB(d, "cf:n:" + c); // набрал половину веса
    const res = await TX(d, "💧 Расходники");
    assert.match(res.text, /не дописан/i, "о выброшенном вводе сказано");
    assert.match(res.text, /Вода/i, "и расходники начались на той же точке");
  });

  it("истёкший визард по-прежнему говорит, как начать заново", async () => {
    const { d } = deps();
    const res = await CB(d, "cf:pos:7"); // беседы нет вовсе
    assert.match(res.message ?? "", /Начни заново/i);
  });
});

describe("Аудит 18.08: слот беседы и вечные кнопки", () => {
  it("слово «отмена» посреди подшага ведёт себя как кнопка: точка остаётся", async () => {
    const { d } = deps();
    await toVisitMenu(d);
    await CB(d, "cv:more"); // подшаг заливки
    const res = await TX(d, "отмена");
    assert.match(res.text, /Ты на точке «Olma office»/, "обход жив");
    assert.match(JSON.stringify(res.keyboard), /cv:more/, "меню точки на месте");
  });

  it("слово «отмена» на меню точки закрывает обход, записанное цело", async () => {
    const { d, calls } = deps();
    await toVisitMenu(d);
    const res = await TX(d, "отмена");
    assert.match(res.text, /закрыт.*записанное цело/i);
    assert.equal(calls.filter((c) => c.kind === "refill").length, 1);
  });

  it("слово «вода» посреди обхода продолжает на той же точке (D8)", async () => {
    const { d } = deps();
    await toVisitMenu(d);
    const res = await TX(d, "вода");
    assert.match(res.text, /Вода/i, "сразу вопрос про воду");
    assert.doesNotMatch(res.text, /какой точки/i, "точку заново не спрашиваем");
  });

  it("непонятый текст на меню точки не уходит комментарием к чужой задаче", async () => {
    let commented = false;
    const { d } = deps({
      myTasks: async () => [
        {
          id: "t1",
          title: "Задача",
          description: null,
          ownerKind: "human",
          ownerRef: ME.id,
          status: "in_progress",
          priority: "normal",
          due: null,
          resultNote: null,
          entityId: null,
        },
      ],
      addTaskComment: async () => {
        commented = true;
        return {};
      },
    });
    await toVisitMenu(d);
    const res = await TX(d, "нет воды на точке");
    assert.match(res.text, /Ты на точке/);
    assert.equal(commented, false, "текст не превратился в комментарий к задаче");
  });

  it("«Это повтор» при первой заливке из меню оставляет ЖИВОЕ меню точки", async () => {
    const { todayIso } = await import("./coffee-refill");
    const { d } = deps({
      recentRefills: async () => [
        {
          locationId: LOC,
          position: 7,
          containerNumber: 7,
          filledWeight: 1600,
          enteredDate: todayIso(),
        },
      ],
    });
    // Заливка ИЗ МЕНЮ (не из обхода): twin уже в базе — запись прошла раньше,
    // ответ утонул. «Это повтор» обязан дать работающее меню точки.
    const start = await TX(d, "☕ Заливка бункера");
    await CB(d, start.keyboard!.inline_keyboard[0][0].callback_data!);
    await CB(d, "cf:pos:7");
    for (const c of "7") await CB(d, "cf:n:" + c);
    await CB(d, "cf:n:ok");
    await CB(d, "cf:n:skip");
    for (const c of "1600") await CB(d, "cf:n:" + c);
    const dup = await CB(d, "cf:n:ok");
    assert.match(dup.edit?.text ?? dup.message ?? "", /повтор/i, "вопрос про дубль задан");
    await CB(d, "cf:dup:skip");
    const more = await CB(d, "cv:more");
    assert.match(more.edit?.text ?? more.message ?? "", /Какой бункер/i, "меню точки живое, а не «кнопка от прошлого обхода»");
  });

  it("двойной «Следующая точка» не пугает ложным «не дописано другое»", async () => {
    const { d } = deps();
    await toVisitMenu(d);
    await CB(d, "cv:next");
    const second = await CB(d, "cv:next");
    assert.match(second.message ?? "", /Уже выбираешь точку/);
  });

  it("устаревшая «Отмена» замены детали не гасит обход", async () => {
    const { d } = deps();
    await toVisitMenu(d);
    const res = await CB(d, "pt:x");
    assert.equal(res.answer, "Кнопка устарела");
    const more = await CB(d, "cv:more");
    assert.match(more.edit?.text ?? more.message ?? "", /Какой бункер/i, "обход жив");
  });

  it("пропавший обход не называется «завершённым»", async () => {
    const { d } = deps();
    const res = await CB(d, "cv:more");
    assert.match(res.message ?? "", /завершён или истёк/i, "TTL не выдаётся за завершение");
  });
});
