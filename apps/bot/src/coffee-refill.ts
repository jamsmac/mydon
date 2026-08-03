import { TZ } from "@mydon/shared";
import type { CoreClient, PersonRow } from "./core-client";
import type { Conversations } from "./conversation";
import type { StaffReply } from "./staff";

/**
 * Ежедневная заливка кофейного бункера прямо в Telegram: техник обходит
 * точки и вносит вес на месте, как со складом (staff-inventory.ts) — тот же
 * приём, короткий поток на бегу:
 *   точка → позиция бункера (1–8) → вес → упаковки → набор (необязательно).
 *
 * Дата не спрашивается — берётся «сегодня» по проектному часовому поясу
 * (TZ=Asia/Tashkent, контейнер уже в нём живёт, как и весь остальной учёт):
 * технику заносить факт на месте, а не выбирать дату из календаря на бегу.
 */

export interface CoffeeDeps {
  core: CoreClient;
  conversations: Conversations;
}

/** Слова, которыми техник начинает заливку. */
export function isCoffeeRefillTrigger(text: string): boolean {
  return /бункер|засыпал|залил.*кофе|кофе.*залил/i.test(text.trim());
}

/** Слова, которыми техник отмечает мойку/обслуживание. */
export function isCoffeeWashTrigger(text: string): boolean {
  return /помыл|мойка бункер|почистил бункер|кофемашин.*мо[йю]/i.test(text.trim());
}

/** Сегодняшняя дата ISO (YYYY-MM-DD) в проектном часовом поясе. */
export function todayIso(now = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: TZ }); // en-CA даёт YYYY-MM-DD
}

