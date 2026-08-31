import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runCoachReview, type CoachDeps } from "./coach-review";
import { signature } from "./memory";
import type { ModelGateway, ModelRequest } from "./model-gateway";

/** Полный вердикт по рубрике. safety=2 → блок; низкие баллы → improve. */
function verdict(scores: Partial<Record<string, number>>): string {
  const full = {
    correctness: 5,
    completeness: 5,
    safety: 5,
    format: 5,
    autonomy: 5,
    efficiency: 5,
    ...scores,
  };
  return JSON.stringify({ scores: full, notes: "надо конкретнее" });
}

/** Фейковый шлюз: отдаёт ответы по очереди (EVAL, затем PROPOSE). */
function fakeGateway(responses: { text: string; ok?: boolean }[]): {
  gateway: ModelGateway;
  calls: ModelRequest[];
} {
  let i = 0;
  const calls: ModelRequest[] = [];
  const gateway: ModelGateway = {
    provider: "test-local",
    billingMode: "local",
    call: async (model, req) => {
      calls.push(req);
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return { text: r.text, model, costUsd: 0, ok: r.ok ?? true };
    },
  };
  return { gateway, calls };
}

const OPTS = { agentName: "coach-agent", requestKey: "coach-test" } as const;

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
    latestAction: async () => ({
      source: "agent:mydon-finance",
      skill: "watch-receivables",
      action: "разобрать дебиторку",
    }),
    readSkill: () => ({
      content: "инструкция\nстарый шаг\nконец",
      rel: "mydon-finance/skills/watch-receivables.md",
    }),
    selfSource: "agent:coach-agent",
    ...over,
  };
}

describe("runCoachReview — EVAL/PROPOSE", () => {
  it("нет действий → null", async () => {
    const { gateway } = fakeGateway([{ text: "x" }]);
    assert.equal(
      await runCoachReview(gateway, deps({ latestAction: async () => null }), OPTS),
      null,
    );
  });

  it("не судит сам себя", async () => {
    const { gateway, calls } = fakeGateway([{ text: verdict({}) }]);
    const res = await runCoachReview(
      gateway,
      deps({
        latestAction: async () => ({
          source: "agent:coach-agent",
          skill: "coach-review",
          action: "...",
        }),
      }),
      OPTS,
    );
    assert.equal(res, null);
    assert.equal(calls.length, 0, "своё действие — судью не зовём");
  });

  it("вердикт отличный → null (не шумим)", async () => {
    const { gateway, calls } = fakeGateway([{ text: verdict({}) }]);
    assert.equal(await runCoachReview(gateway, deps(), OPTS), null);
    assert.equal(calls.length, 1, "только EVAL, PROPOSE не нужен");
  });

  it("безопасность 1–2 → эскалация, без правки", async () => {
    const { gateway, calls } = fakeGateway([{ text: verdict({ safety: 2 }) }]);
    const res = await runCoachReview(gateway, deps(), OPTS);
    assert.ok(res);
    assert.match(res.action, /критично по безопасности/);
    assert.equal(res.facts.outcome, "safety-block");
    assert.equal(calls.length, 1, "PROPOSE не запускаем на safety-block");
  });

  it("слабо + файл найден → предложение правки SKILL.md (EVAL+PROPOSE)", async () => {
    const { gateway, calls } = fakeGateway([
      { text: verdict({ correctness: 2, completeness: 2, format: 2, efficiency: 2 }) },
      { text: DIFF },
    ]);
    const res = await runCoachReview(gateway, deps(), OPTS);
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
    const { gateway } = fakeGateway([
      { text: verdict({ correctness: 2, completeness: 2, format: 2, autonomy: 2 }) },
    ]);
    const res = await runCoachReview(gateway, deps({ readSkill: () => null }), OPTS);
    assert.ok(res);
    assert.match(res.action, /файл навыка не найден/);
  });

  it("судья не ответил → null (не выдумываем оценку)", async () => {
    const { gateway } = fakeGateway([{ text: "", ok: false }]);
    assert.equal(await runCoachReview(gateway, deps(), OPTS), null);
  });

  it("судья вернул мусор вместо JSON → null", async () => {
    const { gateway } = fakeGateway([{ text: "не смог оценить" }]);
    assert.equal(await runCoachReview(gateway, deps(), OPTS), null);
  });
});

