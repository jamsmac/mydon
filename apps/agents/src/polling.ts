/** Без env задачи агентов проверяются раз в пять минут. */
export const DEFAULT_AGENT_TASK_INTERVAL_MS = 5 * 60_000;

/** Намеренно не даём ошибке в env создать tight loop. */
export const MIN_AGENT_TASK_INTERVAL_MS = 1_000;

/** В Node большая задержка переполняет 32-bit timer и превращается в 1 мс. */
export const MAX_AGENT_TASK_INTERVAL_MS = 2_147_483_647;

export interface AgentPauseEnv {
  AGENTS_SCHEDULES_PAUSED?: string;
  AGENTS_TASKS_PAUSED?: string;
}

/**
 * Паузы fail-closed: только точное `0` разрешает соответствующий вид работы.
 * Так отсутствие или мусор в env не запускают агентов до того, как Core успел
 * отдать безопасный fallback из панели.
 */
function pauseEnabled(raw: string | undefined): boolean {
  return raw?.trim() !== "0";
}

/** Управляет только cron-навыками из паспортов агентов. */
export function agentSchedulesPaused(env: AgentPauseEnv = process.env): boolean {
  return pauseEnabled(env.AGENTS_SCHEDULES_PAUSED);
}

/** Управляет только задачами, которые владелец назначил агенту через Core/UI. */
export function assignedAgentTasksPaused(env: AgentPauseEnv = process.env): boolean {
  return pauseEnabled(env.AGENTS_TASKS_PAUSED);
}

/**
 * Превращает AGENT_TASK_INTERVAL_MS в безопасную задержку setInterval.
 * Мусор, ноль и отрицательные числа не означают «как можно чаще» —
 * они откатываются к безопасному default. Корректные крайние числа clamp-ятся.
 */
export function agentTaskIntervalMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_AGENT_TASK_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_AGENT_TASK_INTERVAL_MS;
  return Math.min(
    MAX_AGENT_TASK_INTERVAL_MS,
    Math.max(MIN_AGENT_TASK_INTERVAL_MS, Math.trunc(value)),
  );
}

/**
 * Обёртка single-flight: пока предыдущий poll не завершён, тик таймера
 * возвращает false и не запускает второй обход. После success или failure
 * guard снимается.
 */
export function singleFlight(task: () => Promise<void>): () => Promise<boolean> {
  let inFlight: Promise<void> | null = null;

  return async () => {
    if (inFlight !== null) return false;

    // Promise.resolve().then ловит и synchronous throw, и async rejection.
    const current = Promise.resolve().then(task);
    inFlight = current;
    try {
      await current;
      return true;
    } finally {
      if (inFlight === current) inFlight = null;
    }
  };
}
