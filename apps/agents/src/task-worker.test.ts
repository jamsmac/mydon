import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentsCoreClient, AgentTaskInvocation } from "./core-client";
import { clearLlmSkills, registerLlmSkills } from "./llm-skill";
import type { AgentDefinition } from "./registry";
import type { SkillMeta } from "./skill-loader";
import { requiredChatStep, resolveTaskSkill, runAgentTasks } from "./task-worker";

const agent: AgentDefinition = {
  name: "coach-agent",
  business: "mydon",
  status: "active",
  autonomyDefault: "T0",
  skills: ["coach-review"],
  schedule: [{ cron: "0 10 * * 1", skill: "coach-review" }],
  dir: "(тест)",
};

describe("Agent task queue selection", () => {
  it("scheduled recovery poll requests only scheduled occurrences", async () => {
    const invocations: AgentTaskInvocation[] = [];
    const core = {
      myTasks: async (_agentName: string, invocation: AgentTaskInvocation) => {
        invocations.push(invocation);
        return [];
      },
    } as unknown as AgentsCoreClient;

    assert.deepEqual(
      await runAgentTasks(agent, core, "T0", undefined, { invocation: "scheduled" }),
      [],
    );
    assert.deepEqual(invocations, ["scheduled"]);
  });

  it("owner-assigned queue remains the default", async () => {
    const invocations: AgentTaskInvocation[] = [];
    const core = {
      myTasks: async (_agentName: string, invocation: AgentTaskInvocation) => {
        invocations.push(invocation);
        return [];
      },
    } as unknown as AgentsCoreClient;

    await runAgentTasks(agent, core, "T0");
    assert.deepEqual(invocations, ["assigned"]);
  });
});

describe("requiredChatStep — навыки, которым metered-маршрут обязателен", () => {
  afterEach(() => clearLlmSkills());

  it("find-solution → шаг rank; кодовый навык без модели → null", () => {
    assert.equal(requiredChatStep("find-solution"), "find-solution:rank");
    assert.equal(requiredChatStep("coach-review"), null);
    assert.equal(requiredChatStep("no-such-skill"), null);
  });

  it("llm-навык → ровно его шаг llm-skill:<навык> (R-LS-2), без маршрута задача уйдёт в route_unavailable", () => {
    const meta: SkillMeta = {
      name: "qualify-lead",
      agent: "globerent-sales",
      description: "d",
      allowedTools: [],
      requiresApproval: "T1",
      file: "(тест)",
      executor: "llm",
      triggers: [],
      body: "",
      problems: [],
    };
    registerLlmSkills([meta], { sharedDir: "/nope", agentsDir: "/nope" }, () => false);
    assert.equal(requiredChatStep("qualify-lead"), "llm-skill:qualify-lead");
  });
});

describe("resolveTaskSkill — явный навык побеждает угадывание (R-SD-3)", () => {
  const multi: AgentDefinition = {
    ...agent,
    skills: ["coach-review", "parts-audit", "not-implemented-yet"],
  };
  // «разбор недел…» — подсказка кодового coach-review; так видно, что явный
  // навык действительно ПЕРЕБИЛ угадывание, а не совпал с ним.
  const claim = (agentSkill?: string) => ({
    taskInput: {
      title: "Разбор недели по агентам",
      description: "Посмотри, что получилось",
      ...(agentSkill !== undefined ? { agentSkill } : {}),
    },
  });

  it("без agentSkill — прежнее поведение: подбор по тексту задачи", () => {
    assert.deepEqual(resolveTaskSkill(multi, claim()), { skill: "coach-review" });
  });

  it("agentSkill закреплён за агентом и реализован — берём его", () => {
    assert.deepEqual(resolveTaskSkill(multi, claim("parts-audit")), { skill: "parts-audit" });
  });

  it("явный навык реализован, но карточка-снимок его ещё не знает — всё равно берём (F3)", () => {
    // `agent.skills` перечитывается из Core раз в 10 минут: свежевписанный
    // владельцем навык доедет до worker позже, чем задача по нему. Членство уже
    // проверил Core при создании задачи — вторая проверка по устаревшему снимку
    // отменяла бы явное указание владельца.
    const stale: AgentDefinition = { ...agent, skills: ["coach-review"] };
    assert.deepEqual(resolveTaskSkill(stale, claim("watch-receivables")), {
      skill: "watch-receivables",
    });
  });

  it("нереализованный явный навык → null с причиной, без подбора (Р-6)", () => {
    const res = resolveTaskSkill(multi, claim("not-implemented-yet"));
    assert.equal(res.skill, null, "подбор по тексту не должен подменять явный навык");
    assert.match(res.reason ?? "", /Навык «not-implemented-yet» задан явно, но не реализован/);
    assert.match(res.reason ?? "", /Реализованные навыки: coach-review, parts-audit\./);
  });

  it("у агента вообще нет реализованных навыков — причина говорит «нет»", () => {
    const empty: AgentDefinition = { ...agent, skills: ["not-implemented-yet"] };
    assert.match(
      resolveTaskSkill(empty, claim("not-implemented-yet")).reason ?? "",
      /Реализованные навыки: нет\./,
    );
  });

  it("ни явного, ни подходящего навыка — null без причины (агент честно вернёт задачу)", () => {
    const other: AgentDefinition = { ...agent, skills: ["parts-audit"] };
    assert.deepEqual(resolveTaskSkill(other, { taskInput: { title: "Полей цветы" } }), {
      skill: null,
    });
  });
});
