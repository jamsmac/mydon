import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Conversations } from "./conversation";
import type { PersonRow } from "./core-client";
import {
  handleCoffeeRefillBefore,
  handleCoffeeRefillCallback,
  handleCoffeeRefillContainer,
  handleCoffeeRefillWeight,
  handleCoffeeWashCallback,
  isCoffeeRefillTrigger,
  isCoffeeWashTrigger,
  parseAmount,
  parseCoffeeRefillCallback,
  parseCoffeeWashCallback,
  startCoffeeRefill,
  startCoffeeWash,
  todayIso,
} from "./coffee-refill";

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
  const calls: unknown[] = [];
  const core = {
    coffeeLocations: async () => [{ id: LOC, name: "American Hospital", isActive: true, operational: true }],
    coffeeBunkerConfig: async () => [
      { position: 1, ingredientId: "ing-1", ingredientName: "Сухое молоко" },
      { position: 7, ingredientId: "ing-2", ingredientName: "Кофе" },
    ],
    recentRefills: async () => [],
    coffeeTare: async () => [
      { containerNumber: 7, position: 7, tareWeight: 600 },
      { containerNumber: 27, position: 1, tareWeight: 630 },
    ],
    submitCoffeeRefill: async (input: Record<string, unknown>) => {
      calls.push({ kind: "refill", input });
      return { id: "refill-1" };
    },
    recordCoffeeWash: async (input: Record<string, unknown>) => {
      calls.push({ kind: "wash", input });
      return { id: "wash-1" };
    },
    ...over,
  } as never;
  return { core, calls };
}

describe("Триггеры и разбор ввода — кофе-бункеры", () => {
  it("isCoffeeRefillTrigger распознаёт «бункер»/«засыпал»", () => {
    assert.equal(isCoffeeRefillTrigger("бункер"), true);
    assert.equal(isCoffeeRefillTrigger("засыпал молоко"), true);
    assert.equal(isCoffeeRefillTrigger("залил кофе"), true);
    assert.equal(isCoffeeRefillTrigger("привет"), false);
  });

  it("isCoffeeWashTrigger распознаёт «помыл»", () => {
    assert.equal(isCoffeeWashTrigger("помыл бункер"), true);
    assert.equal(isCoffeeWashTrigger("мойка бункера"), true);
    assert.equal(isCoffeeWashTrigger("привет"), false);
  });

  it("parseAmount: целые и дробные, мусор — null", () => {
    assert.equal(parseAmount("1200"), 1200);
    assert.equal(parseAmount("1200,5"), 1200.5);
    assert.equal(parseAmount("много"), null);
    assert.equal(parseAmount("-5"), null);
  });

  it("todayIso — формат YYYY-MM-DD", () => {
    assert.match(todayIso(new Date("2026-08-03T12:00:00Z")), /^\d{4}-\d{2}-\d{2}$/);
  });

  it("parseCoffeeRefillCallback: строгий формат, cf: пространство", () => {
    assert.deepEqual(parseCoffeeRefillCallback(`cf:loc:${LOC}`), { kind: "location", id: LOC });
    assert.deepEqual(parseCoffeeRefillCallback("cf:pos:7"), { kind: "position", position: 7 });
    assert.deepEqual(parseCoffeeRefillCallback("cf:cancel"), { kind: "cancel" });
    assert.equal(parseCoffeeRefillCallback("cf:pos:9"), null, "позиция вне 1–8");
    assert.equal(parseCoffeeRefillCallback(`cw:loc:${LOC}`), null, "чужое пространство cw: не парсим");
  });

  it("parseCoffeeWashCallback: строгий формат, cw: пространство", () => {
    assert.deepEqual(parseCoffeeWashCallback(`cw:loc:${LOC}`), { kind: "location", id: LOC });
    assert.deepEqual(parseCoffeeWashCallback("cw:pos:1"), { kind: "position", position: 1 });
    assert.equal(parseCoffeeWashCallback(`cf:loc:${LOC}`), null, "чужое пространство cf: не парсим");
  });
});

describe("Список точек для заливки", () => {
  it("точка без рабочего аппарата уходит вниз с пометкой, но остаётся достижимой", async () => {
    const СКЛАД = "55555555-5555-4555-8555-555555555555";
    const { core } = stubCore({
      coffeeLocations: async () => [
        // Аппарат увезли — размещение закрылось, точка осталась. Идёт первой,
        // чтобы проверить именно перестановку, а не исходный порядок.
        { id: СКЛАД, name: "кардиология кпп", isActive: true, operational: false },
        { id: LOC, name: "American Hospital", isActive: true, operational: true },
      ],
    });
    const deps = { core, conversations: new Conversations() };

    const start = await startCoffeeRefill(1, deps);
    const строки = start.keyboard!.inline_keyboard.flat();
    const кнопки = строки.map((b) => b.callback_data);
    // Прятать нельзя: ремонт закрывает размещение, а возврат в строй его не
    // открывает — спрятанная точка не вернулась бы в список никогда.
    assert.ok(кнопки.includes(`cf:loc:${СКЛАД}`), "точка обязана остаться достижимой");
    assert.ok(
      кнопки.indexOf(`cf:loc:${LOC}`) < кнопки.indexOf(`cf:loc:${СКЛАД}`),
      "рабочая точка должна стоять выше",
    );
    const метка = строки.find((b) => b.callback_data === `cf:loc:${СКЛАД}`)!.text;
    assert.match(метка, /нет аппарата/, "нерабочая точка должна быть помечена");
  });

  it("ручной флаг «выключена» по-прежнему убирает точку, даже с рабочим аппаратом", async () => {
    const { core } = stubCore({
      coffeeLocations: async () => [
        { id: LOC, name: "American Hospital", isActive: false, operational: true },
      ],
    });
    const deps = { core, conversations: new Conversations() };

    const start = await startCoffeeRefill(1, deps);
    assert.match(start.text, /нет|пуст/i);
  });
});

