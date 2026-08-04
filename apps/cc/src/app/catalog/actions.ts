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

/** Число из поля формы: пусто → undefined, мусор → NaN (отобьёт Core словами). */
function num(form: FormData, name: string): number | undefined {
  const raw = String(form.get(name) ?? "").trim().replace(/\s/g, "").replace(",", ".");
  if (raw === "") return undefined;
  return Number(raw);
}

function str(form: FormData, name: string): string | undefined {
  const raw = String(form.get(name) ?? "").trim();
  return raw === "" ? undefined : raw;
}

/**
 * Ставка ТН ВЭД: проценты вводятся ПРОЦЕНТАМИ (5 = 5%), в Core уходят долями
 * (0.05) — как хранит донор PROMACH. Пересчёт здесь, на границе формы.
 */
export async function saveTnvedRate(domain: string, form: FormData): Promise<ActionResult> {
  const pct = (name: string): number | undefined => {
    const v = num(form, name);
    return v === undefined ? undefined : v / 100;
  };
  try {
    await core.saveTnvedRate({
      id: str(form, "id"),
      code: str(form, "code") ?? "",
      nameRu: str(form, "nameRu") ?? "",
      importDutyRate: pct("dutyPct"),
      customsFeeRate: pct("feePct"),
      vatRate: pct("vatPct"),
      exciseRate: pct("excisePct"),
      utilizationBrvCount: num(form, "utilBrv"),
      extraDutyPerCcUsd: num(form, "extraCc"),
      grossMassMinKg: num(form, "massMin"),
      grossMassMaxKg: num(form, "massMax"),
      engineTypeConstraint: str(form, "engines"),
      notes: str(form, "notes"),
      actorRef: "owner",
    });
    revalidatePath(`/domain/${domain}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

/** Убрать ставку из работы (строка остаётся в истории). */
export async function deactivateTnvedRate(domain: string, id: string): Promise<ActionResult> {
  try {
    await core.deactivateTnvedRate(id);
    revalidatePath(`/domain/${domain}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

/** Задать БРВ с даты. */
export async function setBrvValue(domain: string, form: FormData): Promise<ActionResult> {
  const valueUzs = num(form, "valueUzs");
  const validFrom = str(form, "validFrom");
  if (valueUzs === undefined || Number.isNaN(valueUzs)) {
    return { ok: false, message: "Впиши БРВ числом (сумов)" };
  }
  if (validFrom === undefined) {
    return { ok: false, message: "Выбери дату «действует с»" };
  }
  try {
    await core.setBrvValue({ valueUzs, validFrom, note: str(form, "note") });
    revalidatePath(`/domain/${domain}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}
