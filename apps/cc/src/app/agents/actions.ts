"use server";

import { revalidatePath } from "next/cache";
import { core, CoreUnavailable } from "../../lib/core";

export interface ActionResult {
  ok: boolean;
  error?: string;
  /** Куда перейти после успеха (например на карточку созданного агента). */
  goTo?: string;
}

function fail(err: unknown): ActionResult {
  if (err instanceof CoreUnavailable) return { ok: false, error: err.detail };
  return { ok: false, error: err instanceof Error ? err.message : "Не удалось сохранить" };
}

/** Расписания приходят из формы строками: "0 9 * * 1 | morning-digest" на строку. */
function parseSchedule(raw: string): { cron: string; skill: string }[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [cron, skill] = line.split("|").map((p) => p.trim());
      return { cron: cron ?? "", skill: skill ?? "" };
    })
    .filter((s) => s.cron.length > 0 && s.skill.length > 0);
}

function parseList(raw: string): string[] {
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Сохранение карточки: настройки живут в базе и переживают обновление системы. */
export async function saveAgent(name: string, form: FormData): Promise<ActionResult> {
  const budgetRaw = String(form.get("budgetPerDayUsd") ?? "").trim();
  const budget = budgetRaw === "" ? null : Number(budgetRaw.replace(",", "."));
  if (budget !== null && !Number.isFinite(budget)) {
    return { ok: false, error: "Бюджет: нужно число, например 3 или 2.5" };
  }

  try {
    await core.updateAgent(name, {
      status: String(form.get("status") ?? "paused"),
      business: String(form.get("business") ?? "shared"),
      description: String(form.get("description") ?? "").trim() || null,
      mission: String(form.get("mission") ?? "").trim() || null,
      nonGoals: parseList(String(form.get("nonGoals") ?? "")),
      autonomyDefault: String(form.get("autonomyDefault") ?? "T1"),
      skills: parseList(String(form.get("skills") ?? "")),
      schedule: parseSchedule(String(form.get("schedule") ?? "")),
      budgetPerDayUsd: budget,
    });
  } catch (err) {
    return fail(err);
  }

  revalidatePath("/agents");
  revalidatePath(`/agents/${name}`);
  return { ok: true };
}

/** Быстрое включение/выключение — самое частое действие, без открытия формы. */
export async function toggleAgent(name: string, turnOn: boolean): Promise<ActionResult> {
  try {
    await core.updateAgent(name, { status: turnOn ? "active" : "paused" });
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/agents");
  revalidatePath(`/agents/${name}`);
  return { ok: true };
}

/** Заведение агента. Новый всегда выключён: включение — осознанный шаг. */
export async function createAgent(form: FormData): Promise<ActionResult> {
  const name = String(form.get("name") ?? "").trim();
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(name)) {
    return {
      ok: false,
      error: "Имя: латиница в нижнем регистре, цифры и дефис. Например: globerent-ops",
    };
  }

  try {
    await core.createAgent({
      name,
      business: String(form.get("business") ?? "shared"),
      description: String(form.get("description") ?? "").trim() || null,
      mission: String(form.get("mission") ?? "").trim() || null,
      autonomyDefault: String(form.get("autonomyDefault") ?? "T1"),
      status: "paused",
    });
  } catch (err) {
    return fail(err);
  }

  revalidatePath("/agents");
  return { ok: true, goTo: `/agents/${name}` };
}

/**
 * Удаление агента. Физически это архивация: журнал и согласования ссылаются
 * на агента по имени, и стирание строки оставило бы историю без объяснения.
 * Имя при этом освобождается — можно завести агента заново.
 */
export async function deleteAgent(name: string): Promise<ActionResult> {
  try {
    await core.archiveAgent(name);
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/agents");
  return { ok: true, goTo: "/agents" };
}