describe("Заливка бункера: полный визард (точка → позиция → набор → было → вес)", () => {
  it("проходит все шаги и сохраняет заливку с сегодняшней датой", async () => {
    const { core, calls } = stubCore();
    const conversations = new Conversations();
    const deps = { core, conversations };

    const start = await startCoffeeRefill(1, deps);
    assert.match(start.text, /Какая точка/);
    // Одна точка + ряд отмены: выйти из мастера должно быть можно кнопкой,
    // а не только словом «отмена», о котором надо откуда-то знать.
    assert.equal(start.keyboard!.inline_keyboard.length, 2);
    assert.equal(start.keyboard!.inline_keyboard[1][0].callback_data, "cf:cancel");

    const locCb = parseCoffeeRefillCallback(`cf:loc:${LOC}`)!;
    const afterLoc = await handleCoffeeRefillCallback(1, locCb, ME, deps);
    assert.match(afterLoc.message!.text, /American Hospital.*бункер/i);

    const posCb = parseCoffeeRefillCallback("cf:pos:7")!;
    const afterPos = await handleCoffeeRefillCallback(1, posCb, ME, deps);
    assert.match(afterPos.message!.text, /Бункер 7/);

    const afterContainer = await handleCoffeeRefillContainer(1, "7", ME, deps);
    assert.match(afterContainer.text, /ДО досыпки/i);

    const afterBefore = await handleCoffeeRefillBefore(1, "-", deps);
    assert.match(afterBefore.text, /ПОСЛЕ засыпки/i);

    const done = await handleCoffeeRefillWeight(1, "1200", deps, ME);
    assert.match(done.text, /✅ Записал/);
    assert.match(done.text, /American Hospital/);
    // Главная строка — чистый вес: 1200 брутто − 600 тара набора 7 на позиции 7.
    assert.match(done.text, /Чистый ингредиент: 600 г/);
    assert.doesNotMatch(done.text, /Упаковок/);

    assert.equal(calls.length, 1);
    const refillCall = calls[0] as { kind: string; input: Record<string, unknown> };
    assert.equal(refillCall.kind, "refill");
    assert.equal(refillCall.input.locationId, LOC);
    assert.equal(refillCall.input.position, 7);
    assert.equal(refillCall.input.filledWeight, 1200);
    assert.ok(!("packageCount" in refillCall.input), "упаковки больше не спрашиваем — учёт в граммах");
    assert.equal(refillCall.input.containerNumber, 7);
    assert.equal(refillCall.input.createdBy, `person:${ME.id}`);
    assert.match(String(refillCall.input.enteredDate), /^\d{4}-\d{2}-\d{2}$/);

    // Обход продолжается: точка остаётся выбранной, дальше — меню точки.
    assert.equal(conversations.get(1)?.flow, "coffee-visit");
    assert.match(JSON.stringify(done.keyboard), /cv:more/, "предлагаем ещё бункер на той же точке");
  });

  it("«-» на наборе — набор не передаётся, чистый вес не выдумывается", async () => {
    const { core, calls } = stubCore();
    const conversations = new Conversations();
    const deps = { core, conversations };

    await startCoffeeRefill(1, deps);
    await handleCoffeeRefillCallback(1, { kind: "location", id: LOC }, ME, deps);
    await handleCoffeeRefillCallback(1, { kind: "position", position: 1 }, ME, deps);
    await handleCoffeeRefillContainer(1, "-", ME, deps);
    await handleCoffeeRefillBefore(1, "-", deps);
    const done = await handleCoffeeRefillWeight(1, "600", deps, ME);

    assert.match(done.text, /Набор не назван/i, "без набора честно говорим, что нетто не посчитать");
    const refillCall = calls[0] as { kind: string; input: Record<string, unknown> };
    assert.ok(!("packageCount" in refillCall.input), "упаковки не подставляем единицей");
    assert.ok(!("containerNumber" in refillCall.input));
  });

  it("мусор вместо веса — переспрашивает, не продвигает шаг", async () => {
    const { core } = stubCore();
    const conversations = new Conversations();
    const deps = { core, conversations };
    await startCoffeeRefill(1, deps);
    await handleCoffeeRefillCallback(1, { kind: "location", id: LOC }, ME, deps);
    await handleCoffeeRefillCallback(1, { kind: "position", position: 1 }, ME, deps);
    await handleCoffeeRefillContainer(1, "27", ME, deps);
    await handleCoffeeRefillBefore(1, "-", deps);
    const res = await handleCoffeeRefillWeight(1, "много", deps);
    assert.match(res.text, /Не понял число/);
    assert.equal(conversations.get(1)?.step, "weight", "шаг не продвинулся");
  });

  it("набор вне диапазона 1–27 — отклоняется", async () => {
    const { core } = stubCore();
    const conversations = new Conversations();
    const deps = { core, conversations };
    await startCoffeeRefill(1, deps);
    await handleCoffeeRefillCallback(1, { kind: "location", id: LOC }, ME, deps);
    await handleCoffeeRefillCallback(1, { kind: "position", position: 1 }, ME, deps);
    const res = await handleCoffeeRefillContainer(1, "99", ME, deps);
    assert.match(res.text, /1–27/);
    assert.equal(conversations.get(1)?.step, "container");
  });

  it("«отмена» через cancel-колбэк бросает визард", async () => {
    const { core, calls } = stubCore();
    const conversations = new Conversations();
    const deps = { core, conversations };
    await startCoffeeRefill(1, deps);
    const res = await handleCoffeeRefillCallback(1, { kind: "cancel" }, ME, deps);
    assert.match(res.message!.text, /отменил/i);
    assert.equal(conversations.get(1), null);
    assert.equal(calls.length, 0);
  });

  it("визард истёк — понятная ошибка на нажатие кнопки", async () => {
    const { core } = stubCore();
    const conversations = new Conversations();
    const deps = { core, conversations };
    const res = await handleCoffeeRefillCallback(1, { kind: "position", position: 1 }, ME, deps);
    assert.match(res.message!.text, /прервалась/);
  });
});

