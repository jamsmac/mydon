"use server";

import { revalidatePath } from "next/cache";
import { core, CoreUnavailable } from "../../lib/core";

export interface ActionResult {
  ok: boolean;
  message?: string;
  id?: string;
}

function detailOf(err: unknown): string {
  return err instanceof CoreUnavailable ? err.detail : err instanceof Error ? err.message : "Core недоступен";
}

function refresh(id?: string): void {
  revalidatePath("/domain/globerent");
  if (id !== undefined) revalidatePath(`/imports/${id}`);
}

export async function createImport(form: FormData): Promise<ActionResult> {
  const str = (name: string): string | undefined => {
    const raw = String(form.get(name) ?? "").trim();
    return raw === "" ? undefined : raw;
  };
  const num = (name: string): number | undefined => {
    const raw = String(form.get(name) ?? "").trim().replace(/\s/g, "").replace(",", ".");
    if (raw === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  let items: unknown;
  try {
    items = JSON.parse(String(form.get("items") ?? "[]"));
  } catch {
    return { ok: false, message: "Позиции не разобрались — обнови страницу" };
  }
  try {
    const created = await core.createImport({
      domain: "globerent",
      contractNo: str("contractNo"),
      contractDate: str("contractDate"),
      supplierId: str("supplierId"),
      currency: str("currency"),
      items,
      prepaymentAmount: num("prepaymentAmount"),
      prepaymentDueDate: str("prepaymentDueDate"),
      balanceAmount: num("balanceAmount"),
      balanceDueDate: str("balanceDueDate"),
      notes: str("notes"),
      actorRef: "owner",
    });
    refresh(created.id);
    return { ok: true, id: created.id };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

export async function signImport(id: string): Promise<ActionResult> {
  try {
    await core.signImport(id);
    refresh(id);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

export async function markImportPaid(id: string, kind: "prepayment" | "balance"): Promise<ActionResult> {
  try {
    await core.markImportPaid(id, kind);
    refresh(id);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

export async function bulkImportAction(
  id: string,
  action: string,
  extra: Record<string, string> = {},
): Promise<ActionResult & { moved?: number; skipped?: number }> {
  try {
    const r = await core.bulkImportAction(id, action, extra);
    refresh(id);
    return { ok: true, moved: r.moved, skipped: r.skipped };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

export async function cancelImport(id: string): Promise<ActionResult> {
  try {
    await core.cancelImport(id);
    refresh(id);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}
