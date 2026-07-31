"use server";

import { revalidatePath } from "next/cache";
import { core, CoreUnavailable } from "../../lib/core";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

function fail(err: unknown): ActionResult {
  if (err instanceof CoreUnavailable) return { ok: false, error: err.detail };
  return { ok: false, error: err instanceof Error ? err.message : "Не получилось" };
}

/**
 * Решение владельца по значению источника.
 *
 * Пустой `entityId` — осознанное «карточка не нужна»: значение перестаёт
 * числиться неразобранным, но в реестр не попадает. Это не то же самое, что
 * «ещё не смотрел», и хранится отдельно именно поэтому.
 */
export async function linkRawValue(
  source: string,
  kind: "machine" | "product" | "point",
  label: string,
  entityId: string,
): Promise<ActionResult> {
  try {
    await core.rawLink({
      source,
      kind,
      label,
      ...(entityId ? { entityId } : {}),
    });
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/domain/vendhub");
  return { ok: true };
}