describe("Мойка бункера: точка → позиция → готово (без веса)", () => {
  it("два шага — сразу сохраняет, без промежуточных текстовых полей", async () => {
    const { core, calls } = stubCore();
    const conversations = new Conversations();
    const deps = { core, conversations };

    const start = await startCoffeeWash(1, deps);
    assert.match(start.text, /Мойка какой точки/);

    await handleCoffeeWashCallback(1, { kind: "location", id: LOC }, ME, deps);
    const done = await handleCoffeeWashCallback(1, { kind: "position", position: 1 }, ME, deps);

    assert.match(done.message!.text, /Мойка отмечена/);
    assert.equal(calls.length, 1);
    const washCall = calls[0] as { kind: string; input: Record<string, unknown> };
    assert.equal(washCall.kind, "wash");
    assert.equal(washCall.input.locationId, LOC);
    assert.equal(washCall.input.position, 1);
    assert.equal(washCall.input.kind, "wash");
    assert.equal(washCall.input.performedBy, `person:${ME.id}`);
    assert.equal(conversations.get(1), null);
  });
});

describe("Заливка кнопками: цифровая клавиатура и чистый вес", () => {
  /** Пройти мастер до шага набора — общее начало. */
  async function toContainerStep() {
    const { core, calls } = stubCore();
    const conversations = new Conversations();
    const deps = { core, conversations } as never;
    await startCoffeeRefill(1, deps);
    await handleCoffeeRefillCallback(1, { kind: "location", id: LOC }, ME, deps);
    const r = await handleCoffeeRefillCallback(1, { kind: "position", position: 7 }, ME, deps);
    return { deps, conversations, calls, screen: r };
  }

  async function type(deps: never, digits: string) {
    let last;
    for (const d of digits) {
      last = await handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "digit", digit: d } }, ME, deps);
    }
    return last;
  }

  const done = (deps: never) =>
    handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "done" } }, ME, deps);
  const skip = (deps: never) =>
    handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "skip" } }, ME, deps);

  it("после бункера спрашивает НАБОР, а не вес: без него тару не взять", async () => {
    const { screen } = await toContainerStep();
    assert.match(screen.message!.text, /набор/i);
    assert.ok(JSON.stringify(screen.message!.keyboard).includes("cf:n:1"), "клавиатура на месте");
  });

  it("набор перерисовывает то же сообщение, а не шлёт новое на каждую цифру", async () => {
    const { deps } = await toContainerStep();
    const r = await type(deps, "27");
    assert.ok(r?.edit, "перерисовка");
    assert.equal(r?.message, undefined, "нового сообщения нет");
  });

  it("«⌫» стирает по цифре, на пустом наборе перерисовку не шлёт", async () => {
    const { deps } = await toContainerStep();
    await type(deps, "12");
    const back = await handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "erase" } }, ME, deps);
    assert.ok(back.edit?.text.includes("Набрано: 1"));
    await handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "erase" } }, ME, deps);
    const empty = await handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "erase" } }, ME, deps);
    assert.equal(empty.edit, undefined, "Telegram отвергает правку тем же текстом");
  });

  it("«готово» на пустом весе не пропускает дальше", async () => {
    const { deps, conversations } = await toContainerStep();
    await type(deps, "7");
    await done(deps);
    await skip(deps);
    const r = await done(deps);
    assert.equal(r.edit, undefined);
    assert.equal(conversations.get(1)?.step, "weight", "остались на шаге веса");
  });

  it("считает чистый вес: брутто минус тара набора", async () => {
    const { deps, calls } = await toContainerStep();
    await type(deps, "7");
    await done(deps); // набор 7
    await skip(deps); // бункер был пуст
    await type(deps, "1600");
    const fin = await done(deps); // вес → сохранение

    const call = calls[0] as { input: Record<string, unknown> };
    assert.equal(call.input.filledWeight, 1600, "в базу идёт брутто, как и раньше");
    assert.equal(call.input.containerNumber, 7);
    // Тара набора 7 на позиции 7 = 600 → чистого 1000.
    assert.match(fin.edit!.text, /Чистый ингредиент: 1000 г/);
    assert.match(fin.edit!.text, /это и вноси в систему автомата/);
  });

  it("бункер был не пуст: показывает было → стало и сколько досыпали", async () => {
    const { deps, calls } = await toContainerStep();
    await type(deps, "7");
    await done(deps);
    await type(deps, "900");
    await done(deps); // было 900 брутто → 300 нетто
    await type(deps, "1600");
    await done(deps);

    const call = calls[0] as { input: Record<string, unknown> };
    assert.equal(call.input.measuredBefore, 900, "замер «до» уходит в базу");
    const last = calls.length;
    assert.equal(last, 1);
  });

  it("без набора чистый вес не выдумывает, а честно говорит об этом", async () => {
    const { deps } = await toContainerStep();
    await skip(deps); // набор неизвестен
    await skip(deps); // бункер был пуст
    await type(deps, "1600");
    const fin = await done(deps);
    assert.match(fin.edit!.text, /Набор не назван/i);
    assert.doesNotMatch(fin.edit!.text, /Чистый ингредиент/);
  });

  it("тара не откалибрована — тоже честно, а не брутто под видом нетто", async () => {
    const { core } = stubCore({ coffeeTare: async () => [] });
    const conversations = new Conversations();
    const deps = { core, conversations } as never;
    await startCoffeeRefill(1, deps);
    await handleCoffeeRefillCallback(1, { kind: "location", id: LOC }, ME, deps);
    await handleCoffeeRefillCallback(1, { kind: "position", position: 7 }, ME, deps);
    await type(deps, "7");
    await done(deps);  // набор
    await skip(deps);  // бункер был пуст
    await type(deps, "1600");
    const fin = await done(deps);
    assert.match(fin.edit!.text, /не откалибрована/i);
  });

  it("набор вне 1–27 не проходит", async () => {
    const { deps, calls } = await toContainerStep();
    await type(deps, "99");
    const r = await done(deps);
    assert.equal(r.edit, undefined, "шаг не сменился");
    assert.equal(calls.length, 0);
  });

  it("текстовый ввод продолжает работать и даёт тот же итог", async () => {
    const { deps, calls } = await toContainerStep();
    await handleCoffeeRefillContainer(1, "7", ME, deps);
    await handleCoffeeRefillBefore(1, "-", deps);
    const fin = await handleCoffeeRefillWeight(1, "1600", deps, ME);
    const call = calls[0] as { input: Record<string, unknown> };
    assert.equal(call.input.filledWeight, 1600);
    assert.match(fin.text, /Чистый ингредиент: 1000 г/);
  });
});