/** Разбор числа: «1200», «1200.5» — вес и количество могут быть дробными в исходнике редко, но не мешает принять. */
export function parseAmount(text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** «-» или пусто — техник пропускает необязательное поле. */
function isSkip(text: string): boolean {
  return /^[-—]$/.test(text.trim());
}

function locationKeyboard(locations: { id: string; name: string }[], prefix: "cf" | "cw"): NonNullable<StaffReply["keyboard"]> {
  return {
    inline_keyboard: locations.slice(0, 30).map((l) => [{ text: l.name.slice(0, 40), callback_data: `${prefix}:loc:${l.id}` }]),
  };
}

function positionKeyboard(config: { position: number; ingredientName: string }[], prefix: "cf" | "cw"): NonNullable<StaffReply["keyboard"]> {
  const byPos = new Map<number, string[]>();
  for (const c of config) byPos.set(c.position, [...(byPos.get(c.position) ?? []), c.ingredientName]);
  const rows: { text: string; callback_data: string }[][] = [];
  for (let pos = 1; pos <= 8; pos++) {
    const names = byPos.get(pos);
    const label = names && names.length > 0 ? `${pos} · ${names.join("/")}` : `${pos} · пусто`;
    rows.push([{ text: label.slice(0, 60), callback_data: `${prefix}:pos:${pos}` }]);
  }
  return { inline_keyboard: rows };
}

export type CoffeeRefillCallback =
  | { kind: "location"; id: string }
  | { kind: "position"; position: number }
  | { kind: "cancel" };

export function parseCoffeeRefillCallback(data: string): CoffeeRefillCallback | null {
  if (data === "cf:cancel") return { kind: "cancel" };
  const loc = /^cf:loc:([0-9a-f-]{36})$/.exec(data);
  if (loc) return { kind: "location", id: loc[1] };
  const pos = /^cf:pos:([1-8])$/.exec(data);
  if (pos) return { kind: "position", position: Number(pos[1]) };
  return null;
}

export type CoffeeWashCallback =
  | { kind: "location"; id: string }
  | { kind: "position"; position: number }
  | { kind: "cancel" };

export function parseCoffeeWashCallback(data: string): CoffeeWashCallback | null {
  if (data === "cw:cancel") return { kind: "cancel" };
  const loc = /^cw:loc:([0-9a-f-]{36})$/.exec(data);
  if (loc) return { kind: "location", id: loc[1] };
  const pos = /^cw:pos:([1-8])$/.exec(data);
  if (pos) return { kind: "position", position: Number(pos[1]) };
  return null;
}

export function coffeeRefillStepHint(step: string): string {
  switch (step) {
    case "location":
      return "Выбери точку кнопкой.";
    case "position":
      return "Выбери позицию бункера кнопкой.";
    case "weight":
      return "Напиши вес после засыпки, граммы (например 1200). «отмена» — бросить.";
    case "packages":
      return "Сколько упаковок ушло? Число, или «-», если не считал (тогда запишем 1).";
    case "container":
      return "Какой набор (номер контейнера 1–27)? Число, или «-», если не знаешь.";
    default:
      return "Продолжай по кнопкам.";
  }
}

/** Начать заливку: выбрать точку. */
export async function startCoffeeRefill(chatId: number, deps: CoffeeDeps): Promise<StaffReply> {
  const locations = await deps.core.coffeeLocations();
  const active = locations.filter((l) => l.isActive);
  if (active.length === 0) {
    return { text: "Точек с кофемашинами в реестре пока нет — скажи владельцу." };
  }
  deps.conversations.start(chatId, "coffee-refill", "location");
  return { text: "Какая точка?", keyboard: locationKeyboard(active, "cf") };
}

async function positionStep(deps: CoffeeDeps, locationName: string, prefix: "cf" | "cw"): Promise<StaffReply> {
  const config = await deps.core.coffeeBunkerConfig();
  return { text: `Точка «${locationName}». Какой бункер?`, keyboard: positionKeyboard(config, prefix) };
}

export async function handleCoffeeRefillCallback(
  chatId: number,
  cb: CoffeeRefillCallback,
  _person: PersonRow,
  deps: CoffeeDeps,
): Promise<{ answer: string; message?: StaffReply }> {
  if (cb.kind === "cancel") {
    deps.conversations.clear(chatId);
    return { answer: "Отменено", message: { text: "Заливку отменил." } };
  }

  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== "coffee-refill") {
    return { answer: "Визард истёк", message: { text: "Заливка прервалась. Начни заново: «бункер»." } };
  }

  if (cb.kind === "location") {
    const locations = await deps.core.coffeeLocations();
    const loc = locations.find((l) => l.id === cb.id);
    if (!loc) return { answer: "Точка не найдена", message: { text: "Этой точки уже нет — начни заново." } };
    deps.conversations.advance(chatId, "position", { locationId: loc.id, locationName: loc.name });
    return { answer: loc.name, message: await positionStep(deps, loc.name, "cf") };
  }

  // cb.kind === "position" — просим вес.
  deps.conversations.advance(chatId, "weight", { position: cb.position });
  return { answer: `Бункер ${cb.position}`, message: { text: `Бункер ${cb.position}. Сколько весит после засыпки, грамм?` } };
}

/** Ввод веса — текстовый шаг визарда. */
export async function handleCoffeeRefillWeight(chatId: number, text: string, deps: CoffeeDeps): Promise<StaffReply> {
  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== "coffee-refill" || conv.step !== "weight") return { text: coffeeRefillStepHint("") };
  const weight = parseAmount(text);
  if (weight === null) return { text: "Не понял число. Напиши вес в граммах, например 1200." };
  deps.conversations.advance(chatId, "packages", { filledWeight: weight });
  return { text: "Сколько упаковок ушло на засыпку? Число, или «-», если не считал." };
}

/** Ввод числа упаковок. */
export async function handleCoffeeRefillPackages(chatId: number, text: string, deps: CoffeeDeps): Promise<StaffReply> {
  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== "coffee-refill" || conv.step !== "packages") return { text: coffeeRefillStepHint("") };
  const packageCount = isSkip(text) ? 1 : Math.round(parseAmount(text) ?? NaN);
  if (!Number.isFinite(packageCount) || packageCount < 1) {
    return { text: "Не понял число упаковок. Напиши целое число (например 2) или «-»." };
  }
  deps.conversations.advance(chatId, "container", { packageCount });
  return { text: "Какой набор (номер контейнера 1–27)? Число, или «-», если не знаешь." };
}

