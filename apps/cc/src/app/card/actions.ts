"use server";

import { revalidatePath } from "next/cache";
import { isUnit, type RecipeLine } from "@mydon/shared";
import { core, CoreUnavailable } from "../../lib/core";

export interface CreateResult {
  ok: boolean;
  error?: string;
}

/** Создание записи руками владельца — прямо из вкладки направления. */
export async function createEntity(
  domain: string,
  type: string,
  form: FormData,
): Promise<CreateResult> {
  const name = String(form.get("name") ?? "").trim();
  if (name.length < 2) return { ok: false, error: "Впиши название" };

  const attrs: Record<string, unknown> = {};
  const price = String(form.get("price") ?? "").trim();
  if (/^\d+$/.test(price)) attrs["цена"] = Number(price);

  try {
    await core.createEntity({
      domain,
      type,
      name,
      externalRef: String(form.get("externalRef") ?? "").trim() || undefined,
      ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
    });
  } catch (err) {
    if (err instanceof CoreUnavailable) return { ok: false, error: err.detail };
    return { ok: false, error: err instanceof Error ? err.message : "Не удалось создать" };
  }
  revalidatePath(`/domain/${domain}`);
  revalidatePath("/registry");
  return { ok: true };
}

/** Удаление записи. Содержимое остаётся в журнале — «что это было» видно всегда. */
export async function deleteEntity(id: string, domain: string | null): Promise<CreateResult> {
  try {
    await core.deleteEntity(id);
  } catch (err) {
    if (err instanceof CoreUnavailable) return { ok: false, error: err.detail };
    return { ok: false, error: err instanceof Error ? err.message : "Не удалось удалить" };
  }
  if (domain) revalidatePath(`/domain/${domain}`);
  revalidatePath("/registry");
  return { ok: true };
}

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

/**
 * Приход ингредиента на склад. Остаток Core считает на чтении из движений —
 * здесь только заводим одну строку прихода.
 */
export async function addIntake(
  ingredientId: string,
  input: {
    warehouseId: string;
    qty: number;
    unit: string;
    unitPrice?: number;
    dt?: string;
    supplier?: string;
    note?: string;
  },
): Promise<ActionResult> {
  if (!input.warehouseId) return { ok: false, error: "Выбери склад" };
  if (!(input.qty > 0)) return { ok: false, error: "Количество должно быть больше нуля" };
  if (!input.unit) return { ok: false, error: "Выбери единицу" };
  try {
    await core.createMovement({ kind: "intake", ingredientId, ...input });
  } catch (err) {
    if (err instanceof CoreUnavailable) return { ok: false, error: err.detail };
    return { ok: false, error: err instanceof Error ? err.message : "Не удалось завести приход" };
  }
  revalidatePath(`/card/${ingredientId}`);
  return { ok: true };
}

/** Удалить движение склада (правка ручного прихода). */
export async function removeMovement(movementId: string, cardId: string): Promise<ActionResult> {
  try {
    await core.deleteMovement(movementId);
  } catch (err) {
    if (err instanceof CoreUnavailable) return { ok: false, error: err.detail };
    return { ok: false, error: err instanceof Error ? err.message : "Не удалось удалить" };
  }
  revalidatePath(`/card/${cardId}`);
  return { ok: true };
}

/**
 * Сохранение состава рецепта. Пишем только поле `состав`, остальные attrs
 * карточки берём как есть — иначе форма затёрла бы их. Пустой состав убирает
 * поле: у товара без рецепта его быть не должно.
 *
 * Строки чистим здесь же: без ингредиента, с неположительным количеством или
 * чужой единицей — не сохраняем. Себестоимость Core пересчитает на чтении.
 */
export async function saveRecipe(id: string, rawLines: unknown): Promise<ActionResult> {
  const lines: RecipeLine[] = [];
  if (Array.isArray(rawLines)) {
    for (const item of rawLines) {
      if (typeof item !== "object" || item === null) continue;
      const o = item as Record<string, unknown>;
      const ingredientId = typeof o.ingredientId === "string" ? o.ingredientId : "";
      const quantity = typeof o.quantity === "number" ? o.quantity : Number(o.quantity);
      const unit = o.unit;
      if (ingredientId.length === 0 || !Number.isFinite(quantity) || quantity <= 0 || !isUnit(unit)) {
        continue;
      }
      lines.push({ ingredientId, quantity, unit });
    }
  }

  let entity;
  try {
    entity = await core.entity(id);
  } catch (err) {
    if (err instanceof CoreUnavailable) return { ok: false, error: err.detail };
    return { ok: false, error: err instanceof Error ? err.message : "Карточка не найдена" };
  }

  const attrs: Record<string, unknown> = { ...(entity.attrs ?? {}) };
  if (lines.length > 0) attrs["состав"] = JSON.stringify(lines);
  else delete attrs["состав"];

  try {
    await core.updateEntity(id, {
      name: entity.name,
      externalRef: entity.externalRef,
      attrs,
    });
  } catch (err) {
    if (err instanceof CoreUnavailable) return { ok: false, error: err.detail };
    return { ok: false, error: err instanceof Error ? err.message : "Не удалось сохранить состав" };
  }
  revalidatePath(`/card/${id}`);
  return { ok: true };
}