describe("Заливка: отказы и невозможные числа (найдено аудитом)", () => {
  async function toPackages(over: Record<string, unknown> = {}) {
    const { core, calls } = stubCore(over);
    const conversations = new Conversations();
    const deps = { core, conversations } as never;
    await startCoffeeRefill(1, deps);
    await handleCoffeeRefillCallback(1, { kind: "location", id: LOC }, ME, deps);
    await handleCoffeeRefillCallback(1, { kind: "position", position: 7 }, ME, deps);
    return { deps, conversations, calls };
  }
  const type = async (deps: never, s: string) => {
    for (const d of s) await handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "digit", digit: d } }, ME, deps);
  };
  const ok = (deps: never) => handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "done" } }, ME, deps);
  const skip = (deps: never) => handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "skip" } }, ME, deps);

  it("сервер не ответил — набранное не теряется, повторное «Готово» дописывает", async () => {
    let fail = true;
    const { deps, conversations, calls } = await toPackages({
      submitCoffeeRefill: async (input: Record<string, unknown>) => {
        if (fail) throw new Error("ECONNRESET");
        calls.push({ kind: "refill", input });
        return { id: "r1" };
      },
    });
    await type(deps, "7");
    await ok(deps);   // набор
    await skip(deps); // бункер был пуст
    await type(deps, "1600");
    const failed = await ok(deps);

    assert.match(failed.edit!.text, /Не записал/, "человеку сказано, что записи нет");
    assert.match(failed.edit!.text, /1600 г/, "введённое показано, чтобы было видно — оно цело");
    assert.ok(conversations.get(1), "разговор жив, заново набирать не надо");

    fail = false;
    const retried = await ok(deps);
    assert.equal(calls.length, 1, "со второго раза записалось");
    assert.match(retried.edit!.text, /✅ Записал/);
  });

  it("брутто меньше тары — не диктует отрицательный остаток, а велит перевесить", async () => {
    const { deps } = await toPackages();
    await type(deps, "7");
    await ok(deps);
    await skip(deps);
    await type(deps, "10"); // 10 г при таре 600 — промах разрядом
    const fin = await ok(deps);

    assert.doesNotMatch(fin.edit!.text, /Чистый ингредиент/, "нельзя называть это чистым весом");
    assert.doesNotMatch(fin.edit!.text, /-\d+ г — это и вноси/);
    assert.match(fin.edit!.text, /Не сходится/);
    assert.match(fin.edit!.text, /НЕ ВНОСИ/);
  });

  it("стало меньше, чем было — не печатает отрицательную досыпку как факт", async () => {
    const { deps } = await toPackages();
    await type(deps, "7");
    await ok(deps);
    await type(deps, "1600"); // было
    await ok(deps);
    await type(deps, "1000"); // стало — меньше
    const fin = await ok(deps);
    assert.doesNotMatch(fin.edit!.text, /досыпали -/);
    assert.match(fin.edit!.text, /стало МЕНЬШЕ/);
  });

  it("ингредиент позиции пишется в запись — иначе сверка расхода слепа", async () => {
    const { deps, calls } = await toPackages();
    await type(deps, "7");
    await ok(deps);
    await skip(deps);
    await type(deps, "1600");
    await ok(deps);
    const call = calls[0] as { input: Record<string, unknown> };
    assert.equal(call.input.ingredientId, "ing-2", "позиция 7 = Кофе из конфига");
  });

  it("две записи конфига на одну позицию — ингредиент не угадываем", async () => {
    const { core, calls } = stubCore({
      coffeeBunkerConfig: async () => [
        { position: 7, ingredientId: "ing-a", ingredientName: "Лимонный чай" },
        { position: 7, ingredientId: "ing-b", ingredientName: "Матча" },
      ],
    });
    const conversations = new Conversations();
    const deps = { core, conversations } as never;
    await startCoffeeRefill(1, deps);
    await handleCoffeeRefillCallback(1, { kind: "location", id: LOC }, ME, deps);
    await handleCoffeeRefillCallback(1, { kind: "position", position: 7 }, ME, deps);
    await type(deps, "7");
    await ok(deps);
    await skip(deps);
    await type(deps, "1600");
    await ok(deps);
    const call = calls[0] as { input: Record<string, unknown> };
    assert.ok(!("ingredientId" in call.input), "угаданное списание хуже отсутствующего");
  });
});

