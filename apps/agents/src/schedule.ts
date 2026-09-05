import type { AgentDefinition } from "./registry";

/** Одно cron-задание: чей навык и по какому расписанию. */
export interface ScheduledJob {
  agent: string;
  skill: string;
  cron: string;
}

/** Ключ задания — по нему сверяем запущенное с желаемым при перечитке. */
export function jobKey(j: ScheduledJob): string {
  return `${j.agent}\u0000${j.skill}\u0000${j.cron}`;
}

/**
 * First scheduled metered workflow moved onto Core-owned provider jobs.
 * assess-ideas stays unscheduled until its deferred memory write is durable.
 */
export const DURABLE_SCHEDULED_SKILLS = ["coach-review"] as const;

export type ScheduledInvocationMode = "durable-task" | "legacy";

/**
 * A durable allowlisted skill always materializes a task. Any other skill may
 * use the legacy cron path only while its current workflow has no metered
 * provider steps. This keeps a newly metered route fail-closed.
 *
 * `executor: llm` тоже всегда durable (R-SD-5): его прогон — платный вызов
 * модели, а legacy in-process путь ни денег через Core-ledger не проводит, ни
 * повтор по clientKey не даёт. Поэтому llm-навык не «блокируется metered-гейтом»,
 * а идёт задачей — cron для него открыт без allowlist.
 *
 * `isLlm` — параметр, а не импорт `llm-skill`: иначе `schedule` → `llm-skill` →
 * `skills` → … замкнуло бы цикл импортов. Значение по умолчанию честно
 * консервативное (llm нет), вызывающий (`index.ts`) передаёт `isLlmSkill`.
 */
export function scheduledInvocationMode(
  skill: string,
  hasMeteredWorkflow: () => boolean,
  isLlm: (skill: string) => boolean = () => false,
): ScheduledInvocationMode {
  if (isLlm(skill) || (DURABLE_SCHEDULED_SKILLS as readonly string[]).includes(skill)) {
    return "durable-task";
  }
  if (hasMeteredWorkflow()) {
    throw new Error(
      `Metered scheduled skill ${skill} is blocked until it is allowlisted for durable tasks`,
    );
  }
  return "legacy";
}

/**
 * Желаемый набор cron-заданий из текущих настроек агентов.
 *
 * Берём только АКТИВНЫХ агентов и только навыки с реализацией: паузу агента в
 * карточке и снятый навык надо уважать сразу, без перезапуска контейнера.
 * Чистая функция — вокруг неё строится примирение запущенных заданий с
 * желаемыми (reconcile), и её легко проверить.
 */
export function desiredJobs(
  agents: readonly AgentDefinition[],
  isWired: (skill: string) => boolean,
): { jobs: ScheduledJob[]; notWired: string[] } {
  const jobs: ScheduledJob[] = [];
  const notWired: string[] = [];
  const seen = new Set<string>();
  for (const agent of agents) {
    if (agent.status !== "active") continue;
    for (const item of agent.schedule) {
      if (!isWired(item.skill)) {
        notWired.push(`${agent.name}/${item.skill}`);
        continue;
      }
      const job: ScheduledJob = { agent: agent.name, skill: item.skill, cron: item.cron };
      const key = jobKey(job);
      if (seen.has(key)) continue; // дубль расписания не заводим дважды
      seen.add(key);
      jobs.push(job);
    }
  }
  return { jobs, notWired };
}
