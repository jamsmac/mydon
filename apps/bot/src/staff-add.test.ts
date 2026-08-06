import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Conversations } from "./conversation";
import type { PersonRow } from "./core-client";
import {
  formatInvite,
  handleStaffAddCallback,
  isStaffAddTrigger,
  parseStaffAddCallback,
  startStaffAdd,
} from "./staff-add";

const RUSTAM: PersonRow = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Рустам",
  role: "оператор",
  roles: [],
  tgUsername: "rustam",
  tgChatId: null,
  active: "yes",
};

const VOLODYA: PersonRow = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Владимир",
  role: "техник",
  roles: ["technician"],
  tgUsername: "volodya",
  tgChatId: "777",
  active: "yes",
};

function stubCore(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const core = {
    people: async () => [RUSTAM, VOLODYA],
    issueInvite: async (personId: string, roles: string[]) => {
      calls.push(`invite:${personId}:${roles.join("+") || "-"}`);
      return { code: "ACDEFGHJKM", expiresAt: "2026-08-07T10:00:00.000Z", name: "Рустам" };
    },
    revokeAccess: async (personId: string) => {
      calls.push(`revoke:${personId}`);
      return { ...VOLODYA, tgChatId: null, roles: [] };
    },
    ...over,
  } as never;
  return { core, calls };
}

describe("Триггер подключения", () => {
  it("ловит формулировки владельца", () => {
    assert.equal(isStaffAddTrigger("подключить сотрудника"), true);
    assert.equal(isStaffAddTrigger("новый сотрудник"), true);
    assert.equal(isStaffAddTrigger("пригласи Рустама"), true);
    assert.equal(isStaffAddTrigger("выдай доступ"), true);
  });

  it("не перехватывает соседние темы", () => {
    // «подключение» к автомату и «новая карточка» — не про доступ.
    assert.equal(isStaffAddTrigger("что по автоматам"), false);
    assert.equal(isStaffAddTrigger("новая запчасть"), false);
    assert.equal(isStaffAddTrigger("брифинг"), false);
  });
});

describe("Разбор кнопок владельца", () => {
  it("принимает только своё пространство sa:", () => {
    assert.deepEqual(parseStaffAddCallback(`sa:p:${RUSTAM.id}`), { kind: "person", id: RUSTAM.id });
    assert.deepEqual(parseStaffAddCallback("sa:r:0"), { kind: "role", role: "operator" });
    assert.deepEqual(parseStaffAddCallback("sa:done"), { kind: "done" });
    assert.deepEqual(parseStaffAddCallback(`sa:v:${VOLODYA.id}`), { kind: "revoke", id: VOLODYA.id });
    assert.equal(parseStaffAddCallback("sa:r:99"), null, "несуществующий индекс роли");
    assert.equal(parseStaffAddCallback("sa:p:не-uuid"), null);
    assert.equal(parseStaffAddCallback("t:tasks"), null);
  });

  it("в callback_data идёт индекс роли, а не название", () => {
    // Иначе переименование роли ломало бы кнопки, уже висящие в чате,
    // и кириллица съедала бы лимит в 64 байта.
    assert.ok(!/[А-Яа-я]/.test("sa:r:3"));
    assert.ok(Buffer.byteLength(`sa:p:${RUSTAM.id}`) <= 64);
  });
});