describe("Защита от дублей и упаковки по граммам", () => {
  const TWIN = {
    id: "old",
    locationId: LOC,
    position: 7,
    containerNumber: 7,
    filledWeight: 1600,
    enteredDate: todayIso(),
  };

  async function walk(over: Record<string, unknown> = {}) {
    const { core, calls } = stubCore(over);
    const conversations = new Conversations();
    const deps = { core, conversations } as never;
    const D = async (s: string) => {
      for (const d of s) await handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "digit", digit: d } }, ME, deps);
    };
    const OK = () => handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "done" } }, ME, deps);
    const SKIP = () => handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "skip" } }, ME, deps);
    await startCoffeeRefill(1, deps);
    await handleCoffeeRefillCallback(1, { kind: "location", id: LOC }, ME, deps);
    await handleCoffeeRefillCallback(1, { kind: "position", position: 7 }, ME, deps);
    await D("7");
    await OK();
    await SKIP();
    await D("1600");
    return { deps, calls, fin: await OK(), conversations };
  }

  it("такая же запись за сегодня — спрашивает, а не пишет молча", async () => {
    const { calls, fin } = await walk({ recentRefills: async () => [TWIN] });
    assert.equal(calls.length, 0, "до ответа человека ничего не записано");
    assert.match(fin.edit!.text, /уже есть за сегодня/i);
    assert.match(JSON.stringify(fin.edit!.keyboard), /cf:dup:skip/);
    assert.match(JSON.stringify(fin.edit!.keyboard), /cf:dup:write/);
  });

  it("«это повтор» — не пишет, но обход не роняет", async () => {
    const { deps, calls } = await walk({ recentRefills: async () => [TWIN] });
    const res = await handleCoffeeRefillCallback(1, { kind: "dupSkip" }, ME, deps);
    assert.equal(calls.length, 0);
    assert.match(res.edit!.text, /повтор/i);
    assert.match(JSON.stringify(res.edit!.keyboard), /cv:more/, "остались на точке");
  });

  it("«вторая заливка» — записывает, второй раз не переспрашивая", async () => {
    const { deps, calls } = await walk({ recentRefills: async () => [TWIN] });
    const res = await handleCoffeeRefillCallback(1, { kind: "dupWrite" }, ME, deps);
    assert.equal(calls.length, 1);
    assert.match(res.edit!.text, /✅ Записал/);
  });

  it("другой вес — не дубль, вопроса нет", async () => {
    const { calls } = await walk({ recentRefills: async () => [{ ...TWIN, filledWeight: 1599 }] });
    assert.equal(calls.length, 1, "записалось без вопросов");
  });

  it("вчерашняя такая же запись — не дубль", async () => {
    const { calls } = await walk({ recentRefills: async () => [{ ...TWIN, enteredDate: "2020-01-01" }] });
    assert.equal(calls.length, 1);
  });

  it("проверку не выполнить — записываем: потерять заливку хуже, чем пропустить дубль", async () => {
    const { calls } = await walk({
      recentRefills: async () => {
        throw new Error("сеть");
      },
    });
    assert.equal(calls.length, 1);
  });

  it("стики считаются штуками и целыми: полстика не бывает", async () => {
    const { fin } = await walk({
      coffeeBunkerConfig: async () => [
        { position: 7, ingredientId: "ing-2", ingredientName: "MacCoffee", packageWeight: 20, packageLabel: "шт" },
      ],
    });
    // 1000 г чистого при стике 20 г = 50 штук.
    assert.match(fin.edit!.text, /≈ 50 шт по весу/);
    assert.doesNotMatch(fin.edit!.text, /упаковк/);
  });

  it("склоняет единицу: 1 упаковка, 2 упаковки, 5 упаковок", async () => {
    for (const [per, want] of [
      [1000, /≈ 1 упаковка по весу/],
      [500, /≈ 2 упаковки по весу/],
      [200, /≈ 5 упаковок по весу/],
    ] as const) {
      const { fin } = await walk({
        coffeeBunkerConfig: async () => [
          { position: 7, ingredientId: "ing-2", ingredientName: "Кофе", packageWeight: per },
        ],
      });
      assert.match(fin.edit!.text, want, `вес пачки ${per}`);
    }
  });

  it("упаковки считаются из граммов и показываются дробью", async () => {
    const { fin } = await walk({
      coffeeBunkerConfig: async () => [
        { position: 7, ingredientId: "ing-2", ingredientName: "Кофе", packageWeight: 667 },
      ],
    });
    // 1600 − 600 тары = 1000 г; 1000 / 667 ≈ 1,5 пачки.
    assert.match(fin.edit!.text, /≈ 1,5 упаковки по весу/);
  });

  it("вес пачки не задан — строки про упаковки нет вовсе", async () => {
    const { fin } = await walk();
    assert.doesNotMatch(fin.edit!.text, /по весу/);
  });
});

