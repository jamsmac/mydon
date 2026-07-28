import type { AutonomyTier } from "@mydon/shared";
import type { AgentsCoreClient } from "./core-client";
import { explainPolicy, requiresApproval } from "./policy";
import type { AgentDefinition } from "./registry";
import { SKILLS } from "./skills";

export interface RunResult {
  agent: string;
  skill: string;
  outcome: "approval_requested" | "executed" | "skipped";
  approvalId?: string;
  reason: string;
}

/**
 * Прогон одного навыка агента (Фаза К3: агенты подключены к Core).
 *
 * Порядок: агент СНАЧАЛА смотрит данные Core, и только если есть предметный
 * повод — выносит предложение владельцу. Нет повода — тишина: пустые
 * согласования приучали бы жать «одобрить» не глядя.
 *
 * При текущем пороге (T0 — «всё вручную», ответ владельца Ф6) предложение
 * всегда идёт через согласование. Исполнение появится, когда владелец
 * поднимет порог.
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

  // Навык ещё не реализован — честно говорим об этом, а не изображаем работу.
  const impl = SKILLS[skill];
  if (impl === undefined) {
    return {
      agent: agent.name,
      skill,
      outcome: "skipped",
      reason: `навык "${skill}" ещё не подключён к данным`,
    };
  }

  const proposal = await impl(agent, core);
  if (proposal === null) {
    return {
      agent: agent.name,
      skill,
      outcome: "skipped",
      reason: "повода нет: по данным Core предлагать нечего",
    };
  }

  if (requiresApproval(tier, threshold)) {
    const approval = await core.requestApproval({
      agent: agent.name,
      action: proposal.action,
      tier,
      // Факты кладём рядом с предложением: по ним проверяется «по следам»,
      // что агент не выдумал повод.
      payload: { skill, business: agent.business, facts: proposal.facts },
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