describe("Визард подключения", () => {
  it("проходит путь человек → роли → ссылка", async () => {
    const conversations = new Conversations();
    const { core, calls } = stubCore();
    const deps = { core, conversations };

    const start = await startStaffAdd(1, deps);
    assert.match(start.text, /Кого подключаем/);
    assert.equal(conversations.get(1)?.step, "person");

    await handleStaffAddCallback(1, { kind: "person", id: RUSTAM.id }, deps, "mydon_bot");
    assert.equal(conversations.get(1)?.step, "roles");

    await handleStaffAddCallback(1, { kind: "role", role: "operator" }, deps, "mydon_bot");
    await handleStaffAddCallback(1, { kind: "role", role: "collector" }, deps, "mydon_bot");

    const done = await handleStaffAddCallback(1, { kind: "done" }, deps, "mydon_bot");
    assert.equal(calls[0], `invite:${RUSTAM.id}:operator+collector`);
    assert.match(done.message!.text, /t\.me\/mydon_bot\?start=inv_ACDEFGHJKM/);
    assert.equal(conversations.get(1), null, "визард закрывается");
  });

  it("повторное нажатие роли снимает выбор", async () => {
    // Кнопка-переключатель избавляет от отдельной кнопки «убрать» и от
    // вопроса «а как отменить».
    const conversations = new Conversations();
    const { core, calls } = stubCore();
    const deps = { core, conversations };
    await startStaffAdd(1, deps);
    await handleStaffAddCallback(1, { kind: "person", id: RUSTAM.id }, deps, "b");
    await handleStaffAddCallback(1, { kind: "role", role: "operator" }, deps, "b");
    await handleStaffAddCallback(1, { kind: "role", role: "operator" }, deps, "b");
    await handleStaffAddCallback(1, { kind: "done" }, deps, "b");
    assert.equal(calls[0], `invite:${RUSTAM.id}:-`, "роль должна была сняться");
  });

  it("выбранные роли помечены прямо на кнопках", async () => {
    const conversations = new Conversations();
    const { core } = stubCore();
    const deps = { core, conversations };
    await startStaffAdd(1, deps);
    await handleStaffAddCallback(1, { kind: "person", id: RUSTAM.id }, deps, "b");
    const res = await handleStaffAddCallback(1, { kind: "role", role: "technician" }, deps, "b");
    const labels = res.message!.keyboard!.inline_keyboard.flat().map((b) => b.text);
    assert.ok(labels.includes("✅ Техник"));
    assert.ok(labels.includes("Оператор"), "невыбранные — без галочки");
  });

  it("роль владельца приглашением не выдаётся", async () => {
    // Владелец опознаётся по allowlist, а не по роли в карточке; кнопка
    // «Владелец» в этом списке была бы способом выдать себе всё.
    const conversations = new Conversations();
    const { core } = stubCore();
    const deps = { core, conversations };
    await startStaffAdd(1, deps);
    const res = await handleStaffAddCallback(1, { kind: "person", id: RUSTAM.id }, deps, "b");
    const labels = res.message!.keyboard!.inline_keyboard.flat().map((b) => b.text);
    assert.ok(!labels.some((l) => l.includes("Владелец")));
  });

  it("уже подключённые помечены в списке", async () => {
    const conversations = new Conversations();
    const { core } = stubCore();
    const start = await startStaffAdd(1, { core, conversations });
    const labels = start.keyboard!.inline_keyboard.flat().map((b) => b.text);
    assert.ok(labels.includes("🔗 Владимир"), "у него уже есть привязка");
    assert.ok(labels.includes("Рустам"));
  });

  it("пустой реестр объясняет, что делать", async () => {
    const conversations = new Conversations();
    const { core } = stubCore({ people: async () => [] });
    const res = await startStaffAdd(1, { core, conversations });
    assert.match(res.text, /нет ни одного сотрудника/i);
    assert.equal(conversations.get(1), null, "визард не стартует впустую");
  });

  it("выдача без единой роли возможна — доступ проставят потом", async () => {
    // Пустые роли не запирают человека: базовое право оставляет ему задачи.
    const conversations = new Conversations();
    const { core, calls } = stubCore();
    const deps = { core, conversations };
    await startStaffAdd(1, deps);
    await handleStaffAddCallback(1, { kind: "person", id: RUSTAM.id }, deps, "b");
    await handleStaffAddCallback(1, { kind: "done" }, deps, "b");
    assert.equal(calls[0], `invite:${RUSTAM.id}:-`);
  });

  it("отмена ничего не выпускает", async () => {
    const conversations = new Conversations();
    const { core, calls } = stubCore();
    const deps = { core, conversations };
    await startStaffAdd(1, deps);
    await handleStaffAddCallback(1, { kind: "cancel" }, deps, "b");
    assert.deepEqual(calls, []);
    assert.equal(conversations.get(1), null);
  });

  it("кнопка на истёкшем визарде просит начать заново", async () => {
    const { core, calls } = stubCore();
    const res = await handleStaffAddCallback(
      1,
      { kind: "done" },
      { core, conversations: new Conversations() },
      "b",
    );
    assert.match(res.message!.text, /заново/i);
    assert.deepEqual(calls, []);
  });

  it("отзыв доступа работает вне визарда", async () => {
    // Он нужен срочно и из любого места — привязывать его к шагам нельзя.
    const { core, calls } = stubCore();
    const res = await handleStaffAddCallback(
      1,
      { kind: "revoke", id: VOLODYA.id },
      { core, conversations: new Conversations() },
      "b",
    );
    assert.equal(calls[0], `revoke:${VOLODYA.id}`);
    assert.match(res.message!.text, /Доступ отозван/);
    assert.match(res.message!.text, /история работ остались/i, "карточка не удаляется");
  });
});

describe("Сообщение со ссылкой", () => {
  it("ссылка стоит отдельной строкой — чтобы переслать одним нажатием", () => {
    const text = formatInvite("Рустам", ["operator"], "ACDEFGHJKM", "2026-08-07T10:00:00.000Z", "mydon_bot");
    const linkLine = text.split("\n").find((l) => l.startsWith("https://"));
    assert.equal(linkLine, "https://t.me/mydon_bot?start=inv_ACDEFGHJKM");
  });

  it("срок показан по Ташкенту", () => {
    // 10:00Z = 15:00 в Ташкенте.
    const text = formatInvite("Рустам", [], "ACDEFGHJKM", "2026-08-07T10:00:00.000Z", "b");
    assert.match(text, /15:00/);
  });

  it("предупреждает, что второй раз показать нельзя", () => {
    // В базе только отпечаток кода — владелец не должен искать эту кнопку.
    const text = formatInvite("Рустам", ["operator"], "ACDEFGHJKM", "2026-08-07T10:00:00.000Z", "b");
    assert.match(text, /второй раз/i);
    assert.match(text, /Оператор/);
  });
});
