"use server";

import { revalidatePath } from "next/cache";
import { core, CoreUnavailable } from "../../lib/core";

/** Единый ответ действий этой страницы: панель показывает причину отказа словами, не кодом. */
export interface ActionResult {
  ok: boolean;
  message?: string;
}

function detailOf(err: unknown): string {
  return err instanceof CoreUnavailable ? err.detail : err instanceof Error ? err.message : "Core недоступен";
}

/** Занести заливку бункера («Ввод данных»). */
export async function submitCoffeeRefill(input: {
  locationId: string;
  position: number;
  containerNumber?: number;
  filledWeight: number;
  packageCount?: number;
  enteredDate: string;
}): Promise<ActionResult> {
  try {
    await core.submitCoffeeRefill({ ...input, createdBy: "panel" });
    revalidatePath("/coffee");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

/** Добавить ингредиент в позицию бункера (Настройки). */
export async function addBunkerIngredient(position: number, ingredientName: string): Promise<ActionResult> {
  try {
    await core.addCoffeeBunkerIngredient(position, ingredientName);
    revalidatePath("/coffee");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

/** Убрать ингредиент из позиции бункера (крестик в Настройках). */
export async function removeBunkerIngredient(position: number, ingredientId: string): Promise<ActionResult> {
  try {
    await core.removeCoffeeBunkerIngredient(position, ingredientId);
    revalidatePath("/coffee");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

/** Поправить закупочную цену ингредиента (сум за грамм) — для себестоимости расхода. */
export async function setCoffeeIngredientPrice(ingredientId: string, purchasePrice: number): Promise<ActionResult> {
  try {
    await core.setCoffeeIngredientPrice(ingredientId, purchasePrice);
    revalidatePath("/coffee");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

/** Поправить эталонный чистый вес заливки (недолив-сигнал) для (позиция, ингредиент). */
export async function setCoffeeTargetFillWeight(position: number, ingredientId: string, targetFillWeight: number): Promise<ActionResult> {
  try {
    await core.setCoffeeTargetFillWeight(position, ingredientId, targetFillWeight);
    revalidatePath("/coffee");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

/** Поправить тару одной ячейки (набор × позиция) — «Веса бункеров» в Настройках. */
export async function setCoffeeTare(containerNumber: number, position: number, tareWeight: number): Promise<ActionResult> {
  try {
    await core.setCoffeeTare(containerNumber, position, tareWeight);
    revalidatePath("/coffee");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

/** Занести/поправить расход воды/стаканчиков/крышек по точке за сегодня. */
export async function recordCoffeeConsumable(input: {
  locationId: string;
  loggedDate: string;
  water?: number;
  cups?: number;
  lids?: number;
}): Promise<ActionResult> {
  try {
    await core.recordCoffeeConsumable(input);
    revalidatePath("/coffee");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

/** Отметить мойку/обслуживание бункера или точки целиком. */
export async function recordCoffeeWash(input: { locationId: string; position?: number; note?: string }): Promise<ActionResult> {
  try {
    await core.recordCoffeeWash({ ...input, performedBy: "panel" });
    revalidatePath("/coffee");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

/** Пересчёт остатка ингредиента на складе (грамм) — расхождение с прошлым уходит в ответ. */
export async function ingestCoffeeStock(ingredientId: string, quantity: number): Promise<ActionResult> {
  try {
    await core.ingestCoffeeStock({ items: [{ ingredientId, quantity }] });
    revalidatePath("/coffee");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}
