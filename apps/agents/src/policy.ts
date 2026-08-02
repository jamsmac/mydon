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

/** Самый строгий из уровней (макс. по рангу). Пустой список → T0. */
export function maxTier(tiers: readonly AutonomyTier[]): AutonomyTier {
  let best: AutonomyTier = "T0";
  for (const t of tiers) {
    if (tierRank(t) > tierRank(best)) best = t;
  }
  return best;
}

/**
 * Эффективный тир действия — floor из нескольких источников по правилу «строже
 * побеждает»: тир из карточки агента (`autonomy_default`) и объявленный тир
 * навыка (frontmatter `requires-approval`). Навык, помеченный T3 (деньги), не
 * исполнится ниже T3, даже если карточка агента разрешает больше. Источников
 * пока два; добавить действие/инструмент как ещё один floor — одна правка здесь.
 */
export function effectiveActionTier(
  agentDefault: AutonomyTier,
  skillFloor?: AutonomyTier,
): AutonomyTier {
  return skillFloor ? maxTier([agentDefault, skillFloor]) : agentDefault;
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
