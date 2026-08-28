import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Conversations } from "./conversation";
import { CoreError, type PersonRow, type TaskRow } from "./core-client";
import {
  CONFIRM_CANCEL,
  NO_CONFIRMERS_EVENT,
  confirmKey,
  confirmRecipients,
  formatConfirmRequest,
  handleConfirmCallback,
  handleConfirmRedoReason,
  ownerFallbackKey,
  parseConfirmCallback,
  разослатьПодтверждения,
  startConfirmRedo,
} from "./task-confirm";

const РАБОЧЕЕ = new Date("2026-08-26T10:00:00+05:00");
const НОЧЬ = new Date("2026-08-26T23:40:00+05:00");
const ЗАКРЫЛ = "11111111-1111-4111-8111-111111111111";
const МЕНЕДЖЕР = "22222222-2222-4222-8222-222222222222";
const ЗАДАЧА = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const человек = (over: Partial<PersonRow>): PersonRow =>
  ({ id: "x", name: "Кто-то", role: null, roles: [], tgUsername: null, tgChatId: "1", active: "yes", ...over }) as PersonRow;

const задача = (over: Partial<TaskRow> = {}): TaskRow =>
  ({
    id: ЗАДАЧА,
    title: "Пополнить Olma",
    description: null,
    ownerKind: "human",
    ownerRef: ЗАКРЫЛ,
    status: "done",
    priority: "high",
    due: null,
    resultNote: "Загрузил 40 позиций",
    entityId: null,
    quality: null,
    completedAt: "2026-08-26T09:30:00+05:00",
    closedBy: `person:${ЗАКРЫЛ}`,
    confirmedAt: null,
    confirmedBy: null,
    assignNotifiedAt: "2026-08-25T05:00:00.000Z",
    ...over,
  }) as TaskRow;

describe("Адресаты веера (П7, R-P7-9/R-P7-12)", () => {
  it("роль manager/owner или легаси-владелец, активен, есть чат", () => {
    const people = [
      человек({ id: "a", roles: ["manager"] }),
      человек({ id: "b", role: "владелец" }),
      человек({ id: "c", roles: ["operator"] }),
      человек({ id: "d", roles: ["manager"], active: "no" }),
      человек({ id: "e", roles: ["manager"], tgChatId: null }),
    ];
    assert.deepEqual(confirmRecipients(people).map((person) => person.id), ["a", "b"]);
  });

  it("легаси-строка остаётся источником адресата", () => {
    assert.deepEqual(confirmRecipients([человек({ id: "o", role: "Владелец" })]).map((person) => person.id), ["o"]);
  });

  it("ключ веера — по человеку, запасной ключ — отдельно", () => {
    assert.equal(confirmKey(ЗАДАЧА, МЕНЕДЖЕР), `task-confirm:${ЗАДАЧА}:${МЕНЕДЖЕР}`);
    assert.notEqual(confirmKey(ЗАДАЧА, МЕНЕДЖЕР), confirmKey(ЗАДАЧА, "другой"));
    assert.equal(ownerFallbackKey(ЗАДАЧА), `task-confirm:${ЗАДАЧА}:owner-fallback`);
  });
});

describe("Текст и кнопки «подтвердите»", () => {
  it("печатает заголовок, закрывшего, ташкентский момент и отчёт", () => {
    const reply = formatConfirmRequest(задача(), "Рустам", РАБОЧЕЕ);
    assert.match(reply.text, /🟡 Выполнена: Пополнить Olma/);
    assert.match(reply.text, /Закрыл: Рустам/);
    assert.match(reply.text, /09:30/);
    assert.match(reply.text, /Отчёт: Загрузил 40 позиций/);
    assert.deepEqual(reply.keyboard!.inline_keyboard.flat().map((button) => button.callback_data), [
      `tc:${ЗАДАЧА}:ok`,
      `tc:${ЗАДАЧА}:redo`,
    ]);
  });

  it("отчёта нет — говорит это словами", () => {
    assert.match(formatConfirmRequest(задача({ resultNote: null }), "Рустам", РАБОЧЕЕ).text, /Отчёта нет/);
  });

  it("разбор строгий: чужой префикс, битый uuid и отмена отвергаются", () => {
    assert.deepEqual(parseConfirmCallback(`tc:${ЗАДАЧА}:ok`), { id: ЗАДАЧА, action: "ok" });
    assert.deepEqual(parseConfirmCallback(`tc:${ЗАДАЧА}:redo`), { id: ЗАДАЧА, action: "redo" });
    assert.equal(parseConfirmCallback(`t:${ЗАДАЧА}:done`), null);
    assert.equal(parseConfirmCallback("tc:не-uuid:ok"), null);
    assert.equal(parseConfirmCallback(`tc:${ЗАДАЧА}:delete`), null);
    assert.equal(parseConfirmCallback(CONFIRM_CANCEL), null);
  });
});

