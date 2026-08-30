import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentsCoreClient, AgentTaskInvocation } from "./core-client";
import type { AgentDefinition } from "./registry";
import { runAgentTasks } from "./task-worker";

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