/** Ввод номера набора (контейнера) — последний шаг, сохраняет заливку. */
export async function handleCoffeeRefillContainer(
  chatId: number,
  text: string,
  person: PersonRow,
  deps: CoffeeDeps,
): Promise<StaffReply> {
  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== "coffee-refill" || conv.step !== "container") return { text: coffeeRefillStepHint("") };

  let containerNumber: number | undefined;
  if (!isSkip(text)) {
    const n = Math.round(parseAmount(text) ?? NaN);
    if (!Number.isFinite(n) || n < 1 || n > 27) {
      return { text: "Набор — число 1–27, или «-», если не знаешь." };
    }
    containerNumber = n;
  }

  const locationId = String(conv.data.locationId ?? "");
  const locationName = String(conv.data.locationName ?? "");
  const position = Number(conv.data.position);
  const filledWeight = Number(conv.data.filledWeight);
  const packageCount = Number(conv.data.packageCount);
  deps.conversations.clear(chatId);

  if (!locationId || !Number.isFinite(position) || !Number.isFinite(filledWeight)) {
    return { text: "Данные заливки потерялись — начни заново: «бункер»." };
  }

  await deps.core.submitCoffeeRefill({
    locationId,
    position,
    ...(containerNumber !== undefined ? { containerNumber } : {}),
    filledWeight,
    packageCount,
    enteredDate: todayIso(),
    createdBy: `person:${person.id}`,
  });

  const набор = containerNumber !== undefined ? `, набор ${containerNumber}` : "";
  return {
    text: `✅ Записал: «${locationName}», бункер ${position}, ${filledWeight}г, ${packageCount} уп.${набор}.`,
  };
}

// ── Мойка/обслуживание: короче — точка → бункер (или «вся машина») → готово ──

export async function startCoffeeWash(chatId: number, deps: CoffeeDeps): Promise<StaffReply> {
  const locations = await deps.core.coffeeLocations();
  const active = locations.filter((l) => l.isActive);
  if (active.length === 0) {
    return { text: "Точек с кофемашинами в реестре пока нет — скажи владельцу." };
  }
  deps.conversations.start(chatId, "coffee-wash", "location");
  return { text: "Мойка какой точки?", keyboard: locationKeyboard(active, "cw") };
}

export async function handleCoffeeWashCallback(
  chatId: number,
  cb: CoffeeWashCallback,
  person: PersonRow,
  deps: CoffeeDeps,
): Promise<{ answer: string; message?: StaffReply }> {
  if (cb.kind === "cancel") {
    deps.conversations.clear(chatId);
    return { answer: "Отменено", message: { text: "Мойку отменил." } };
  }

  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== "coffee-wash") {
    return { answer: "Визард истёк", message: { text: "Отметка мойки прервалась. Начни заново: «помыл»." } };
  }

  if (cb.kind === "location") {
    const locations = await deps.core.coffeeLocations();
    const loc = locations.find((l) => l.id === cb.id);
    if (!loc) return { answer: "Точка не найдена", message: { text: "Этой точки уже нет — начни заново." } };
    deps.conversations.advance(chatId, "position", { locationId: loc.id, locationName: loc.name });
    return { answer: loc.name, message: await positionStep(deps, loc.name, "cw") };
  }

  // cb.kind === "position" — сразу сохраняем, шагов больше нет.
  const locationId = String(conv.data.locationId ?? "");
  const locationName = String(conv.data.locationName ?? "");
  deps.conversations.clear(chatId);
  if (!locationId) return { answer: "Данные потерялись", message: { text: "Начни заново: «помыл»." } };

  await deps.core.recordCoffeeWash({
    locationId,
    position: cb.position,
    kind: "wash",
    performedBy: `person:${person.id}`,
  });
  return {
    answer: "Записал",
    message: { text: `✅ Мойка отмечена: «${locationName}», бункер ${cb.position}.` },
  };
}