describe("Позиция с несколькими ингредиентами", () => {
  async function walkPos3(cfg: unknown[]) {
    const { core } = stubCore({ coffeeBunkerConfig: async () => cfg });
    const conversations = new Conversations();
    const deps = { core, conversations } as never;
    const D = async (s: string) => {
      for (const d of s) await handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "digit", digit: d } }, ME, deps);
    };
    const OK = () => handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "done" } }, ME, deps);
    const SKIP = () => handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "skip" } }, ME, deps);
    await startCoffeeRefill(1, deps);
    await handleCoffeeRefillCallback(1, { kind: "location", id: LOC }, ME, deps);
    await handleCoffeeRefillCallback(1, { kind: "position", position: 7 }, ME, deps);
    await D("7");
    await OK();
    await SKIP();
    await D("1600");
    return OK();
  }

  it("расфасовка одинаковая — считаем, хотя ингредиент неизвестен", async () => {
    // Позиция 3 у владельца: лимонный чай и матча, обе пачки по 1000 г.
    const fin = await walkPos3([
      { position: 7, ingredientId: "a", ingredientName: "Лимонный чай", packageWeight: 1000 },
      { position: 7, ingredientId: "b", ingredientName: "Матча", packageWeight: 1000 },
    ]);
    assert.match(fin.edit!.text, /≈ 1 упаковка по весу/, "ответ не зависит от того, что засыпали");
  });

  it("расфасовка разная — молчим, а не выбираем наугад", async () => {
    const fin = await walkPos3([
      { position: 7, ingredientId: "a", ingredientName: "Чай", packageWeight: 1000 },
      { position: 7, ingredientId: "b", ingredientName: "Сахар", packageWeight: 2000 },
    ]);
    assert.doesNotMatch(fin.edit!.text, /по весу/, "уверенное «1 упаковка» было бы враньём для второго");
  });
});

