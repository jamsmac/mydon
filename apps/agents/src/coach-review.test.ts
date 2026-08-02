import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runCoachReview, type CoachDeps } from "./coach-review";
import type { ModelGateway, ModelRequest } from "./model-gateway";

/** Полный вердикт по рубрике. safety=2 → блок; низкие баллы → improve. */
function verdict(scores: Partial<Record<string, number>>): string {
  const full = { correctness: 5, completeness: 5, safety: 5, format: 5, autonomy: 5, efficiency: 5, ...scores };
  return JSON.stringify({ scores: full, notes: "надо конкретнее" });
}

/** Фейковый шлюз: отдаёт ответы по очереди (EVAL, затем PROPOSE). */
function fakeGateway(responses: { text: string; ok?: boolean }[]): { gateway: ModelGateway; calls: ModelRequest[] } {
  let i = 0;
  const calls: ModelRequest[] = [];
  const gateway: ModelGateway = {
    call: async (model, req) => {
      calls.push(req);
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return { text: r.text, model, costUsd: 0, ok: r.ok ?? true };
    },
  };
  return { gateway, calls };
}

const DIFF = [
  "mydon-finance/skills/watch-receivables.md",
  "<<<<<<< SEARCH",
  "старый шаг",
  "=======",
  "новый шаг",
  ">>>>>>> REPLACE",
].join("\n");

function deps(over: Partial<CoachDeps> = {}): CoachDeps {
  return {
    latestAction: async () => ({ source: "agent:mydon-finance", skill: "watch-receivables", action: "разобрать дебиторку" }),
    readSkill: () => ({ content: "инструкция\nстарый шаг\nконец", rel: "mydon-finance/skills/watch-receivables.md" }),
    selfSource: "agent:coach-agent",
    ...over,
  };
}

describe("runCoachReview — EVAL/PROPOSE", () => {
  it("нет действий → null", async () => {
    const { gateway } = fakeGateway([{ text: "x" }]);
    assert.equal(await runCoachReview(gateway, deps({ latestAction: async () => null })), null);
  });

  it("не судит сам себя", async () => {
    const { gateway, calls } = fakeGateway([{ text: verdict({}) }]);
    const res = await runCoachReview(gateway, deps({ latestAction: async () => ({ source: "agent:coach-agent", skill: "coach-review", action: "..." }) }));
    assert.equal(res, null);
    assert.equal(calls.length, 0, "своё действие — судью не зовём");
  });

  it("вердикт отличный → null (не шумим)", async () => {
    const { gateway, calls } = fakeGateway([{ text: verdict({}) }]);
    assert.equal(await runCoachReview(gateway, deps()), null);
    assert.equal(calls.length, 1, "только EVAL, PROPOSE не нужен");
  });

  it("безопасность 1–2 → эскалация, без правки", async () => {
    const { gateway, calls } = fakeGateway([{ text: verdict({ safety: 2 }) }]);
    const res = await runCoachReview(gateway, deps());
    assert.ok(res);
    assert.match(res.action, /критично по безопасности/);
    assert.equal(res.facts.outcome, "safety-block");
    assert.equal(calls.length, 1, "PROPOSE не запускаем на safety-block");
  });

  it("слабо + файл найден → предложение правки SKILL.md (EVAL+PROPOSE)", async () => {
    const { gateway, calls } = fakeGateway([{ text: verdict({ correctness: 2, completeness: 2, format: 2, efficiency: 2 }) }, { text: DIFF }]);
    const res = await runCoachReview(gateway, deps());
    assert.ok(res);
    assert.match(res.action, /предлагает правку навыка/);
    assert.match(String(res.facts.diff), /SEARCH/);
    assert.equal(res.facts.blocks, 1);
    assert.equal(calls.length, 2, "EVAL, затем PROPOSE");
    // Оцениваемое действие и текст навыка — как обёрнутый недоверенный контент.
    assert.match(calls[0].prompt, /Навык: watch-receivables/);
    assert.match(calls[1].prompt ?? "", /SKILL\.md/);
  });

  it("слабо, но файл навыка не найден → сообщаем, правку не выдумываем", async () => {
    const { gateway } = fakeGateway([{ text: verdict({ correctness: 2, completeness: 2, format: 2, autonomy: 2 }) }]);
    const res = await runCoachReview(gateway, deps({ readSkill: () => null }));
    assert.ok(res);
    assert.match(res.action, /файл навыка не найден/);
  });

  it("судья не ответил → null (не выдумываем оценку)", async () => {
    const { gateway } = fakeGateway([{ text: "", ok: false }]);
    assert.equal(await runCoachReview(gateway, deps()), null);
  });

  it("судья вернул мусор вместо JSON → null", async () => {
    const { gateway } = fakeGateway([{ text: "не смог оценить" }]);
    assert.equal(await runCoachReview(gateway, deps()), null);
  });
});
