import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PersonRow } from "./core-client";
import { handleCoffeeFixCallback, isCoffeeFixTrigger, parseCoffeeFixCallback, startCoffeeFix } from "./coffee-fix";

const ME: PersonRow = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Рустам",
  role: "техник",
  tgUsername: "rustam",
  tgChatId: "555",
  active: "yes",
};

const ENTRY_ID = "22222222-2222-4222-8222-222222222222";

function stubCore(over: Record<string, unknown> = {}) {
  const calls: { kind: string; args: unknown[] }[] = [];
  const core = {
    coffeeLastEntry: async (createdBy: string) => {
      calls.push({ kind: "last", args: [createdBy] });
      return {
        entry: { kind: "refill", id: ENTRY_ID, at: "2026-08-04T09:00:00Z", text: "заливка 2026-08-04 · AH · бункер 7 · 1200г · 2 уп." },
      };
    },
    deleteCoffeeEntry: async (kind: string, id: string, personRef: string) => {
      calls.push({ kind: "delete", args: [kind, id, personRef] });
      return { ok: true };
    },
    ...over,
  } as never;
  return { core, calls };
}

describe("Бот «ошибся — исправить» — отмена своей последней записи", () => {
  it("триггеры: «ошибся»/«исправить» — да, обычный текст и «отмена» визардов — нет", () => {
    assert.ok(isCoffeeFixTrigger("Ошибся"));
    assert.ok(isCoffeeFixTrigger("исправить запись"));
    assert.ok(isCoffeeFixTrigger("удали последнюю"));
    assert.ok(!isCoffeeFixTrigger("задачи"));
    assert.ok(!isCoffeeFixTrigger("отмена"));
  });

  it("старт: показывает последнюю запись автора и кнопки подтверждения", async () => {
    const { core, calls } = stubCore();
    const reply = await startCoffeeFix(ME, { core });
    assert.deepEqual(calls[0], { kind: "last", args: [`person:${ME.id}`] }, "ищем только записи этого сотрудника");
    assert.match(reply.text, /заливка 2026-08-04 · AH/);
    assert.match(reply.text, /сохранится в журнале аудита/i);
    const row = reply.keyboard!.inline_keyboard[0];
    assert.equal(row[0].callback_data, `fx:del:r:${ENTRY_ID}`);
    assert.equal(row[1].callback_data, "fx:keep");
  });

  it("старт: записей нет — честно говорим, кнопок не рисуем", async () => {
    const { core } = stubCore({ coffeeLastEntry: async () => ({ entry: null }) });
    const reply = await startCoffeeFix(ME, { core });
    assert.match(reply.text, /не нашёл/i);
    assert.equal(reply.keyboard, undefined);
  });

  it("разбор кнопки строгий: свои форматы — да, мусор — null", () => {
    assert.deepEqual(parseCoffeeFixCallback(`fx:del:c:${ENTRY_ID}`), { kind: "delete", entry: "container_return", id: ENTRY_ID });
    assert.deepEqual(parseCoffeeFixCallback("fx:keep"), { kind: "keep" });
    assert.equal(parseCoffeeFixCallback("fx:del:x:not-a-uuid"), null);
    assert.equal(parseCoffeeFixCallback("t:123:done"), null);
  });

  it("подтверждение: удаляет через Core от имени сотрудника (actor = только своё)", async () => {
    const { core, calls } = stubCore();
    const res = await handleCoffeeFixCallback({ kind: "delete", entry: "consumable", id: ENTRY_ID }, ME, { core });
    assert.deepEqual(calls[0], { kind: "delete", args: ["consumable", ENTRY_ID, `person:${ME.id}`] });
    assert.equal(res.answer, "Удалено");
    assert.match(res.message!, /внеси правильные данные/i);
  });

  it("отказ Core (чужая/уже удалена) — мягкое сообщение, не падение", async () => {
    const { core } = stubCore({
      deleteCoffeeEntry: async () => {
        throw new Error("Core ответил 400 на /coffee/refill/x");
      },
    });
    const res = await handleCoffeeFixCallback({ kind: "delete", entry: "refill", id: ENTRY_ID }, ME, { core });
    assert.equal(res.answer, "Не получилось");
    assert.match(res.message!, /скажи владельцу/i);
  });

  it("«Оставить» — ничего не удаляем", async () => {
    const { core, calls } = stubCore();
    const res = await handleCoffeeFixCallback({ kind: "keep" }, ME, { core });
    assert.equal(calls.length, 0);
    assert.match(res.answer, /оставил/i);
  });
});
