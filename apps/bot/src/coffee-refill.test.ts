import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Conversations } from "./conversation";
import type { PersonRow } from "./core-client";
import {
  handleCoffeeRefillCallback,
  handleCoffeeRefillContainer,
  handleCoffeeRefillPackages,
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
    coffeeLocations: async () => [{ id: LOC, name: "American Hospital", isActive: true }],
    coffeeBunkerConfig: async () => [
      { position: 1, ingredientId: "ing-1", ingredientName: "Сухое молоко" },
      { position: 7, ingredientId: "ing-2", ingredientName: "Кофе" },
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

describe("Заливка бункера: полный визард (точка → позиция → вес → упаковки → набор)", () => {
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

    const afterWeight = await handleCoffeeRefillWeight(1, "1200", deps);
    assert.match(afterWeight.text, /упаковок/);

    const afterPackages = await handleCoffeeRefillPackages(1, "2", deps);
    assert.match(afterPackages.text, /набор/i);

    const afterContainer = await handleCoffeeRefillContainer(1, "7", ME, deps);
    assert.match(afterContainer.text, /✅ Записал/);
    assert.match(afterContainer.text, /American Hospital/);
    assert.match(afterContainer.text, /1200г/);
    assert.match(afterContainer.text, /2 уп/);
    assert.match(afterContainer.text, /набор 7/);

    assert.equal(calls.length, 1);
    const refillCall = calls[0] as { kind: string; input: Record<string, unknown> };
    assert.equal(refillCall.kind, "refill");
    assert.equal(refillCall.input.locationId, LOC);
    assert.equal(refillCall.input.position, 7);
    assert.equal(refillCall.input.filledWeight, 1200);
    assert.equal(refillCall.input.packageCount, 2);
    assert.equal(refillCall.input.containerNumber, 7);
    assert.equal(refillCall.input.createdBy, `person:${ME.id}`);
    assert.match(String(refillCall.input.enteredDate), /^\d{4}-\d{2}-\d{2}$/);

    // Визард завершён — повторный текстовый ввод больше не перехватывается им.
    assert.equal(conversations.get(1), null);
  });

  it("«-» на упаковках и наборе — упаковки=1, набор не передаётся", async () => {
    const { core, calls } = stubCore();
    const conversations = new Conversations();
    const deps = { core, conversations };

    await startCoffeeRefill(1, deps);
    await handleCoffeeRefillCallback(1, { kind: "location", id: LOC }, ME, deps);
    await handleCoffeeRefillCallback(1, { kind: "position", position: 1 }, ME, deps);
    await handleCoffeeRefillWeight(1, "600", deps);
    await handleCoffeeRefillPackages(1, "-", deps);
    const done = await handleCoffeeRefillContainer(1, "-", ME, deps);

    assert.doesNotMatch(done.text, /набор/i);
    const refillCall = calls[0] as { kind: string; input: Record<string, unknown> };
    assert.equal(refillCall.input.packageCount, 1);
    assert.ok(!("containerNumber" in refillCall.input));
  });

  it("мусор вместо веса — переспрашивает, не продвигает шаг", async () => {
    const { core } = stubCore();
    const conversations = new Conversations();
    const deps = { core, conversations };
    await startCoffeeRefill(1, deps);
    await handleCoffeeRefillCallback(1, { kind: "location", id: LOC }, ME, deps);
    await handleCoffeeRefillCallback(1, { kind: "position", position: 1 }, ME, deps);
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
    await handleCoffeeRefillWeight(1, "600", deps);
    await handleCoffeeRefillPackages(1, "1", deps);
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

describe("Заливка кнопками: цифровая клавиатура", () => {
  /** Пройти мастер до шага веса — общее начало для проверок набора. */
  async function toWeightStep() {
    const { core, calls } = stubCore();
    const conversations = new Conversations();
    const deps = { core, conversations } as never;
    await startCoffeeRefill(1, deps);
    await handleCoffeeRefillCallback(1, { kind: "location", id: LOC }, ME, deps);
    const r = await handleCoffeeRefillCallback(1, { kind: "position", position: 1 }, ME, deps);
    return { deps, conversations, calls, weightScreen: r };
  }

  /** Нажать подряд несколько кнопок клавиатуры. */
  async function type(deps: never, digits: string) {
    let last;
    for (const d of digits) {
      last = await handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "digit", digit: d } }, ME, deps);
    }
    return last;
  }

  it("после выбора бункера сразу даёт клавиатуру, а не просит писать текстом", async () => {
    const { weightScreen } = await toWeightStep();
    const kb = JSON.stringify(weightScreen.message?.keyboard);
    assert.ok(kb.includes("cf:n:1"), "цифры на месте");
    assert.ok(kb.includes("cf:n:ok"), "«готово» на месте");
    assert.ok(!kb.includes("cf:n:skip"), "вес пропустить нельзя");
  });

  it("набор перерисовывает то же сообщение, а не шлёт новое на каждую цифру", async () => {
    const { deps } = await toWeightStep();
    const r = await type(deps, "1234");
    assert.ok(r?.edit, "перерисовка");
    assert.equal(r?.message, undefined, "нового сообщения нет");
    assert.ok(r?.edit?.text.includes("1234 г"));
  });

  it("«⌫» стирает по цифре, на пустом наборе не пытается перерисовать тем же текстом", async () => {
    const { deps } = await toWeightStep();
    await type(deps, "12");
    const back = await handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "erase" } }, ME, deps);
    assert.ok(back.edit?.text.includes("Набрано: 1"));
    await handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "erase" } }, ME, deps);
    const empty = await handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "erase" } }, ME, deps);
    assert.equal(empty.edit, undefined, "Telegram отвергает правку тем же текстом — не шлём её");
  });

  it("«готово» на пустом весе не пропускает дальше: молча потерянный вес хуже вопроса", async () => {
    const { deps, conversations } = await toWeightStep();
    const r = await handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "done" } }, ME, deps);
    assert.equal(r.edit, undefined);
    assert.equal(conversations.get(1)?.step, "weight", "остались на шаге веса");
  });

  it("весь мастер кнопками пишет ту же запись, что и текстом", async () => {
    const { deps, calls } = await toWeightStep();
    await type(deps, "1234");
    await handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "done" } }, ME, deps);
    await type(deps, "2");
    await handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "done" } }, ME, deps);
    await type(deps, "27");
    const fin = await handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "done" } }, ME, deps);

    const call = calls[0] as { kind: string; input: Record<string, unknown> };
    assert.equal(call.kind, "refill");
    assert.equal(call.input.filledWeight, 1234);
    assert.equal(call.input.packageCount, 2);
    assert.equal(call.input.containerNumber, 27);
    assert.equal(call.input.createdBy, `person:${ME.id}`);
    assert.ok(fin.edit?.text.startsWith("✅ Записал"));
  });

  it("«пропустить» на наборе сохраняет заливку без номера контейнера", async () => {
    const { deps, calls } = await toWeightStep();
    await type(deps, "900");
    await handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "done" } }, ME, deps);
    await handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "skip" } }, ME, deps);
    await handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "skip" } }, ME, deps);

    const call = calls[0] as { input: Record<string, unknown> };
    assert.equal(call.input.filledWeight, 900);
    assert.equal(call.input.packageCount, 1, "пропуск упаковок = одна");
    assert.equal(call.input.containerNumber, undefined);
  });

  it("набор вне 1–27 не проходит — то же правило, что у текстового ввода", async () => {
    const { deps, calls } = await toWeightStep();
    await type(deps, "900");
    await handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "done" } }, ME, deps);
    await handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "skip" } }, ME, deps);
    await type(deps, "99");
    const r = await handleCoffeeRefillCallback(1, { kind: "num", press: { kind: "done" } }, ME, deps);
    assert.equal(r.edit, undefined, "не сохранили");
    assert.equal(calls.length, 0);
  });

  it("текстовый ввод продолжает работать и ведёт на клавиатуру следующего шага", async () => {
    const { deps, calls } = await toWeightStep();
    const afterWeight = await handleCoffeeRefillWeight(1, "1500", deps);
    assert.ok(JSON.stringify(afterWeight.keyboard).includes("cf:n:skip"), "упаковки можно пропустить");
    const afterPkg = await handleCoffeeRefillPackages(1, "-", deps);
    assert.ok(JSON.stringify(afterPkg.keyboard).includes("cf:n:"), "на наборе тоже клавиатура");
    await handleCoffeeRefillContainer(1, "5", ME, deps);
    const call = calls[0] as { input: Record<string, unknown> };
    assert.equal(call.input.filledWeight, 1500);
    assert.equal(call.input.containerNumber, 5);
  });
});
