import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withLlmFallback } from "./llm-subscription";
import type { LlmResolution, LlmSnapshot } from "./index";

// Переключение путей: подписка → API. Владелец не должен замечать, что лимит
// подписки кончился, — вопрос молча уходит на запасной путь.

const snapshot: LlmSnapshot = {
  briefing: { overdueMoney: 0, idleMachines: 0, pendingApprovals: 0, contractsDueSoon: 0 },
  pendingApprovals: 0,
  recentLabels: [],
  domains: "globerent, vendhub, personal",
};

describe("Подписка: переключение на запасной путь", () => {
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
