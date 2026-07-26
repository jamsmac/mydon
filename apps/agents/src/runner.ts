import type { AutonomyTier } from "@mydon/shared";
import type { AgentsCoreClient } from "./core-client";
import { explainPolicy, requiresApproval } from "./policy";
import type { AgentDefinition } from "./registry";

export interface RunResult {
  agent: string;
  skill: string;
  outcome: "approval_requested" | "executed" | "skipped";
  approvalId?: string;
  reason: string;
}

/**
 * Прогон одного навыка агента.
 *
 * При текущем пороге (T0 — «всё вручную», ответ владельца Ф6) любой прогон
 * заканчивается запросом на согласование, а не действием. Само исполнение
 * появится, когда владелец поднимет порог.
 */
export async function runSkill(
  agent: AgentDefinition,
  skill: string,
  core: AgentsCoreClient,
  threshold: AutonomyTier,
): Promise<RunResult> {
  if (agent.status !== "active") {
    return {
      agent: agent.name,
      skill,
      outcome: "skipped",
      reason: `агент со статусом "${agent.status}" не запускается`,
    };
  }

  const tier = agent.autonomyDefault;
  await core.recordEvent({
    source: `agent:${agent.name}`,
    type: "agent.run",
    payload: { skill, tier },
  });

  if (requiresApproval(tier, threshold)) {
    const approval = await core.requestApproval({
      agent: agent.name,
      action: `${skill} (${agent.description ?? agent.business})`,
      tier,
      payload: { skill, business: agent.business },
    });
    return {
      agent: agent.name,
      skill,
      outcome: "approval_requested",
      approvalId: approval.id,
      reason: explainPolicy(tier, threshold),
    };
  }

  return {
    agent: agent.name,
    skill,
    outcome: "executed",
    reason: explainPolicy(tier, threshold),
  };
}