describe("Двойная позиция: оператор выбирает ингредиент кнопкой", () => {
  const МАТЧА = "113d4b1c-ecad-4737-96dd-1c49b7dfa407";

  it("callback с ингредиентом разбирается, без него — как раньше", () => {
    assert.deepEqual(parseCoffeeRefillCallback(`cf:pos:3:${МАТЧА}`), {
      kind: "position",
      position: 3,
      ingredientId: МАТЧА,
    });
    assert.deepEqual(parseCoffeeRefillCallback("cf:pos:3"), { kind: "position", position: 3 });
    assert.equal(parseCoffeeRefillCallback("cf:pos:3:не-uuid"), null, "мусор в хвосте — не колбэк");
  });

  it("выбор оператора попадает в запись, а не теряется", async () => {
    // Ровно случай владельца: на позиции 3 стоят лимонный чай и матча, и за год
    // все 55 заливок туда записались БЕЗ ингредиента — сверка по ним невозможна.
    const cfg = [
      { position: 3, ingredientId: "чай", ingredientName: "Лимонный чай", packageWeight: 1000 },
      { position: 3, ingredientId: МАТЧА, ingredientName: "Матча", packageWeight: 500 },
    ];
    let записано: Record<string, unknown> | null = null;
    const { core } = stubCore({
      coffeeBunkerConfig: async () => cfg,
      submitCoffeeRefill: async (r: Record<string, unknown>) => {
        записано = r;
        return { ok: true };
      },
    });
    const conversations = new Conversations();
    const deps = { core, conversations } as never;
    const D = async (s: string) => {
      for (const d of s) await handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "digit", digit: d } }, ME, deps);
    };
    const OK = () => handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "done" } }, ME, deps);
    const SKIP = () => handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "skip" } }, ME, deps);

    await startCoffeeRefill(1, deps);
    await handleCoffeeRefillCallback(1, { kind: "location", id: LOC }, ME, deps);
    await handleCoffeeRefillCallback(1, { kind: "position", position: 3, ingredientId: МАТЧА }, ME, deps);
    await D("7");
    await OK();
    await SKIP();
    await D("1600");
    await OK();

    assert.ok(записано, "заливка записана");
    assert.equal((записано as Record<string, unknown>).ingredientId, МАТЧА, "именно матча, а не пусто");
    assert.equal((записано as Record<string, unknown>).position, 3);
  });

  it("исправил бункер после выбора — прежний ингредиент не прилипает", async () => {
    // Оператор жмёт «3 · Матча», понимает, что ошибся бункером, и тем же ещё
    // висящим экраном жмёт «7 · Кофе». Разговор СЛИВАЕТ данные, поэтому без
    // явного сброса матча осталась бы в состоянии и кофе списался бы на неё.
    // Записанный не тот ингредиент хуже прежнего молчания.
    const cfg = [
      { position: 3, ingredientId: "чай", ingredientName: "Лимонный чай", packageWeight: 1000 },
      { position: 3, ingredientId: МАТЧА, ingredientName: "Матча", packageWeight: 500 },
      { position: 7, ingredientId: "кофе", ingredientName: "Кофе", packageWeight: 1000 },
    ];
    let записано: Record<string, unknown> | null = null;
    const { core } = stubCore({
      coffeeBunkerConfig: async () => cfg,
      submitCoffeeRefill: async (r: Record<string, unknown>) => {
        записано = r;
        return { ok: true };
      },
    });
    const conversations = new Conversations();
    const deps = { core, conversations } as never;
    const D = async (s: string) => {
      for (const d of s) await handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "digit", digit: d } }, ME, deps);
    };
    const OK = () => handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "done" } }, ME, deps);
    const SKIP = () => handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "skip" } }, ME, deps);

    await startCoffeeRefill(1, deps);
    await handleCoffeeRefillCallback(1, { kind: "location", id: LOC }, ME, deps);
    await handleCoffeeRefillCallback(1, { kind: "position", position: 3, ingredientId: МАТЧА }, ME, deps);
    // передумал — тот же экран, другая позиция, у неё суффикса нет
    await handleCoffeeRefillCallback(1, { kind: "position", position: 7 }, ME, deps);
    await D("7");
    await OK();
    await SKIP();
    await D("1600");
    await OK();

    const r = записано as unknown as Record<string, unknown>;
    assert.equal(r.position, 7);
    assert.equal(r.ingredientId, "кофе", "кофе, а НЕ прилипшая матча");
  });

  it("сменил точку — выбор ингредиента сбрасывается", async () => {
    const cfg = [
      { position: 3, ingredientId: "чай", ingredientName: "Лимонный чай", packageWeight: 1000 },
      { position: 3, ingredientId: МАТЧА, ingredientName: "Матча", packageWeight: 500 },
    ];
    const { core } = stubCore({ coffeeBunkerConfig: async () => cfg });
    const conversations = new Conversations();
    const deps = { core, conversations } as never;
    await startCoffeeRefill(1, deps);
    await handleCoffeeRefillCallback(1, { kind: "location", id: LOC }, ME, deps);
    await handleCoffeeRefillCallback(1, { kind: "position", position: 3, ingredientId: МАТЧА }, ME, deps);
    await handleCoffeeRefillCallback(1, { kind: "location", id: LOC }, ME, deps);
    assert.equal(conversations.get(1)?.data.ingredientId ?? null, null, "выбор прошлой точки не переносится");
  });

  it("мойка не расщепляет кнопку — ингредиент ей не нужен", async () => {
    // Мойке всё равно, что в бункере: две одинаковые по смыслу кнопки на один
    // физический бункер заставили бы техника на бегу гадать, какую жать.
    const cfg = [
      { position: 3, ingredientId: "чай", ingredientName: "Лимонный чай", packageWeight: 1000 },
      { position: 3, ingredientId: МАТЧА, ingredientName: "Матча", packageWeight: 500 },
    ];
    const { core } = stubCore({ coffeeBunkerConfig: async () => cfg });
    const conversations = new Conversations();
    const deps = { core, conversations } as never;
    await startCoffeeWash(31, deps);
    const шаг = await handleCoffeeWashCallback(31, { kind: "location", id: LOC }, ME, deps);
    const кнопки = (шаг.message?.keyboard?.inline_keyboard ?? []).flat();
    const третьи = кнопки.filter((b) => b.callback_data.startsWith("cw:pos:3"));
    assert.equal(третьи.length, 1, "у мойки одна кнопка на позицию 3");
    assert.equal(третьи[0]!.callback_data, "cw:pos:3", "без хвоста с ингредиентом");
    assert.match(третьи[0]!.text, /Лимонный чай\/Матча/, "оба имени в одной подписи");
  });

  it("однозначная позиция по-прежнему не требует выбора", async () => {
    const cfg = [{ position: 7, ingredientId: "кофе", ingredientName: "Кофе", packageWeight: 1000 }];
    let записано: Record<string, unknown> | null = null;
    const { core } = stubCore({
      coffeeBunkerConfig: async () => cfg,
      submitCoffeeRefill: async (r: Record<string, unknown>) => {
        записано = r;
        return { ok: true };
      },
    });
    const conversations = new Conversations();
    const deps = { core, conversations } as never;
    const D = async (s: string) => {
      for (const d of s) await handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "digit", digit: d } }, ME, deps);
    };
    const OK = () => handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "done" } }, ME, deps);
    const SKIP = () => handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "skip" } }, ME, deps);
    await startCoffeeRefill(1, deps);
    await handleCoffeeRefillCallback(1, { kind: "location", id: LOC }, ME, deps);
    await handleCoffeeRefillCallback(1, { kind: "position", position: 7 }, ME, deps);
    await D("7");
    await OK();
    await SKIP();
    await D("1600");
    await OK();
    assert.equal((записано as unknown as Record<string, unknown>).ingredientId, "кофе", "определился сам");
  });
});

