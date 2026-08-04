"use server";

import { revalidatePath } from "next/cache";
import { core, CoreUnavailable } from "../../lib/core";

export interface ActionResult {
  ok: boolean;
  message?: string;
}

function detailOf(err: unknown): string {
  return err instanceof CoreUnavailable ? err.detail : err instanceof Error ? err.message : "Core недоступен";
}

function done(err?: unknown): ActionResult {
  revalidatePath("/domain/globerent");
  return err === undefined ? { ok: true } : { ok: false, message: detailOf(err) };
}

export async function createPreorder(form: FormData): Promise<ActionResult> {
  const name = String(form.get("name") ?? "").trim();
  if (name.length < 2) return { ok: false, message: "Впиши, что заказываем" };
  const qtyRaw = String(form.get("qty") ?? "1").trim();
  try {
    await core.createPreorder({
      domain: "globerent",
      name,
      qty: /^\d+$/.test(qtyRaw) ? Number(qtyRaw) : 1,
      clientId: String(form.get("clientId") ?? "").trim() || undefined,
      supplierId: String(form.get("supplierId") ?? "").trim() || undefined,
      submitImmediately: form.get("submitImmediately") !== null,
      actorRef: "owner",
    });
    return done();
  } catch (err) {
    return done(err);
  }
}

export async function preorderAction(
  id: string,
  action: string,
  extra: Record<string, string> = {},
): Promise<ActionResult> {
  try {
    await core.preorderAction(id, action, { ...extra, actorRef: "owner" });
    return done();
  } catch (err) {
    return done(err);
  }
}

export async function cancelPreorder(id: string, reason: string): Promise<ActionResult> {
  try {
    await core.cancelPreorder(id, reason);
    return done();
  } catch (err) {
    return done(err);
  }
}
