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

/** Приём инкассации: менеджер пересчитал и вводит сумму. */
export async function receiveCollection(id: string, amountRaw: string): Promise<ActionResult> {
  const amount = Number(amountRaw.replace(/[\s,]/g, ""));
  if (!Number.isFinite(amount) || amount < 0) {
    return { ok: false, error: "Введи сумму числом, в сумах" };
  }
  try {
    await core.receiveCollection(id, amount);
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
