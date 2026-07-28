"use server";

import { revalidatePath } from "next/cache";
import { core, CoreUnavailable } from "../../lib/core";

export interface ActionResult {
  ok: boolean;
  error?: string;
  goTo?: string;
}

function fail(err: unknown): ActionResult {
  if (err instanceof CoreUnavailable) return { ok: false, error: err.detail };
  return { ok: false, error: err instanceof Error ? err.message : "Не удалось сохранить" };
}

export async function createPerson(form: FormData): Promise<ActionResult> {
  const name = String(form.get("name") ?? "").trim();
  if (name.length < 2) return { ok: false, error: "Впиши имя сотрудника" };

  try {
    await core.createPerson({
      name,
      role: String(form.get("role") ?? "").trim() || null,
      phone: String(form.get("phone") ?? "").trim() || null,
      tgUsername: String(form.get("tgUsername") ?? "").trim() || null,
    });
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/team");
  return { ok: true };
}

export async function savePerson(id: string, form: FormData): Promise<ActionResult> {
  try {
    await core.updatePerson(id, {
      name: String(form.get("name") ?? "").trim(),
      role: String(form.get("role") ?? "").trim() || null,
      phone: String(form.get("phone") ?? "").trim() || null,
      email: String(form.get("email") ?? "").trim() || null,
      tgUsername: String(form.get("tgUsername") ?? "").trim() || null,
    });
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/team");
  revalidatePath(`/team/${id}`);
  return { ok: true };
}

/** Уволенный не удаляется: его задачи и история должны остаться объяснимыми. */
export async function setPersonActive(id: string, active: boolean): Promise<ActionResult> {
  try {
    await core.updatePerson(id, { active });
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/team");
  revalidatePath(`/team/${id}`);
  return { ok: true };
}
