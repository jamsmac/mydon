import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { answer, parseIntent, type AssistantCore } from "./index";

// Заглушка Core: возвращает заданное, чтобы проверить именно логику помощника.
function fakeCore(over: Partial<AssistantCore> = {}): AssistantCore {
  return {
    briefing: async () => ({
      overdueMoney: 0,
      idleMachines: 0,
      pendingApprovals: 0,
      contractsDueSoon: 0,
      overdueTasks: 0,
    }),
    pendingApprovals: async () => [],
    obligations: async () => ({ totals: [], overdue: [] }),
    searchEntities: async () => [],
    recent: async () => [],
    ...over,
  };
}

describe("Разбор вопросов", () => {
  it("узнаёт брифинг, согласования, просрочки, автоматы", () => {
    assert.equal(parseIntent("брифинг").kind, "briefing");
    assert.equal(parseIntent("согласования").kind, "approvals");
    assert.equal(parseIntent("что просрочено").kind, "overdue");
    assert.equal(parseIntent("какие автоматы простаивают").kind, "machines");
  });

  it("«что было / что я решал» — это память", () => {
    assert.equal(parseIntent("что было").kind, "recent");
    assert.equal(parseIntent("что я решал").kind, "recent");
    assert.equal(parseIntent("покажи историю").kind, "recent");
  });

  it("«сколько должен Olma» — поиск по имени, а не общая просрочка", () => {
    const i = parseIntent("сколько должен Olma");
    assert.equal(i.kind, "search");
    if (i.kind === "search") assert.match(i.query, /Olma/i);
  });
});

describe("Ответы помощника", () => {
  it("пустой брифинг — «тревог нет»", async () => {
    const r = await answer("брифинг", fakeCore());
    assert.match(r.text, /Тревог нет/);
  });

  it("брифинг с тревогами перечисляет их", async () => {
    const r = await answer(
      "сводка",
      fakeCore({
        briefing: async () => ({
          overdueMoney: 2,
          idleMachines: 1,
          pendingApprovals: 0,
          contractsDueSoon: 0,
          overdueTasks: 0,
        }),
      }),
    );
    assert.match(r.text, /просрочено платежей: 2/);
    assert.match(r.text, /автоматы простаивают: 1/);
  });

  it("согласование возвращает id, чтобы сурфейс привесил кнопки", async () => {
    const r = await answer(
      "согласования",
      fakeCore({
        pendingApprovals: async () => [{ id: "a1", agent: "vendhub-ops", action: "Заказать зёрна", tier: "T3" }],
      }),
    );
    assert.equal(r.approvalId, "a1");
    assert.match(r.text, /Заказать зёрна/);
  });

  it("память показывает последние действия человеко-понятно", async () => {
    const r = await answer(
      "что было",
      fakeCore({
        recent: async () => [
          { actorKind: "human", action: "approval.approved", actorRef: "panel", ts: "2026-07-28T10:00:00Z" },
          { actorKind: "agent", action: "approval.request", actorRef: "vendhub-ops", ts: "2026-07-28T09:00:00Z" },
        ],
      }),
    );
    assert.match(r.text, /ты одобрил/);
    assert.match(r.text, /агент попросил разрешения/);
  });

  it("поиск без результата отвечает понятно", async () => {
    const r = await answer("найди Ромашка", fakeCore());
    assert.match(r.text, /ничего не найдено/);
  });
});
