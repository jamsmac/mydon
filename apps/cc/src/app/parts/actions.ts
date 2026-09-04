"use server";

import { revalidatePath } from "next/cache";
import { core, CoreUnavailable } from "../../lib/core";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

function fail(err: unknown): ActionResult {
  if (err instanceof CoreUnavailable) return { ok: false, error: err.detail };
  return { ok: false, error: err instanceof Error ? err.message : "Не удалось сохранить" };
}

function refresh(id?: string): void {
  revalidatePath("/parts");
  revalidatePath("/parts/queue");
  revalidatePath("/maintenance");
  if (id) revalidatePath(`/parts/${id}`);
}

/** Сотрудник наклеил номер — подтверждаем; либо вводит тот, что уже есть на детали. */
export async function setPartNumber(id: string, inventoryNo: string, confirmLabel: boolean): Promise<ActionResult> {
  try {
    await core.partSetNumber(id, {
      ...(inventoryNo.trim() ? { inventoryNo: inventoryNo.trim() } : {}),
      confirmLabel,
      actorRef: "owner",
    });
  } catch (err) {
    return fail(err);
  }
  refresh(id);
  return { ok: true };
}

/** Паспорт узла: серийник, модель, набор/позиция, тара, примечание. */
export async function savePartUnit(id: string, form: FormData): Promise<ActionResult> {
  const text = (name: string): string | null => {
    const v = String(form.get(name) ?? "").trim();
    return v === "" ? null : v;
  };
  const int = (name: string): number | null | undefined => {
    const v = String(form.get(name) ?? "").trim();
    if (v === "") return null;
    return /^\d+$/.test(v) ? Number(v) : undefined;
  };
  const setNumber = int("setNumber");
  const hopperPosition = int("hopperPosition");
  const tareWeight = int("tareWeight");
  if (setNumber === undefined || hopperPosition === undefined || tareWeight === undefined) {
    return { ok: false, error: "Набор, позиция и тара — целые числа" };
  }
  try {
    await core.partUpdate(id, {
      serialNumber: text("serialNumber"),
      model: text("model"),
      manufacturer: text("manufacturer"),
      setNumber,
      hopperPosition,
      tareWeight,
      note: text("note"),
      actorRef: "owner",
    });
  } catch (err) {
    return fail(err);
  }
  refresh(id);
  return { ok: true };
}

export async function retirePartUnit(id: string, reason: string): Promise<ActionResult> {
  try {
    await core.partRetire(id, reason.trim() || "списан владельцем", "owner");
  } catch (err) {
    return fail(err);
  }
  refresh(id);
  return { ok: true };
}

/** Автозаведение по составу — с панели, с предпросмотром. */
export async function provisionParts(dryRun: boolean): Promise<ActionResult & { report?: unknown }> {
  try {
    const report = await core.partsProvision({ dryRun, actorRef: "owner" });
    if (!dryRun) refresh();
    return { ok: true, report };
  } catch (err) {
    return fail(err);
  }
}
