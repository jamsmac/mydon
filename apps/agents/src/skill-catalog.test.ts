import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { catalogFromMetas } from "./skill-catalog";
import type { SkillMeta } from "./skill-loader";

function meta(over: Partial<SkillMeta> = {}): SkillMeta {
  return {
    name: "qualify-lead",
    agent: "globerent-sales",
    description: "Квалификация лида",
    allowedTools: ["read_kb", "write_task"],
    requiresApproval: "T1",
    file: "(тест)",
    executor: "llm",
    triggers: ["квалифиц", "(^|[^а-я])лид"],
    modelEffort: "medium",
    maxTokens: 1200,
    body: "# SKILL\nОцени лид.",
    problems: [],
    ...over,
  };
}

describe("Каталог навыков для Core (R-SD-1)", () => {
  it("llm-навык едет со всеми полями паспорта", () => {
    const [row] = catalogFromMetas([meta()], () => false);
    assert.deepEqual(row, {
      agent: "globerent-sales",
      skill: "qualify-lead",
      description: "Квалификация лида",
      executor: "llm",
      tier: "T1",
      triggers: ["квалифиц", "(^|[^а-я])лид"],
      allowedTools: ["read_kb", "write_task"],
      modelEffort: "medium",
      maxTokens: 1200,
      hasCode: false,
      problems: [],
    });
  });

  it("код-навык помечен hasCode по реестру SKILLS, а не по паспорту", () => {
    const rows = catalogFromMetas(
      [meta({ name: "coach-review", executor: "code" }), meta()],
      (name) => name === "coach-review",
    );
    assert.deepEqual(
      rows.map((r) => [r.skill, r.executor, r.hasCode]),
      [
        ["coach-review", "code", true],
        ["qualify-lead", "llm", false],
      ],
    );
  });

  it("незаданные поля НЕ уезжают ключами: Core проверяет whitelist и режет лишнее", () => {
    const [row] = catalogFromMetas(
      [meta({ requiresApproval: undefined, modelEffort: undefined, maxTokens: undefined })],
      () => false,
    );
    assert.equal(Object.hasOwn(row, "tier"), false);
    assert.equal(Object.hasOwn(row, "modelEffort"), false);
    assert.equal(Object.hasOwn(row, "maxTokens"), false);
    // Ключ, которого нет в DTO Core, завалил бы ВЕСЬ каталог 400-й ошибкой.
    assert.deepEqual(Object.keys(row).sort(), [
      "agent",
      "allowedTools",
      "description",
      "executor",
      "hasCode",
      "problems",
      "skill",
      "triggers",
    ]);
  });

  it("замечания frontmatter едут в каталог: панель показывает их владельцу", () => {
    const [row] = catalogFromMetas([meta({ problems: ["нет тира", "name ≠ имени файла"] })], () => false);
    assert.deepEqual(row.problems, ["нет тира", "name ≠ имени файла"]);
  });
});
