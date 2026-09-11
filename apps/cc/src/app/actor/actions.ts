"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { parseAgentName } from "@mydon/shared";
import { ACTOR_COOKIE, ACTOR_COOKIE_MAX_AGE_S } from "../../lib/actor";

export interface ActionResult {
  ok: boolean;
  message?: string;
}

/**
 * Объявить, что в этом браузере действует агент (R-H-9): дальше каждая запись
 * панели подписывается `agent:<имя>`, а не владельцем.
 *
 * Имя проверяется тем же `parseAgentName`, что читает куку: server action —
 * публичная точка входа, и строка, которую чтение не примет, не должна лечь
 * в куку «объявленной» — иначе шапка показала бы агента, а журнал писал бы
 * владельца.
 *
 * Кука не httpOnly — как у темы: панель живёт по http за Tailscale, а читать
 * куку из скрипта нечему вредить, она не даёт прав.
 */
export async function declareAgent(form: FormData): Promise<ActionResult> {
  const raw = form.get("agent");
  const name = parseAgentName(typeof raw === "string" ? raw : null);
  if (name === null) {
    return { ok: false, message: "Имя агента — латиница, цифры и дефис, от 2 до 40 знаков: claude-code, codex" };
  }
  try {
    const store = await cookies();
    store.set(ACTOR_COOKIE, name, { path: "/", sameSite: "lax", maxAge: ACTOR_COOKIE_MAX_AGE_S });
    // Плашка «действует агент» живёт в корневом layout — перерисовать его.
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Не удалось сохранить" };
  }
}

/** Вернуть авторство себе: куки нет — записи снова подписываются по личности. */
export async function clearAgent(): Promise<ActionResult> {
  try {
    const store = await cookies();
    // Path тот же, что при записи: браузер сопоставляет куки по паре имя+путь.
    store.delete({ name: ACTOR_COOKIE, path: "/" });
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Не удалось сбросить" };
  }
}
