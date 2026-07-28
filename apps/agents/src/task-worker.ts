import type { AutonomyTier } from "@mydon/shared";
import type { AgentsCoreClient } from "./core-client";
import type { AgentDefinition } from "./registry";
import { runSkill } from "./runner";
import { hasSkill, SKILLS } from "./skills";

/**
 * Задачи, поручённые агенту (решение владельца: «агент берёт и делает»).
 *
 * Владелец ставит задачу агенту так же, как человеку. Агент берёт её в работу,
 * пробует выполнить своим навыком и ОТЧИТЫВАЕТСЯ результатом — как сотрудник.
 *
 * Если подходящего навыка нет, агент честно пишет «не умею» и возвращает задачу
 * владельцу, а не изображает работу и не закрывает её молча.
 */

export interface TaskRunResult {
  taskId: string;
  outcome: "done" | "returned" | "proposed" | "skipped";
  note: string;
}

/** По заголовку задачи ищем навык агента, который её закрывает. */
export function matchSkill(agent: AgentDefinition, title: string): string | null {
  const text = title.toLowerCase();
  // Прямое упоминание навыка в тексте — самый надёжный признак.
  for (const skill of agent.skills) {
    if (text.includes(skill.toLowerCase()) && hasSkill(skill)) return skill;
  }
  // Иначе — по смыслу: слова задачи против того, что навык умеет.
  const HINTS: Record<string, RegExp> = {
    "watch-receivables": /дебитор|долг|просроч|платеж|оплат/,
    "monitor-stock": /остат|автомат|пополн|простаив|запас/,
    "morning-digest": /сводк|дайджест|обзор|что нового|как дела/,
  };
  for (const skill of agent.skills) {
    const re = HINTS[skill];
    if (re && re.test(text) && hasSkill(skill)) return skill;
  }
  return null;
}

/**
 * Прогон задач одного агента.
 *
 * Порядок важен: сначала берём в работу (владелец видит, что агент занялся),
 * потом выполняем, потом отчитываемся. При сбое задача остаётся открытой —
 * лучше повторить, чем потерять.
 */
export async function runAgentTasks(
  agent: AgentDefinition,
  core: AgentsCoreClient,
  threshold: AutonomyTier,
): Promise<TaskRunResult[]> {
  if (agent.status !== "active") return [];

  const tasks = await core.myTasks(agent.name);
  const results: TaskRunResult[] = [];

  for (const t of tasks) {
    const skill = matchSkill(agent, t.title);

    if (skill === null) {
      // Честный отказ: возвращаем владельцу, задачу не закрываем.
      const note =
        `Не умею это делать. Мои навыки: ${agent.skills.join(", ") || "нет"}. ` +
        `Задача остаётся на мне — переназначь или уточни.`;
      await core.addTaskComment(t.id, note, `agent:${agent.name}`);
      results.push({ taskId: t.id, outcome: "returned", note });
      continue;
    }

    await core.setTaskStatus(t.id, "in_progress", `agent:${agent.name}`);

    const impl = SKILLS[skill];
    const proposal = await impl(agent, core);

    if (proposal === null) {
      // Навык отработал, но повода нет — это тоже результат, и он честный.
      const note = "Проверил — по данным MYDON повода для действий нет.";
      await core.setTaskStatus(t.id, "done", `agent:${agent.name}`, note);
      results.push({ taskId: t.id, outcome: "done", note });
      continue;
    }

    // Есть предложение. При пороге T0 агент не действует сам: результат идёт
    // владельцу на согласование, а задача закрывается отчётом о находке.
    const run = await runSkill(agent, skill, core, threshold);
    const note =
      run.outcome === "approval_requested"
        ? `${proposal.action}\n\nВынес на твоё решение.`
        : proposal.action;

    await core.setTaskStatus(t.id, "done", `agent:${agent.name}`, note);
    results.push({
      taskId: t.id,
      outcome: run.outcome === "approval_requested" ? "proposed" : "done",
      note,
    });
  }

  return results;
}
