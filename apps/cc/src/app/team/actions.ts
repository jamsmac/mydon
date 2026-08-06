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
      domain: String(form.get("domain") ?? "").trim() || null,
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
      domain: String(form.get("domain") ?? "").trim() || null,
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

/**
 * Выпустить приглашение сотруднику.
 *
 * Код возвращается ОДИН раз и попадает прямо в результат действия: в базе
 * лежит только его отпечаток, и «показать ещё раз» невозможно by design.
 * Поэтому он не пишется ни в лог, ни в ревалидируемую страницу — только
 * в ответ тому, кто нажал.
 */
export async function invitePerson(
  id: string,
  roles: string[],
): Promise<ActionResult & { link?: string; expiresAt?: string }> {
  try {
    const res = await core.invitePerson(id, roles);
    const bot = process.env.TELEGRAM_BOT_USERNAME ?? "";
    revalidatePath(`/team/${id}`);
    return {
      ok: true,
      // Без имени бота ссылку не собрать — отдаём хотя бы код, чтобы
      // владелец не остался ни с чем из-за незаполненной переменной.
      link: bot ? `https://t.me/${bot}?start=inv_${res.code}` : `код: ${res.code}`,
      expiresAt: res.expiresAt,
    };
  } catch (err) {
    return fail(err);
  }
}

/** Отозвать доступ. Карточка и история работ остаются в реестре. */
export async function revokePerson(id: string): Promise<ActionResult> {
  try {
    await core.revokePerson(id);
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/team/${id}`);
  revalidatePath("/team");
  return { ok: true };
}

/** Проставить роли уже подключённому — без выпуска новой ссылки. */
export async function setPersonRoles(id: string, roles: string[]): Promise<ActionResult> {
  try {
    await core.setPersonRoles(id, roles);
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/team/${id}`);
  return { ok: true };
}
