/**
 * Лимиты действий агентов.
 *
 * В старом agent-os дневной денежный кап был (Ф9 нашёл его в executor.ts),
 * в новый монорепо он не переносился. Сейчас порог автономии T0 и агенты ничего
 * не исполняют — но потолок ставится ДО того, как он понадобится, а не после
 * первого счёта.
 *
 * Считаем по журналу событий Core: сколько запросов агент уже создал сегодня
 * по ташкентскому дню. Отдельного счётчика намеренно нет — иначе он разошёлся
 * бы с фактом при перезапуске контейнера.
 */
import { TZ } from "@mydon/shared";

export interface LimitDecision {
  allowed: boolean;
  used: number;
  cap: number;
  reason?: string;
}

/** Потолок из окружения. 0 или мусор — считаем «без лимита». */
export function dailyCap(raw: string | undefined = process.env.AGENT_DAILY_ACTION_CAP): number {
  const n = Number((raw ?? "").trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Начало текущих суток по Ташкенту — в UTC, для запроса к журналу. */
export function startOfTashkentDay(now: Date = new Date()): Date {
  // Смещение берём у самого часового пояса, а не константой +5:
  // константа переживёт перевод часов молча и посчитает не тот день.
  const local = new Date(now.toLocaleString("en-US", { timeZone: TZ }));
  const diffMs = now.getTime() - local.getTime();
  local.setHours(0, 0, 0, 0);
  return new Date(local.getTime() + diffMs);
}

/**
 * Решение по лимиту. `used` — сколько действий агент уже совершил за сутки.
 * При достижении потолка действие не выполняется, а причина уходит владельцу.
 */
export function checkLimit(used: number, cap: number = dailyCap()): LimitDecision {
  if (cap === 0) return { allowed: true, used, cap: 0 };
  if (used >= cap) {
    return {
      allowed: false,
      used,
      cap,
      reason: `дневной потолок действий исчерпан: ${used} из ${cap}. Сбросится в полночь по Ташкенту.`,
    };
  }
  return { allowed: true, used, cap };
}
