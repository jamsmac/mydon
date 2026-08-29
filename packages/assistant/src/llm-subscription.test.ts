import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LlmBudgetDeniedError, type LlmBudgetSnapshot } from "@mydon/shared";
import {
  createGatedSubscriptionPrompt,
  createSubscriptionResolver,
  withLlmFallback,
} from "./llm-subscription";
import type { LlmResolution, LlmSnapshot } from "./index";

// Переключение путей: подписка → API. Владелец не должен замечать, что лимит
// подписки кончился, — вопрос молча уходит на запасной путь.

const snapshot: LlmSnapshot = {
  briefing: { overdueMoney: 0, idleMachines: 0, pendingApprovals: 0, contractsDueSoon: 0 },
  pendingApprovals: 0,
  recentLabels: [],
  domains: "globerent, vendhub, personal",
};
const budget: LlmBudgetSnapshot = {
  day: "2026-08-29",
  globalCapUsd: 5,
  globalExposureUsd: 5,
  remainingUsd: 0,
};

describe("Подписка: переключение на запасной путь", () => {
  it("gated prompt даёт non-query init, но не real prompt до auth allow/reject", async () => {
    const allowed = createGatedSubscriptionPrompt("секретный вопрос");
    const allowedIterator = allowed.prompt[Symbol.asyncIterator]();
    const bootstrap = await allowedIterator.next();
    assert.equal(bootstrap.done, false);
    assert.equal(bootstrap.value.shouldQuery, false);
    assert.notEqual(bootstrap.value.message.content as string, "секретный вопрос");
    let allowedSettled = false;
    const pending = allowedIterator.next().finally(() => {
      allowedSettled = true;
    });
    await Promise.resolve();
    assert.equal(allowedSettled, false, "prompt ждёт accountInfo");
    allowed.allow();
    const yielded = await pending;
    assert.equal(yielded.done, false);
    assert.equal(yielded.value.shouldQuery, true);
    assert.deepEqual(yielded.value.message, {
      role: "user",
      content: "секретный вопрос",
    });

    const denied = createGatedSubscriptionPrompt("не должен уйти");
    const deniedIterator = denied.prompt[Symbol.asyncIterator]();
    assert.equal((await deniedIterator.next()).value.shouldQuery, false);
    const deniedNext = deniedIterator.next();
    denied.deny(new Error("auth rejected"));
    await assert.rejects(() => deniedNext, /auth rejected/);
  });

  it("без явного OAuth падает до dynamic import/query SDK", () => {
    const saved = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    try {
      assert.throws(() => createSubscriptionResolver(), /CLAUDE_CODE_OAUTH_TOKEN.*обязателен/);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved;
    }
  });

  it("основной ответил — запасной не трогаем (и не тратим)", async () => {
    let backupCalled = false;
    const llm = withLlmFallback(
      async () => ({ kind: "answer", text: "от подписки" }),
      async () => {
        backupCalled = true;
        return { kind: "answer", text: "от API" };
      },
    );
    const res = await llm("вопрос", snapshot);
    assert.deepEqual(res, { kind: "answer", text: "от подписки" });
    assert.equal(backupCalled, false);
  });

  it("основной упал (кончился лимит) — отвечает запасной", async () => {
    const llm = withLlmFallback(
      async () => {
        throw new Error("rate_limit");
      },
      async () => ({ kind: "answer", text: "от API" }),
    );
    const res = await llm("вопрос", snapshot);
    assert.deepEqual(res, { kind: "answer", text: "от API" });
  });

  it("упали оба — ошибка уходит наверх, answer() даст подсказку", async () => {
    const llm = withLlmFallback(
      async () => {
        throw new Error("лимит");
      },
      async () => {
        throw new Error("нет сети");
      },
    );
    await assert.rejects(() => llm("вопрос", snapshot), /нет сети/);
  });

  it("ledger-отказ терминальный — платный backup не запускаем", async () => {
    let backupCalled = false;
    const denied = new LlmBudgetDeniedError("pause", "дневной лимит исчерпан", budget);
    const llm = withLlmFallback(
      async () => {
        throw denied;
      },
      async () => {
        backupCalled = true;
        return { kind: "answer", text: "платный API" };
      },
    );

    await assert.rejects(() => llm("вопрос", snapshot), LlmBudgetDeniedError);
    assert.equal(backupCalled, false);
  });

  it("вопрос и снимок доходят до основного пути без изменений", async () => {
    const seen: { q: string; s: LlmSnapshot }[] = [];
    const llm = withLlmFallback(
      async (q, s): Promise<LlmResolution> => {
        seen.push({ q, s });
        return { kind: "none" };
      },
      async () => ({ kind: "none" }),
    );
    await llm("что по долгам?", snapshot);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].q, "что по долгам?");
    assert.equal(seen[0].s, snapshot);
  });
});
