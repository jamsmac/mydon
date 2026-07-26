import type { AutonomyTier } from "@mydon/shared";

/**
 * Политика автономии.
 *
 * Ответ владельца во фронте Ф6 — «пока всё вручную»: агенты только предлагают,
 * ничего не исполняют сами. Порог хранится в одном месте и поднимается настройкой,
 * а не правкой кода.
 *
 * Правило: действие исполняется без согласования, только если уровень действия
 * НЕ ВЫШЕ разрешённого порога. При пороге T0 согласования требует всё.
 */

const ORDER: AutonomyTier[] = ["T0", "T1", "T2", "T3", "T4"];

export function tierRank(tier: AutonomyTier): number {
  const idx = ORDER.indexOf(tier);
  return idx === -1 ? ORDER.length : idx; // неизвестное считаем максимально опасным
}

/** Порог из окружения. По умолчанию — T0 (всё через владельца). */
export function autonomyThreshold(raw: string | undefined = process.env.AGENT_AUTONOMY_MAX): AutonomyTier {
  const value = (raw ?? "").trim().toUpperCase();
  return (ORDER as string[]).includes(value) ? (value as AutonomyTier) : "T0";
}

/** true — действие требует согласования владельца. */
export function requiresApproval(
  actionTier: AutonomyTier,
  threshold: AutonomyTier = autonomyThreshold(),
): boolean {
  if (threshold === "T0") return true; // текущий режим: без исключений
  return tierRank(actionTier) > tierRank(threshold);
}

/** Понятное объяснение для журнала и для владельца. */
export function explainPolicy(actionTier: AutonomyTier, threshold: AutonomyTier): string {
  return requiresApproval(actionTier, threshold)
    ? `действие уровня ${actionTier} требует согласования (порог ${threshold})`
    : `действие уровня ${actionTier} исполняется без согласования (порог ${threshold})`;
}
