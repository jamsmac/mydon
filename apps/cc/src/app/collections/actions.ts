"use server";

import { revalidatePath } from "next/cache";
import type { DenominationCounts } from "@mydon/shared";
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
 * Приём инкассации: менеджер пересчитал и вводит сумму.
 *
 * `denominations` (срез К, задача 6) — необязательный довесок: форма уже
 * сверила сумму купюр с введённой суммой на глазах (`collection-receive.tsx`),
 * но ядро всё равно повторяет ту же проверку при записи (Task 3) — форма её
 * не заменяет, а только показывает раньше. Не передан — приём работает как
 * раньше, ни одна из 386 существующих записей купюр не теряет.
 */
export async function receiveCollection(
  id: string,
  amountRaw: string,
  denominations?: DenominationCounts,
): Promise<ActionResult> {
  const amount = Number(amountRaw.replace(/[\s,]/g, ""));
  if (!Number.isFinite(amount) || amount < 0) {
    return { ok: false, error: "Введи сумму числом, в сумах" };
  }
  try {
    await core.receiveCollection(id, amount, denominations);
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/domain/vendhub");
  return { ok: true };
}

/** Отмена ошибочной фиксации. */
export async function cancelCollection(id: string): Promise<ActionResult> {
  try {
    await core.cancelCollection(id);
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/domain/vendhub");
  return { ok: true };
}