describe("Рассылка веера", () => {
  function стенд(opts: { задачи: TaskRow[]; люди: PersonRow[]; занятые?: Set<string> }) {
    const ключи: string[] = [];
    const отправлено: { chat: number; text: string }[] = [];
    const владельцу: string[] = [];
    const события: { type: string; payload: Record<string, unknown> }[] = [];
    const предупреждения: string[] = [];
    const deps = {
      awaitingTasks: async () => opts.задачи,
      people: async () => opts.люди,
      claimNotification: async (key: string) => {
        ключи.push(key);
        return !(opts.занятые?.has(key) ?? false);
      },
      recordEvent: async (type: string, payload: Record<string, unknown>) => { события.push({ type, payload }); },
      send: async (chat: number, text: string) => { отправлено.push({ chat, text }); },
      ownerChats: [999],
      sendOwner: async (chat: number, text: string) => { владельцу.push(`${chat}|${text}`); },
      warn: (message: string) => предупреждения.push(message),
    };
    return { deps, ключи, отправлено, владельцу, события, предупреждения };
  }

  it("закрывший задачу себе запрос приёмки не получает", async () => {
    const st = стенд({
      задачи: [задача({ closedBy: `person:${МЕНЕДЖЕР}` })],
      люди: [
        человек({ id: МЕНЕДЖЕР, roles: ["manager"], tgChatId: "500" }),
        человек({ id: "m2", roles: ["manager"], tgChatId: "501" }),
      ],
    });
    await разослатьПодтверждения(st.deps, РАБОЧЕЕ);
    assert.deepEqual(st.отправлено.map((row) => row.chat), [501]);
  });

  it("ключ занимается до отправки и сбой одного человека не мешает другому", async () => {
    const st = стенд({
      задачи: [задача()],
      люди: [
        человек({ id: "m1", roles: ["manager"], tgChatId: "500" }),
        человек({ id: "m2", roles: ["manager"], tgChatId: "501" }),
      ],
      занятые: new Set([confirmKey(ЗАДАЧА, "m1")]),
    });
    await разослатьПодтверждения(st.deps, РАБОЧЕЕ);
    assert.deepEqual(st.отправлено.map((row) => row.chat), [501]);
    assert.deepEqual(st.ключи, [confirmKey(ЗАДАЧА, "m1"), confirmKey(ЗАДАЧА, "m2")]);
  });

  it("адресатов нет — событие и строка владельцу", async () => {
    const st = стенд({ задачи: [задача()], люди: [человек({ id: "c", roles: ["operator"] })] });
    await разослатьПодтверждения(st.deps, РАБОЧЕЕ);
    assert.deepEqual(st.события.map((entry) => entry.type), [NO_CONFIRMERS_EVENT]);
    assert.equal(st.события[0]!.payload.title, "Пополнить Olma");
    assert.equal(st.владельцу.length, 1);
    assert.equal(st.предупреждения.length, 1);
  });

  it("вне рабочих часов молчит и ключей не тратит", async () => {
    const st = стенд({ задачи: [задача()], люди: [человек({ id: "m1", roles: ["manager"], tgChatId: "500" })] });
    await разослатьПодтверждения(st.deps, НОЧЬ);
    assert.deepEqual(st.отправлено, []);
    assert.deepEqual(st.ключи, []);
  });
});

describe("Возврат в работу с причиной", () => {
  it("пустой ввод не отправляется", async () => {
    const conversations = new Conversations();
    const calls: string[] = [];
    const core = {
      addTaskComment: async () => { calls.push("comment"); },
      rateTask: async () => { calls.push("rate"); },
    } as never;
    startConfirmRedo(1, задача(), { conversations });
    const reply = await handleConfirmRedoReason(1, "   ", человек({ id: МЕНЕДЖЕР }), { conversations, core });
    assert.match(reply.text, /Напиши, что не так/);
    assert.deepEqual(calls, []);
  });

  it("причина уезжает комментарием до установки redo", async () => {
    const conversations = new Conversations();
    const calls: string[] = [];
    const core = {
      addTaskComment: async (id: string, body: string, author: string) => { calls.push(`comment:${id}:${body}:${author}`); },
      rateTask: async (id: string, quality: string, actor: string) => { calls.push(`rate:${id}:${quality}:${actor}`); },
    } as never;
    startConfirmRedo(1, задача(), { conversations });
    const reply = await handleConfirmRedoReason(1, "Слот 12 пустой", человек({ id: МЕНЕДЖЕР }), { conversations, core });
    assert.deepEqual(calls, [
      `comment:${ЗАДАЧА}:Слот 12 пустой:person:${МЕНЕДЖЕР}`,
      `rate:${ЗАДАЧА}:redo:person:${МЕНЕДЖЕР}`,
    ]);
    assert.match(reply.text, /Вернул в работу/);
    assert.equal(conversations.get(1), null);
  });
});

describe("Решение менеджера", () => {
  it("принятие вызывает Core от имени менеджера и готовит спасибо исполнителю", async () => {
    const calls: string[] = [];
    const core = {
      task: async () => задача(),
      confirmTask: async (id: string, actor: string) => { calls.push(`${id}:${actor}`); return задача({ confirmedAt: РАБОЧЕЕ.toISOString() }); },
      people: async () => [человек({ id: ЗАКРЫЛ, tgChatId: "700" })],
    } as never;
    const result = await handleConfirmCallback(500, { id: ЗАДАЧА, action: "ok" }, человек({ id: МЕНЕДЖЕР, roles: ["manager"] }), {
      conversations: new Conversations(), core,
    });
    assert.deepEqual(calls, [`${ЗАДАЧА}:person:${МЕНЕДЖЕР}`]);
    assert.deepEqual(result.recipientNote, { chat: 700, text: "✅ Задача принята: Пополнить Olma. Спасибо!" });
  });

  it("403 объясняет роль, а не выдаётся за временный сбой", async () => {
    const core = {
      task: async () => задача(),
      confirmTask: async () => { throw new CoreError(403, `/tasks/${ЗАДАЧА}/confirm`, ""); },
    } as never;
    const result = await handleConfirmCallback(500, { id: ЗАДАЧА, action: "ok" }, человек({ id: МЕНЕДЖЕР, roles: ["manager"] }), {
      conversations: new Conversations(), core,
    });
    assert.match(result.message!.text, /может менеджер/);
  });
});