describe("Мойка: сбой Core не стирает разговор до записи", () => {
  it("падение записи оставляет мастер живым — повтор той же кнопки записывает", async () => {
    // Раньше clear стоял ДО recordCoffeeWash: после сбоя совет «попробуй ещё
    // раз» упирался в «Визард истёк», а «начни заново» дублировал мойку.
    const conversations = new Conversations();
    let fail = true;
    const { core, calls } = stubCore({
      recordCoffeeWash: async (input: Record<string, unknown>) => {
        if (fail) throw new Error("Core недоступен");
        calls.push({ kind: "wash", input });
        return { id: "wash-1" };
      },
    });
    const deps = { core, conversations };
    await startCoffeeWash(21, deps);
    await handleCoffeeWashCallback(21, { kind: "location", id: LOC }, ME, deps);
    await assert.rejects(handleCoffeeWashCallback(21, { kind: "position", position: 3 }, ME, deps));
    assert.equal(conversations.get(21)?.flow, "coffee-wash", "разговор жив — повтор возможен");

    fail = false;
    const done = await handleCoffeeWashCallback(21, { kind: "position", position: 3 }, ME, deps);
    assert.equal(done.answer, "Записал");
    assert.equal(calls.filter((c) => (c as { kind: string }).kind === "wash").length, 1);
    assert.equal(conversations.get(21), null, "после успешной записи разговор закрыт");
  });
});

describe("Дробный вес и честные 4xx (аудит 18.08)", () => {
  it("«1200,5» текстом сохраняется целым числом — Core с @IsInt его принимает", async () => {
    const { handleCoffeeRefillWeight } = await import("./coffee-refill");
    const conversations = new Conversations();
    const { core, calls } = stubCore();
    const deps = { core, conversations };
    conversations.start(31, "coffee-refill", "weight", {
      locationId: LOC,
      locationName: "American Hospital",
      position: 7,
      containerNumber: 7,
      measuredBefore: null,
    });
    await handleCoffeeRefillWeight(31, "1200,5", deps, ME);
    const refill = calls.find((c) => (c as { kind: string }).kind === "refill") as
      | { input: Record<string, unknown> }
      | undefined;
    assert.ok(refill, "заливка записана");
    assert.ok(Number.isInteger(refill.input.filledWeight), "вес ушёл целым");
    assert.equal(refill.input.filledWeight, 1201);
  });

  it("400 от Core — «ошибка в данных», а не вечное «нажми Готово ещё раз»", async () => {
    const { handleCoffeeRefillWeight } = await import("./coffee-refill");
    const { CoreError } = await import("./core-client");
    const conversations = new Conversations();
    const { core } = stubCore({
      submitCoffeeRefill: async () => {
        throw new CoreError(400, "/coffee/refills", "filledWeight: IsInt");
      },
    });
    const deps = { core, conversations };
    conversations.start(32, "coffee-refill", "weight", {
      locationId: LOC,
      locationName: "American Hospital",
      position: 7,
      containerNumber: 7,
      measuredBefore: null,
    });
    const reply = await handleCoffeeRefillWeight(32, "1600", deps, ME);
    assert.match(reply.text, /ошибка в данных/i);
    assert.doesNotMatch(reply.text, /ещё раз через минуту/, "совет-ловушка вечного ретрая исчез");
  });
});
