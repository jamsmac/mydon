"use server";

import { resolveActor } from "../../lib/actor";
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
      actorRef: await resolveActor(),
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
  const lidWeight = int("lidWeight");
  if (setNumber === undefined || hopperPosition === undefined || tareWeight === undefined) {
    return { ok: false, error: "Набор, позиция и тара — целые числа" };
  }
  if (lidWeight === undefined) return { ok: false, error: "Вес крышки — целое число грамм" };
  // Поля крышки есть только в форме бункера: у прочих узлов их нет вовсе, и
  // слать `tareBasis: null` нельзя — основание не бывает пустым.
  const hasLid = form.has("tareBasis");
  try {
    await core.partUpdate(id, {
      serialNumber: text("serialNumber"),
      model: text("model"),
      manufacturer: text("manufacturer"),
      setNumber,
      hopperPosition,
      tareWeight,
      ...(hasLid ? { tareBasis: String(form.get("tareBasis")), lidWeight } : {}),
      note: text("note"),
      actorRef: await resolveActor(),
    });
  } catch (err) {
    return fail(err);
  }
  refresh(id);
  return { ok: true };
}

/** Перемещение узла вне автомата: сушка, склад, ремонт; «помыт» — по настройке сушки. */
export async function movePartUnit(id: string, to: "washed" | "warehouse" | "drying" | "repair" | "washing"): Promise<ActionResult> {
  try {
    if (to === "washed") await core.partWashed(id);
    else await core.partMove(id, { to, actorRef: await resolveActor() });
  } catch (err) {
    return fail(err);
  }
  refresh(id);
  return { ok: true };
}

export async function retirePartUnit(id: string, reason: string): Promise<ActionResult> {
  try {
    await core.partRetire(id, reason.trim() || "списан владельцем");
  } catch (err) {
    return fail(err);
  }
  refresh(id);
  return { ok: true };
}

/** Автозаведение по составу — с панели, с предпросмотром. */
export async function provisionParts(dryRun: boolean): Promise<ActionResult & { report?: unknown }> {
  try {
    const report = await core.partsProvision({ dryRun, actorRef: await resolveActor() });
    if (!dryRun) refresh();
    return { ok: true, report };
  } catch (err) {
    return fail(err);
  }
}

// ── Инвентаризация узлов (У4) ──

function refreshCount(id?: string): void {
  refresh();
  revalidatePath("/parts/count");
  if (id) revalidatePath(`/parts/count/${id}`);
}

/** Применить сессию: найденные подтверждены, новые заведены, не найденные → «неизвестно где». */
export async function applyPartCount(id: string): Promise<ActionResult & { report?: { found: number; created: string[]; moved: string[]; missing: string[] } }> {
  try {
    const report = await core.partCountApply(id);
    refreshCount(id);
    return { ok: true, report };
  } catch (err) {
    return fail(err);
  }
}

/** Откат применённой сессии обратной сессией. */
export async function reversePartCount(id: string): Promise<ActionResult & { restored?: string[]; skipped?: string[] }> {
  try {
    const res = await core.partCountReverse(id);
    refreshCount(id);
    return { ok: true, restored: res.restored, skipped: res.skipped };
  } catch (err) {
    return fail(err);
  }
}

/** Открыть сессию с панели (владелец считает сам, без бота). */
export async function startPartCount(location: string): Promise<ActionResult & { id?: string; resumed?: boolean }> {
  try {
    const res = await core.partCountStart({ location, actorRef: await resolveActor() });
    refreshCount(res.session.id);
    return { ok: true, id: res.session.id, resumed: res.resumed };
  } catch (err) {
    return fail(err);
  }
}

export async function removePartCountLine(sessionId: string, lineId: string): Promise<ActionResult> {
  try {
    await core.partCountRemoveLine(lineId);
    refreshCount(sessionId);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}
