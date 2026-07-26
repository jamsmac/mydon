/**
 * MYDON Agents — рантайм исполнения (скелет).
 * По ответу владельца (Ф6) порог автономии сейчас T0 — агенты только предлагают,
 * ничего не исполняют сами; действия идут через очередь approvals в Core.
 */
import { AUTONOMY_TIERS, type AutonomyTier } from "@mydon/shared";

/** Текущий порог автономии (Ф6: всё вручную). */
export const currentTier: AutonomyTier = "T0";

export function listTiers(): readonly AutonomyTier[] {
  return AUTONOMY_TIERS;
}

export function start(): void {
  console.log(`MYDON Agents: скелет. Порог автономии ${currentTier} (всё вручную).`);
}

if (require.main === module) start();
