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
 * Значение поля в число, если оно число, — иначе строкой.
 *
 * Дроби тоже: координаты «41.311» и объём «0.5» должны стать числами, а не
 * остаться строками (раньше парсились только целые — карта на дробных широтах
 * не поднималась). «1.2.3», телефоны с «+», коды с буквами — остаются строками.
 */
function coerce(value: string): string | number {
  return /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
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
    attrs[attrKey] = coerce(value);
  }
  // Новое поле, если владелец его добавил
  const newKey = String(form.get("newKey") ?? "").trim();
  const newValue = String(form.get("newValue") ?? "").trim();
  if (newKey.length > 0 && newValue.length > 0) {
    attrs[newKey] = coerce(newValue);
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

export interface SyncIntakeResult {
  ok: boolean;
  error?: string;
  summary?: {
    warehouse: string | null;
    created: number;
    alreadySynced: number;
    noCard: number;
    badUnit: number;
    noWarehouse: "нет" | "неоднозначно" | null;
  };
}

/** Свести приход из mydon-stock в ленту склада (по кнопке). */
export async function syncIntake(): Promise<SyncIntakeResult> {
  try {
    const summary = await core.syncIntake();
    revalidatePath("/domain/vendhub");
    return { ok: true, summary };
  } catch (err) {
    if (err instanceof CoreUnavailable) return { ok: false, error: err.detail };
    return { ok: false, error: err instanceof Error ? err.message : "Не удалось свести приход" };
  }
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

/** Итог сессии пересчёта склада — что применилось. */
export interface StocktakeResult {
  ok: boolean;
  error?: string;
  /** Позиций с корректировкой (остаток изменился). */
  changed?: number;
  /** Позиций, где факт совпал с книжным — движения нет. */
  matched?: number;
  /** Позиций, что не удалось провести (единица/перевод). */
  failed?: number;
}

/**
 * Сессия пересчёта склада (инвентаризация «заголовком»): владелец вписывает
 * фактические остатки по позициям, а сервер по КАЖДОЙ сам считает дельту от
 * книжного остатка и пишет корректировку. Считаем здесь только для отчёта
 * владельцу; истина о дельте — на стороне Core (иначе разошлись бы).
 *
 * Одна битая позиция (нет базовой единицы, не сводится) не срывает остальные:
 * помечаем непроведённой и считаем отдельно.
 */
export async function runStocktake(warehouseId: string, rawLines: unknown): Promise<StocktakeResult> {
  const lines: { ingredientId: string; actual: number; unit?: string }[] = [];
  if (Array.isArray(rawLines)) {
    for (const item of rawLines) {
      if (typeof item !== "object" || item === null) continue;
      const o = item as Record<string, unknown>;
      const ingredientId = typeof o.ingredientId === "string" ? o.ingredientId : "";
      const actual = typeof o.actual === "number" ? o.actual : Number(o.actual);
      const unit = typeof o.unit === "string" && o.unit.length > 0 ? o.unit : undefined;
      if (ingredientId.length === 0 || !Number.isFinite(actual) || actual < 0) continue;
      lines.push({ ingredientId, actual, unit });
    }
  }
  if (lines.length === 0) return { ok: false, error: "Не вписано ни одного фактического остатка" };

  let changed = 0;
  let matched = 0;
  let failed = 0;
  for (const l of lines) {
    try {
      const res = await core.stocktake({
        warehouseId,
        ingredientId: l.ingredientId,
        actual: l.actual,
        ...(l.unit ? { unit: l.unit } : {}),
        countedBy: "owner",
        note: "пересчёт склада",
      });
      if (res.changed) changed += 1;
      else matched += 1;
    } catch {
      // Единицу не свести или иная причина — позиция не проведена, идём дальше.
      failed += 1;
    }
  }

  revalidatePath(`/card/${warehouseId}`);
  return { ok: true, changed, matched, failed };
}

/**
 * Сохранение планограммы автомата: какой товар в каком слоте.
 *
 * Пишем только поле `раскладка`, прочие attrs берём как есть. Строки чистим:
 * без слота или без товара — не сохраняем; повторный слот отбрасываем (в ячейке
 * один товар). Пустая планограмма убирает поле.
 */
export async function savePlanogram(id: string, rawLines: unknown): Promise<ActionResult> {
  const lines: { slot: string; productId: string }[] = [];
  const seen = new Set<string>();
  if (Array.isArray(rawLines)) {
    for (const item of rawLines) {
      if (typeof item !== "object" || item === null) continue;
      const o = item as Record<string, unknown>;
      const slot = typeof o.slot === "string" ? o.slot.trim() : "";
      const productId = typeof o.productId === "string" ? o.productId : "";
      if (slot.length === 0 || productId.length === 0 || seen.has(slot)) continue;
      seen.add(slot);
      lines.push({ slot, productId });
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
  if (lines.length > 0) attrs["раскладка"] = JSON.stringify(lines);
  else delete attrs["раскладка"];

  try {
    await core.updateEntity(id, { name: entity.name, externalRef: entity.externalRef, attrs });
  } catch (err) {
    if (err instanceof CoreUnavailable) return { ok: false, error: err.detail };
    return { ok: false, error: err instanceof Error ? err.message : "Не удалось сохранить раскладку" };
  }
  revalidatePath(`/card/${id}`);
  return { ok: true };
}
