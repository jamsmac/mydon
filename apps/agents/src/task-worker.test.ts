import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentsCoreClient, AgentTaskInvocation } from "./core-client";
import { clearLlmSkills, registerLlmSkills } from "./llm-skill";
import type { AgentDefinition } from "./registry";
import type { SkillMeta } from "./skill-loader";
import { requiredChatStep, runAgentTasks } from "./task-worker";

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
