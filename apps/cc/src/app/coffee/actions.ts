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
    revalidatePath("/domain/vendhub");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

/** Добавить ингредиент в позицию бункера (Настройки). */
export async function addBunkerIngredient(position: number, ingredientName: string): Promise<ActionResult> {
  try {
    await core.addCoffeeBunkerIngredient(position, ingredientName);
    revalidatePath("/domain/vendhub");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

/** Убрать ингредиент из позиции бункера (крестик в Настройках). */
export async function removeBunkerIngredient(position: number, ingredientId: string): Promise<ActionResult> {
  try {
    await core.removeCoffeeBunkerIngredient(position, ingredientId);
    revalidatePath("/domain/vendhub");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

/** Поправить закупочную цену ингредиента (сум за грамм) — для себестоимости расхода. */
export async function setCoffeeIngredientPrice(ingredientId: string, purchasePrice: number): Promise<ActionResult> {
  try {
    await core.setCoffeeIngredientPrice(ingredientId, purchasePrice);
    revalidatePath("/domain/vendhub");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

/** Поправить эталонный чистый вес заливки (недолив-сигнал) для (позиция, ингредиент). */
export async function setCoffeeTargetFillWeight(position: number, ingredientId: string, targetFillWeight: number): Promise<ActionResult> {
  try {
    await core.setCoffeeTargetFillWeight(position, ingredientId, targetFillWeight);
    revalidatePath("/domain/vendhub");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

/** Поправить тару одной ячейки (набор × позиция) — «Веса бункеров» в Настройках. */
export async function setCoffeeTare(containerNumber: number, position: number, tareWeight: number): Promise<ActionResult> {
  try {
    await core.setCoffeeTare(containerNumber, position, tareWeight);
    revalidatePath("/domain/vendhub");
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
    revalidatePath("/domain/vendhub");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

/** Отметить мойку/обслуживание бункера или точки целиком. */
export async function recordCoffeeWash(input: { locationId: string; position?: number; note?: string }): Promise<ActionResult> {
  try {
    await core.recordCoffeeWash({ ...input, performedBy: "panel" });
    revalidatePath("/domain/vendhub");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

/** Пересчёт остатка ингредиента на складе (грамм) — расхождение с прошлым уходит в ответ. */
export async function ingestCoffeeStock(ingredientId: string, quantity: number): Promise<ActionResult> {
  try {
    await core.ingestCoffeeStock({ items: [{ ingredientId, quantity }] });
    revalidatePath("/domain/vendhub");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

/** Завести/поправить план обслуживания (частота по дням и/или по чашкам). */
export async function setCoffeeWashSchedule(input: {
  locationId: string;
  position?: number;
  frequencyDays?: number;
  frequencyCups?: number;
}): Promise<ActionResult> {
  try {
    await core.setCoffeeWashSchedule(input);
    revalidatePath("/domain/vendhub");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

/** Удалить план обслуживания. */
export async function removeCoffeeWashSchedule(id: string): Promise<ActionResult> {
  try {
    await core.removeCoffeeWashSchedule(id);
    revalidatePath("/domain/vendhub");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

/** Завести кофе-точку из панели (Настройки → Точки). */
export async function createCoffeeLocation(name: string): Promise<ActionResult> {
  try {
    await core.createCoffeeLocation(name);
    revalidatePath("/domain/vendhub");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

/** Переименовать / включить-выключить кофе-точку. */
export async function updateCoffeeLocation(
  id: string,
  patch: { name?: string; isActive?: boolean },
): Promise<ActionResult> {
  try {
    await core.updateCoffeeLocation(id, patch);
    revalidatePath("/domain/vendhub");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

/** Удалить ошибочную заливку — строка целиком уходит в audit_log. */
export async function deleteCoffeeRefill(id: string): Promise<ActionResult> {
  try {
    await core.deleteCoffeeRefill(id);
    revalidatePath("/domain/vendhub");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

/** Удалить ошибочный возврат набора — строка целиком уходит в audit_log. */
export async function deleteCoffeeContainerReturn(id: string): Promise<ActionResult> {
  try {
    await core.deleteCoffeeContainerReturn(id);
    revalidatePath("/domain/vendhub");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

/** Привязать/отвязать кофе-точку от карточки автомата реестра (Настройки). */
export async function linkCoffeeLocation(locationId: string, entityId: string | null): Promise<ActionResult> {
  try {
    await core.linkCoffeeLocation(locationId, entityId);
    revalidatePath("/domain/vendhub");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

/** Автопривязка точек по названию — только однозначные совпадения. */
export async function autoLinkCoffeeLocations(): Promise<ActionResult> {
  try {
    const res = await core.autoLinkCoffeeLocations();
    revalidatePath("/domain/vendhub");
    const parts = [`привязано: ${res.linked}`];
    if (res.ambiguous.length > 0) parts.push(`неоднозначно: ${res.ambiguous.join(", ")}`);
    if (res.unmatched.length > 0) parts.push(`не найдено: ${res.unmatched.join(", ")}`);
    return { ok: true, message: parts.join(" · ") };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

/**
 * Завести задачу по сигналу вкладки «Сверка» (недолив/расхождение/просроченная
 * мойка) — та же очередь, что «Быстрые действия» дашборда VendHub: домен
 * vendhub, срок завтра, высокий приоритет, исполнитель — тот же, что и там
 * (первый активный человек направления), правится в карточке задачи.
 */
export async function createCoffeeAlertTask(input: {
  title: string;
  description: string;
  ownerRef: string | null;
}): Promise<ActionResult> {
  try {
    await core.createTask({
      title: input.title,
      description: input.description,
      domain: "vendhub",
      ownerKind: "human",
      ownerRef: input.ownerRef ?? "",
      priority: "high",
      source: "coffee-alert",
      createdBy: "panel",
      due: new Date(Date.now() + 24 * 3600_000).toISOString(),
    });
    revalidatePath("/domain/vendhub");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}
