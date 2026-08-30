import { TZ } from "@mydon/shared";
import { Cron } from "croner";

/** Synthetic task source used for durable scheduled agent invocations. */
export const AGENT_SCHEDULE_SOURCE = "agent-schedule";

/** Retry brief Core/network outages, but reject stale or pre-created occurrences. */
export const AGENT_SCHEDULE_MAX_DELAY_MS = 15 * 60_000;
export const AGENT_SCHEDULE_MAX_FUTURE_SKEW_MS = 60_000;

export function isCurrentCronOccurrence(
  expression: string,
  scheduledAt: Date,
  observedAt: Date,
): boolean {
  const scheduledMs = scheduledAt.getTime();
  const observedMs = observedAt.getTime();
  if (!Number.isFinite(scheduledMs) || !Number.isFinite(observedMs)) return false;
  const ageMs = observedMs - scheduledMs;
  if (ageMs > AGENT_SCHEDULE_MAX_DELAY_MS || ageMs < -AGENT_SCHEDULE_MAX_FUTURE_SKEW_MS) {
    return false;
  }

  let cron: Cron | null = null;
  try {
    cron = new Cron(expression, { timezone: TZ, paused: true });
    return cron.nextRun(new Date(scheduledMs - 1_000))?.getTime() === scheduledMs;
  } catch {
    return false;
  } finally {
    cron?.stop();
  }
}
