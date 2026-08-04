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

/** Заявка или своя техника на склад. */
export async function createUnit(form: FormData): Promise<ActionResult> {
  const name = String(form.get("name") ?? "").trim();
  if (name.length < 2) return { ok: false, message: "Впиши название (модель, год)" };
  const yearRaw = String(form.get("year") ?? "").trim();
  const priceRaw = String(form.get("salesPrice") ?? "").trim().replace(/\s/g, "");
  try {
    await core.createUnit({
      domain: "globerent",
      name,
      year: /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : undefined,
      vin: String(form.get("vin") ?? "").trim() || undefined,
      inStock: form.get("inStock") !== null,
      salesPrice: priceRaw !== "" && Number.isFinite(Number(priceRaw)) ? Number(priceRaw) : undefined,
      actorRef: "owner",
    });
    return done();
  } catch (err) {
    return done(err);
  }
}

/** Семантический переход конвейера. */
export async function unitAction(
  id: string,
  action: string,
  extra: Record<string, string> = {},
): Promise<ActionResult> {
  try {
    await core.unitAction(id, action, { ...extra, actorRef: "owner" });
    return done();
  } catch (err) {
    return done(err);
  }
}

export async function setUnitVin(id: string, vin: string): Promise<ActionResult> {
  try {
    await core.setUnitVin(id, vin);
    return done();
  } catch (err) {
    return done(err);
  }
}

export async function reserveUnit(id: string, form: FormData): Promise<ActionResult> {
  try {
    await core.reserveUnit(id, {
      endDate: String(form.get("endDate") ?? "").trim(),
      clientId: String(form.get("clientId") ?? "").trim() || undefined,
      note: String(form.get("note") ?? "").trim() || undefined,
      actorRef: "owner",
    });
    return done();
  } catch (err) {
    return done(err);
  }
}

export async function cancelUnitReserve(id: string): Promise<ActionResult> {
  try {
    await core.cancelUnitReserve(id);
    return done();
  } catch (err) {
    return done(err);
  }
}

export async function setUnitSalesStage(
  id: string,
  stage: string,
  extra: { lostReason?: string; salesPrice?: number; clientId?: string } = {},
): Promise<ActionResult> {
  try {
    await core.setUnitSalesStage(id, { stage, ...extra, actorRef: "owner" });
    return done();
  } catch (err) {
    return done(err);
  }
}
