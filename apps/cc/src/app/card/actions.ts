"use server";

import { revalidatePath } from "next/cache";
import { core, CoreUnavailable } from "../../lib/core";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/**
 * Сохранение карточки записи: имя, номер, поля.
 *
 * Поля приходят из формы парами attr:<ключ> → значение. Числа остаются
 * числами (цена 10000, а не строка «10000») — иначе сломались бы будущие
 * подсчёты. Пустое значение удаляет поле.
 */
export async function saveEntity(id: string, form: FormData): Promise<ActionResult> {
  const name = String(form.get("name") ?? "").trim();
  if (name.length === 0) return { ok: false, error: "Имя не может быть пустым" };

  const attrs: Record<string, unknown> = {};
  for (const [key, raw] of form.entries()) {
    if (!key.startsWith("attr:")) continue;
    const attrKey = key.slice(5);
    const value = String(raw).trim();
    if (value.length === 0) continue; // пустое = убрать поле
    attrs[attrKey] = /^-?\d+$/.test(value) ? Number(value) : value;
  }
  // Новое поле, если владелец его добавил
  const newKey = String(form.get("newKey") ?? "").trim();
  const newValue = String(form.get("newValue") ?? "").trim();
  if (newKey.length > 0 && newValue.length > 0) {
    attrs[newKey] = /^-?\d+$/.test(newValue) ? Number(newValue) : newValue;
  }

  try {
    await core.updateEntity(id, {
      name,
      externalRef: String(form.get("externalRef") ?? "").trim() || null,
      attrs,
    });
  } catch (err) {
    if (err instanceof CoreUnavailable) return { ok: false, error: err.detail };
    return { ok: false, error: err instanceof Error ? err.message : "Не удалось сохранить" };
  }
  revalidatePath(`/card/${id}`);
  revalidatePath("/registry");
  return { ok: true };
}
