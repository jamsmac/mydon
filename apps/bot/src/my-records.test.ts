import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  askCancel,
  handleMyRecordsCallback,
  isMyRecordsTrigger,
  parseMyRecordsCallback,
  parseMyRecordsSelection,
  startMyRecords,
} from "./my-records";

const PERSON = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Т",
  role: null,
  roles: [],
  tgUsername: null,
  tgChatId: "1",
  active: "1",
} as never;
const RECORD_ID = "22222222-2222-4222-8222-222222222222";

describe("Триггер и разбор callback", () => {
  it("«мои записи» ловится, «мои задачи» — нет", () => {
    assert.equal(isMyRecordsTrigger("мои записи"), true);
    assert.equal(isMyRecordsTrigger("Мои Записи"), true);
    assert.equal(isMyRecordsTrigger("мои задачи"), false);
  });

  it("callback_data чужого формата отвергнут разбором", () => {
    assert.equal(parseMyRecordsCallback("mr:c:x:00000000-0000-4000-8000-000000000000"), null);
    assert.equal(
      parseMyRecordsCallback("fx:del:r:00000000-0000-4000-8000-000000000000"),
      null,
      "чужой префикс — не наш формат",
    );
    assert.equal(parseMyRecordsCallback(`mr:c:r:${RECORD_ID}:extra`), null);
    assert.deepEqual(parseMyRecordsCallback(`mr:c:s:${RECORD_ID}`), {
      kind: "cancel",
      entry: "stock_count",
      id: RECORD_ID,
    });
  });

  it("выбор и подтверждение — разные callback-пространства", () => {
    assert.deepEqual(parseMyRecordsSelection(`mr:a:r:${RECORD_ID}`), {
      kind: "cancel",
      entry: "refill",
      id: RECORD_ID,
    });
    assert.equal(parseMyRecordsCallback(`mr:a:r:${RECORD_ID}`), null);
    assert.equal(parseMyRecordsSelection(`mr:c:r:${RECORD_ID}`), null);
  });
});

describe("Экран и подтверждение", () => {
  it("список не длиннее 15 и каждая строка выбирается отдельной кнопкой", async () => {
    const rows = Array.from({ length: 18 }, (_, index) => ({
      kind: "refill" as const,
      id: `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
      createdAt: new Date(Date.now() - index * 1000).toISOString(),
      label: `🍫 Заправка ${index}`,
    }));
    const core = { myRecords: async () => rows } as never;
    const reply = await startMyRecords(PERSON, { core });
    const buttons = reply.keyboard?.inline_keyboard ?? [];
    assert.equal(buttons.length, 15);
    assert.match(buttons[0]![0]!.callback_data, /^mr:a:r:/);
    assert.doesNotMatch(reply.text, /Заправка 15/);
  });

  it("пустой список — третье состояние, а не «всё хорошо»", async () => {
    const core = { myRecords: async () => [] } as never;
    const reply = await startMyRecords(PERSON, { core });
    assert.match(reply.text, /записей пока нет/i);
  });

  it("подтверждение показывает одну выбранную запись и две кнопки в разных рядах", async () => {
    const core = {
      myRecords: async () => [{
        kind: "refill",
        id: RECORD_ID,
        createdAt: new Date().toISOString(),
        label: "🍫 Заправка автомата Olma: Snickers ×6",
      }],
    } as never;
    const reply = await askCancel({ kind: "cancel", entry: "refill", id: RECORD_ID }, PERSON, { core });
    assert.match(reply.text, /Snickers ×6/);
    const rows = reply.keyboard?.inline_keyboard ?? [];
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.length, 1);
    assert.equal(rows[1]!.length, 1);
    assert.match(rows[0]![0]!.callback_data, /^mr:c:r:/);
    assert.equal(rows[1]![0]!.callback_data, "mr:keep");
  });
});

describe("Результаты сторно", () => {
  it("отказ «старше N часов» называет число из ответа Core, а не константу", async () => {
    const core = {
      cancelVendingRecord: async () => {
        throw Object.assign(new Error(), { status: 403, body: { reason: "too_old", hours: 36 } });
      },
    } as never;
    const res = await handleMyRecordsCallback({ kind: "cancel", entry: "refill", id: RECORD_ID }, PERSON, { core });
    assert.match(res.message ?? "", /36/);
  });

  it("чужая запись получает отдельный человеческий отказ", async () => {
    const core = {
      cancelVendingRecord: async () => {
        throw Object.assign(new Error(), { status: 403, body: { reason: "not_yours" } });
      },
    } as never;
    const res = await handleMyRecordsCallback({ kind: "cancel", entry: "cash", id: RECORD_ID }, PERSON, { core });
    assert.match(res.message ?? "", /только свои/i);
  });

  it("успешная отмена пересчёта предупреждает про остаток склада", async () => {
    const core = {
      cancelVendingRecord: async () => ({
        ok: true,
        kind: "stock_count",
        stornoId: "s1",
        label: "…",
        alreadyCancelled: false,
      }),
    } as never;
    const res = await handleMyRecordsCallback(
      { kind: "cancel", entry: "stock_count", id: RECORD_ID },
      PERSON,
      { core },
    );
    assert.match(res.message ?? "", /остаток склада/i);
  });

  it("повторная отмена не выдаётся за новую", async () => {
    const core = {
      cancelVendingRecord: async () => ({
        ok: true,
        kind: "cash",
        stornoId: "s1",
        label: "…",
        alreadyCancelled: true,
      }),
    } as never;
    const res = await handleMyRecordsCallback({ kind: "cancel", entry: "cash", id: RECORD_ID }, PERSON, { core });
    assert.match(res.message ?? "", /уже отменена/i);
  });
});
