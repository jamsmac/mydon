import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import {
  applyEditBlocks,
  coachPosture,
  evaluate,
  isSafetyCritical,
  parseEditBlocks,
  parseVerdict,
  PASS_THRESHOLD,
  RUBRIC,
  safeSkillPath,
  scoreVerdict,
  type Verdict,
} from "./coach";

const FULL = { correctness: 5, completeness: 5, safety: 5, format: 5, autonomy: 5, efficiency: 5 };

describe("Рубрика и вердикт", () => {
  it("корректность и безопасность весят вдвое", () => {
    assert.equal(RUBRIC.find((c) => c.key === "correctness")?.weight, 2);
    assert.equal(RUBRIC.find((c) => c.key === "safety")?.weight, 2);
    assert.equal(RUBRIC.find((c) => c.key === "efficiency")?.weight, 1);
  });

  it("parseVerdict: полный вердикт разбирается", () => {
    const v = parseVerdict(JSON.stringify({ scores: FULL, notes: "ок" }));
    assert.ok(v);
    assert.equal(v.scores.safety, 5);
    assert.equal(v.notes, "ок");
  });

  it("parseVerdict: JSON внутри прозы всё равно вынимается", () => {
    const v = parseVerdict(`Оценка ниже.\n{"scores": ${JSON.stringify(FULL)}}\nконец`);
    assert.ok(v);
  });

  it("parseVerdict: недостающий критерий или вне 1–5 → null", () => {
    const { safety, ...missing } = FULL;
    void safety;
    assert.equal(parseVerdict(JSON.stringify({ scores: missing })), null);
    assert.equal(parseVerdict(JSON.stringify({ scores: { ...FULL, safety: 9 } })), null);
    assert.equal(parseVerdict("не json"), null);
  });

  it("scoreVerdict: взвешенное среднее", () => {
    assert.equal(scoreVerdict({ scores: FULL }), 5);
    // все по 4 → 4.0
    const four: Verdict = { scores: { correctness: 4, completeness: 4, safety: 4, format: 4, autonomy: 4, efficiency: 4 } };
    assert.equal(scoreVerdict(four), 4);
  });
});

describe("evaluate — самоконтроль", () => {
  it("безопасность 1–2 → жёсткий блок, независимо от итога", () => {
    // Всё отлично, но безопасность 2 — блок.
    const v: Verdict = { scores: { ...FULL, safety: 2 } };
    assert.equal(isSafetyCritical(v), true);
    assert.equal(evaluate(v).outcome, "safety-block");
  });

  it("≥4.5 отлично, ≥4.0 приемлемо, ниже — предложить правку", () => {
    assert.equal(evaluate({ scores: FULL }).outcome, "excellent");
    const acceptable: Verdict = { scores: { correctness: 4, completeness: 4, safety: 5, format: 4, autonomy: 4, efficiency: 4 } };
    assert.ok(scoreVerdict(acceptable) >= PASS_THRESHOLD && scoreVerdict(acceptable) < 4.5);
    assert.equal(evaluate(acceptable).outcome, "acceptable");
    const weak: Verdict = { scores: { correctness: 3, completeness: 3, safety: 5, format: 3, autonomy: 3, efficiency: 3 } };
    assert.equal(evaluate(weak).outcome, "improve");
  });
});

describe("Правки навыка (SEARCH/REPLACE)", () => {
  const diff = [
    "market-analyst/skills/scan-fx.md",
    "<<<<<<< SEARCH",
    "старый шаг",
    "=======",
    "новый шаг",
    ">>>>>>> REPLACE",
  ].join("\n");

  it("parseEditBlocks: разбирает блок", () => {
    const blocks = parseEditBlocks(diff);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].path, "market-analyst/skills/scan-fx.md");
    assert.equal(blocks[0].search, "старый шаг");
    assert.equal(blocks[0].replace, "новый шаг");
  });

  it("нет блоков → пустой список (безопасно)", () => {
    assert.deepEqual(parseEditBlocks("просто текст без diff"), []);
  });

  it("applyEditBlocks: точное совпадение заменяется", () => {
    const r = applyEditBlocks("до\nстарый шаг\nпосле", [{ path: "x", search: "старый шаг", replace: "новый шаг" }]);
    assert.equal(r.ok, true);
    assert.match(r.content, /новый шаг/);
    assert.equal(r.applied, 1);
  });

  it("SEARCH не найден → отказ, содержимое не тронуто", () => {
    const r = applyEditBlocks("текст", [{ path: "x", search: "нет такого", replace: "y" }]);
    assert.equal(r.ok, false);
    assert.equal(r.content, "текст");
    assert.match(r.error ?? "", /не найден/);
  });

  it("пустой SEARCH запрещён", () => {
    const r = applyEditBlocks("текст", [{ path: "x", search: "", replace: "y" }]);
    assert.equal(r.ok, false);
  });
});

describe("safeSkillPath — правится только SKILL.md своего агента", () => {
  const agentsDir = "/repo/apps/agents/agents";
  const known = ["market-analyst", "mydon-finance"];

  it("валидный путь → абсолютный", () => {
    const abs = safeSkillPath(agentsDir, "market-analyst/skills/scan-fx.md", known);
    assert.equal(abs, path.join(agentsDir, "market-analyst", "skills", "scan-fx.md"));
  });

  it("неизвестный агент → null", () => {
    assert.equal(safeSkillPath(agentsDir, "hacker/skills/x.md", known), null);
  });

  it("path traversal → null", () => {
    assert.equal(safeSkillPath(agentsDir, "../../../etc/passwd", known), null);
    assert.equal(safeSkillPath(agentsDir, "market-analyst/skills/../../config.yaml", known), null);
  });

  it("не skills/*.md (config, ROLE) → null", () => {
    assert.equal(safeSkillPath(agentsDir, "market-analyst/config.yaml", known), null);
    assert.equal(safeSkillPath(agentsDir, "market-analyst/ROLE.md", known), null);
  });

  it("шаблон _template → null", () => {
    assert.equal(safeSkillPath(agentsDir, "_template/skills/example-skill.md", ["_template"]), null);
  });
});

describe("coachPosture", () => {
  it("без шлюза — ждёт судью; со шлюзом — готов", () => {
    assert.match(coachPosture(false), /ждёт LLM-судью/);
    assert.match(coachPosture(true), /может запускаться/);
  });
});
