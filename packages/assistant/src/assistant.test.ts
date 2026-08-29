import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LlmBudgetDeniedError, LlmReplayBlockedError, type LlmCallContext } from "@mydon/shared";
import {
  answer,
  parseIntent,
  type AssistantCore,
  type LlmResolver,
  type LlmSnapshot,
} from "./index";

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

  it("«что заказать / закуп» — сводка к закупу, но «закуп в excel» — файл", () => {
    assert.equal(parseIntent("что заказать").kind, "purchase");
    assert.equal(parseIntent("закуп").kind, "purchase");
    assert.equal(parseIntent("что докупить").kind, "purchase");
    // Файловое правило выше по приоритету: с «excel» это отчёт, а не сводка.
    assert.equal(parseIntent("выгрузи закуп в excel").kind, "report");
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
        pendingApprovals: async () => [
          { id: "a1", agent: "vendhub-ops", action: "Заказать зёрна", tier: "T3" },
        ],
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
          {
            actorKind: "human",
            action: "approval.approved",
            actorRef: "panel",
            ts: "2026-07-28T10:00:00Z",
          },
          {
            actorKind: "agent",
            action: "approval.request",
            actorRef: "vendhub-ops",
            ts: "2026-07-28T09:00:00Z",
          },
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

describe("LLM-слой: вопросы вне готовых правил", () => {
  const question = "во сколько мне сегодня выходить чтобы успеть";

  it("без резолвера непонятый вопрос — это подсказка (прежнее поведение)", async () => {
    const r = await answer(question, fakeCore());
    assert.match(r.text, /Что умею/);
  });

  it("резолвер может ответить словами — отдаём его текст", async () => {
    const llm: LlmResolver = async () => ({
      kind: "answer",
      text: "Тревог нет, можешь не спешить.",
    });
    const r = await answer(question, fakeCore(), { llm });
    assert.match(r.text, /можешь не спешить/);
  });

  it("резолвер может распознать намерение — Core собирает честный ответ", async () => {
    // LLM понял «непонятный» вопрос как «автоматы простаивают».
    const llm: LlmResolver = async () => ({ kind: "intent", intent: { kind: "machines" } });
    const r = await answer(
      question,
      fakeCore({
        briefing: async () => ({
          overdueMoney: 0,
          idleMachines: 3,
          pendingApprovals: 0,
          contractsDueSoon: 0,
          overdueTasks: 0,
        }),
      }),
      { llm },
    );
    assert.match(r.text, /Простаивают автоматы: 3/);
  });

  it("резолвер получает снимок с фактами для заземления", async () => {
    const seen: LlmSnapshot[] = [];
    const llm: LlmResolver = async (_q, snapshot) => {
      seen.push(snapshot);
      return { kind: "answer", text: "ок" };
    };
    await answer(
      question,
      fakeCore({
        briefing: async () => ({
          overdueMoney: 5,
          idleMachines: 1,
          pendingApprovals: 0,
          contractsDueSoon: 2,
          overdueTasks: 0,
        }),
        pendingApprovals: async () => [{ id: "a1", agent: "x", action: "y", tier: "T3" }],
        recent: async () => [
          {
            actorKind: "human",
            action: "approval.approved",
            actorRef: "panel",
            ts: "2026-07-28T10:00:00Z",
          },
        ],
      }),
      { llm },
    );
    assert.equal(seen.length, 1, "снимок должен дойти до резолвера");
    const s = seen[0]!;
    assert.equal(s.briefing.overdueMoney, 5);
    assert.equal(s.pendingApprovals, 1);
    assert.deepEqual(s.recentLabels, ["ты одобрил"]);
    assert.match(s.domains, /vendhub/);
  });

  it("идемпотентный context сурфейса доходит до резолвера", async () => {
    let seen: LlmCallContext | undefined;
    const llmContext: LlmCallContext = {
      requestKey: "telegram:update:42",
      traceKey: "telegram:update:42",
    };
    const llm: LlmResolver = async (_q, _snapshot, context) => {
      seen = context;
      return { kind: "answer", text: "ок" };
    };

    await answer(question, fakeCore(), { llm, llmContext });
    assert.equal(seen, llmContext);
  });

  it("ledger-отказ назван честно, а не маскируется подсказкой", async () => {
    const llm: LlmResolver = async () => {
      throw new LlmBudgetDeniedError("pause", "дневной лимит исчерпан", {
        day: "2026-08-29",
        globalCapUsd: 5,
        globalExposureUsd: 5,
        remainingUsd: 0,
      });
    };

    const r = await answer(question, fakeCore(), { llm });
    assert.match(r.text, /ИИ-запрос не выполнен/);
    assert.match(r.text, /лимит исчерпан/);
  });

  it("закрытый replay просит новый запрос и не маскируется общей подсказкой", async () => {
    const llm: LlmResolver = async () => {
      throw new LlmReplayBlockedError("telegram:update:42:anthropic-api");
    };

    const r = await answer(question, fakeCore(), { llm });
    assert.match(r.text, /уже был принят/);
    assert.match(r.text, /новый запрос/);
  });

  it("падение резолвера не роняет помощника — откат к подсказке", async () => {
    const llm: LlmResolver = async () => {
      throw new Error("нет ключа");
    };
    const r = await answer(question, fakeCore(), { llm });
    assert.match(r.text, /Что умею/);
  });

  it("none от резолвера — честная подсказка, ничего не выдумываем", async () => {
    const llm: LlmResolver = async () => ({ kind: "none" });
    const r = await answer(question, fakeCore(), { llm });
    assert.match(r.text, /Что умею/);
  });
});