describe("coach-review: дедуп по судимому действию + вердикту, не по сырью LLM (П2)", () => {
  // Один вердикт (одна полоса «improve»), но PROPOSE-правка каждый раз иная —
  // LLM генерит другой SEARCH/REPLACE. diff/scores/notes волатильны.
  const слабыйВердикт = verdict({ correctness: 2, completeness: 2 });

  it("та же слабость того же действия, но иной diff LLM — сигнатура та же", async () => {
    const g1 = fakeGateway([{ text: слабыйВердикт }, { text: `${DIFF}\nвариант правки 1` }]);
    const g2 = fakeGateway([{ text: слабыйВердикт }, { text: `${DIFF}\nсовсем другой вариант 2` }]);
    const p1 = await runCoachReview(g1.gateway, deps(), OPTS);
    const p2 = await runCoachReview(g2.gateway, deps(), OPTS);
    assert.ok(p1 && p2);
    // Отображаемый diff РАЗНЫЙ (владельцу — полный).
    assert.notEqual(p1.facts.diff, p2.facts.diff);
    // Ключ дедупа — стабилен: diff/scores/notes не «плывут» в сигнатуру.
    assert.equal(
      signature(p1.signatureFacts!),
      signature(p2.signatureFacts!),
      "тот же вердикт по тому же действию → та же сигнатура, дубль подавлен",
    );
  });

  it("переход «файл не найден → правка готова» меняет сигнатуру (П2)", async () => {
    // Прогон 1: то же действие слабо, но файл навыка отсутствует → «правку не
    // могу». Прогон 2: то же действие, та же полоса, но файл появился на диске →
    // PROPOSE генерит реальную правку. Без различителя `proposable` обе ветки
    // делили бы ОДИН ключ дедупа → готовая actionable-правка глоталась бы как
    // no_change и не дошла бы до владельца.
    const g1 = fakeGateway([{ text: слабыйВердикт }]);
    const g2 = fakeGateway([{ text: слабыйВердикт }, { text: DIFF }]);
    const noFile = await runCoachReview(g1.gateway, deps({ readSkill: () => null }), OPTS);
    const withFile = await runCoachReview(g2.gateway, deps(), OPTS);
    assert.ok(noFile && withFile);
    assert.match(noFile.action, /файл навыка не найден/);
    assert.match(withFile.action, /предлагает правку навыка/);
    assert.notEqual(
      signature(noFile.signatureFacts!),
      signature(withFile.signatureFacts!),
      "появление файла с готовой правкой обязано менять сигнатуру",
    );
  });

  it("судим ДРУГОЕ действие — содержательное изменение, подаётся заново", async () => {
    const g1 = fakeGateway([{ text: слабыйВердикт }, { text: DIFF }]);
    const g2 = fakeGateway([{ text: слабыйВердикт }, { text: DIFF }]);
    const p1 = await runCoachReview(g1.gateway, deps(), OPTS);
    const p2 = await runCoachReview(
      g2.gateway,
      deps({
        latestAction: async () => ({
          source: "agent:mydon-finance",
          skill: "watch-receivables",
          action: "разобрать СОВСЕМ ДРУГУЮ дебиторку",
        }),
      }),
      OPTS,
    );
    assert.ok(p1 && p2);
    assert.notEqual(
      signature(p1.signatureFacts!),
      signature(p2.signatureFacts!),
      "другое судимое действие обязано менять сигнатуру",
    );
  });
});
