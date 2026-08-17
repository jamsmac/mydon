import { netWeight, TZ } from "@mydon/shared";
import type { CoreClient, PersonRow } from "./core-client";
import type { Conversations } from "./conversation";
import {
  applyPress,
  numpadKeyboard,
  numpadText,
  parseNumpadCallback,
  type NumpadPress,
} from "./numpad";
import type { StaffReply } from "./staff";

/**
 * Ежедневная заливка кофейного бункера прямо в Telegram: техник обходит
 * точки и вносит вес на месте, как со складом (staff-inventory.ts) — тот же
 * приём, короткий поток на бегу:
 *   точка → позиция бункера (1–8) → вес → упаковки → набор (необязательно).
 *
 * Числа набираются кнопками (numpad.ts) и правятся на месте: сообщение
 * перерисовывается на каждое нажатие, поэтому весь мастер живёт в ОДНОМ
 * сообщении, а не в ленте из десяти. Текстовый ввод сохранён — привычка писать
 * «1234» руками работает как раньше.
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
    inline_keyboard: [
      ...locations.slice(0, 30).map((l) => [{ text: l.name.slice(0, 40), callback_data: `${prefix}:loc:${l.id}` }]),
      [{ text: "✖️ Отмена", callback_data: `${prefix}:cancel` }],
    ],
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
  rows.push([{ text: "✖️ Отмена", callback_data: `${prefix}:cancel` }]);
  return { inline_keyboard: rows };
}

export type CoffeeRefillCallback =
  | { kind: "location"; id: string }
  | { kind: "position"; position: number }
  | { kind: "num"; press: NumpadPress }
  | { kind: "cancel" };

export function parseCoffeeRefillCallback(data: string): CoffeeRefillCallback | null {
  if (data === "cf:cancel") return { kind: "cancel" };
  const loc = /^cf:loc:([0-9a-f-]{36})$/.exec(data);
  if (loc) return { kind: "location", id: loc[1] };
  const pos = /^cf:pos:([1-8])$/.exec(data);
  if (pos) return { kind: "position", position: Number(pos[1]) };
  const press = parseNumpadCallback("cf", data);
  if (press) return { kind: "num", press };
  return null;
}

// ── Шаги ввода чисел: один вид и для кнопок, и после текстового ответа ───────

/**
 * Набор спрашиваем ВТОРЫМ, до весов, а не последним.
 *
 * Тара откалибрована по паре «набор + позиция», и без номера набора чистый вес
 * ингредиента посчитать нечем. Спрашивая набор в конце, мы узнавали бы, что
 * посчитать нельзя, уже после того как человек всё взвесил.
 */
function containerStep(position: number, draft = ""): StaffReply {
  return {
    text: numpadText(`Бункер ${position}. Какой набор (номер контейнера 1–27)?`, draft),
    keyboard: numpadKeyboard("cf", { skip: true }),
  };
}

/**
 * Замер ДО досыпки. Бункер редко бывает пуст: в нём остаются старые остатки, и
 * без этого замера «стало 1000» не отвечает на вопрос, сколько именно досыпали.
 * Пустой бункер — «— пропустить»: тогда добавленное равно всему содержимому.
 */
function beforeStep(draft = ""): StaffReply {
  return {
    text: numpadText(
      "Сколько весил бункер ДО досыпки, с остатком?\n(пустой бункер — «пропустить»)",
      draft,
      "г",
    ),
    keyboard: numpadKeyboard("cf", { skip: true }),
  };
}

/** Вес обязателен — «пропустить» на нём нет: молча потерянный вес хуже вопроса. */
function weightStep(position: number, draft = ""): StaffReply {
  return {
    text: numpadText(`Бункер ${position}. Сколько весит ПОСЛЕ засыпки, с бункером?`, draft, "г"),
    keyboard: numpadKeyboard("cf"),
  };
}

function packagesStep(draft = ""): StaffReply {
  return {
    text: numpadText("Сколько упаковок ушло на засыпку?", draft, "уп."),
    keyboard: numpadKeyboard("cf", { skip: true }),
  };
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
    case "container":
      return "Какой набор (номер контейнера 1–27)? Число, или «-», если не знаешь.";
    case "before":
      return "Сколько весил бункер ДО досыпки, с остатком? Число, или «-» если пустой.";
    case "weight":
      return "Напиши вес ПОСЛЕ засыпки, с бункером, граммы (например 1600). «отмена» — бросить.";
    case "packages":
      return "Сколько упаковок ушло? Число, или «-», если не считал (тогда запишем 1).";
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
  person: PersonRow,
  deps: CoffeeDeps,
): Promise<{ answer: string; message?: StaffReply; edit?: StaffReply }> {
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

  if (cb.kind === "position") {
    deps.conversations.advance(chatId, "container", { position: cb.position, draft: "" });
    return { answer: `Бункер ${cb.position}`, message: containerStep(cb.position) };
  }

  return numpadPress(chatId, cb.press, conv.step, String(conv.data.draft ?? ""), person, deps);
}

/**
 * Нажатие цифровой клавиатуры. Цифра и «⌫» перерисовывают ТО ЖЕ сообщение —
 * иначе набор четырёхзначного веса оставил бы в чате четыре сообщения подряд.
 * Переход на следующий шаг тоже перерисовка: мастер живёт одним сообщением.
 */
async function numpadPress(
  chatId: number,
  press: NumpadPress,
  step: string,
  draft: string,
  person: PersonRow,
  deps: CoffeeDeps,
): Promise<{ answer: string; message?: StaffReply; edit?: StaffReply }> {
  const position = Number(deps.conversations.get(chatId)?.data.position ?? 0);

  if (press.kind === "digit" || press.kind === "erase") {
    const next = applyPress(draft, press);
    deps.conversations.advance(chatId, step, { draft: next });
    const view =
      step === "container"
        ? containerStep(position, next)
        : step === "before"
          ? beforeStep(next)
          : step === "weight"
            ? weightStep(position, next)
            : packagesStep(next);
    // Тот же текст Telegram редактировать откажется («message is not modified»),
    // поэтому пустое нажатие («⌫» на пустом наборе) не выдаём за изменение.
    if (next === draft) return { answer: "Пусто" };
    return { answer: next === "" ? "—" : next, edit: view };
  }

  if (step === "container") {
    let containerNumber: number | null = null;
    if (press.kind !== "skip") {
      const n = Math.round(parseAmount(draft) ?? NaN);
      if (!Number.isFinite(n) || n < 1 || n > 27) return { answer: "Набор — число 1–27" };
      containerNumber = n;
    }
    deps.conversations.advance(chatId, "before", { containerNumber, draft: "" });
    return { answer: containerNumber === null ? "Без набора" : `Набор ${containerNumber}`, edit: beforeStep() };
  }

  if (step === "before") {
    let measuredBefore: number | null = null;
    if (press.kind !== "skip") {
      const n = parseAmount(draft);
      if (n === null || n <= 0) return { answer: "Набери вес или «пропустить»" };
      measuredBefore = n;
    }
    deps.conversations.advance(chatId, "weight", { measuredBefore, draft: "" });
    return {
      answer: measuredBefore === null ? "Бункер был пуст" : `Было ${measuredBefore} г`,
      edit: weightStep(position),
    };
  }

  if (step === "weight") {
    if (press.kind === "skip") return { answer: "Вес обязателен" };
    const weight = parseAmount(draft);
    if (weight === null || weight <= 0) return { answer: "Сначала набери вес" };
    deps.conversations.advance(chatId, "packages", { filledWeight: weight, draft: "" });
    return { answer: `${weight} г`, edit: packagesStep() };
  }

  if (step === "packages") {
    const packageCount = press.kind === "skip" ? 1 : Math.round(parseAmount(draft) ?? NaN);
    if (!Number.isFinite(packageCount) || packageCount < 1) return { answer: "Набери число или «пропустить»" };
    deps.conversations.advance(chatId, "packages", { packageCount, draft: "" });
    const done = await saveRefill(chatId, person, deps);
    return { answer: "Записал", edit: done };
  }

  return { answer: "Не сейчас" };
}

/** Ввод номера набора — второй шаг: без него тару не взять и нетто не посчитать. */
export async function handleCoffeeRefillContainer(
  chatId: number,
  text: string,
  _person: PersonRow,
  deps: CoffeeDeps,
): Promise<StaffReply> {
  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== "coffee-refill" || conv.step !== "container") return { text: coffeeRefillStepHint("") };
  let containerNumber: number | null = null;
  if (!isSkip(text)) {
    const n = Math.round(parseAmount(text) ?? NaN);
    if (!Number.isFinite(n) || n < 1 || n > 27) {
      return { text: "Набор — число 1–27, или «-», если не знаешь." };
    }
    containerNumber = n;
  }
  deps.conversations.advance(chatId, "before", { containerNumber, draft: "" });
  return beforeStep();
}

/** Замер ДО досыпки. «-» — бункер был пуст. */
export async function handleCoffeeRefillBefore(chatId: number, text: string, deps: CoffeeDeps): Promise<StaffReply> {
  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== "coffee-refill" || conv.step !== "before") return { text: coffeeRefillStepHint("") };
  let measuredBefore: number | null = null;
  if (!isSkip(text)) {
    const n = parseAmount(text);
    if (n === null || n <= 0) return { text: "Не понял число. Вес бункера до досыпки в граммах, или «-» если пустой." };
    measuredBefore = n;
  }
  deps.conversations.advance(chatId, "weight", { measuredBefore, draft: "" });
  return weightStep(Number(conv.data.position));
}

/** Ввод веса после засыпки. */
export async function handleCoffeeRefillWeight(chatId: number, text: string, deps: CoffeeDeps): Promise<StaffReply> {
  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== "coffee-refill" || conv.step !== "weight") return { text: coffeeRefillStepHint("") };
  const weight = parseAmount(text);
  if (weight === null) return { text: "Не понял число. Напиши вес в граммах, например 1200." };
  deps.conversations.advance(chatId, "packages", { filledWeight: weight, draft: "" });
  return packagesStep();
}

/** Ввод числа упаковок — последний шаг, сохраняет заливку. */
export async function handleCoffeeRefillPackages(
  chatId: number,
  text: string,
  deps: CoffeeDeps,
  person?: PersonRow,
): Promise<StaffReply> {
  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== "coffee-refill" || conv.step !== "packages") return { text: coffeeRefillStepHint("") };
  const packageCount = isSkip(text) ? 1 : Math.round(parseAmount(text) ?? NaN);
  if (!Number.isFinite(packageCount) || packageCount < 1) {
    return { text: "Не понял число упаковок. Напиши целое число (например 2) или «-»." };
  }
  deps.conversations.advance(chatId, "packages", { packageCount, draft: "" });
  if (!person) return { text: coffeeRefillStepHint("") };
  return saveRefill(chatId, person, deps);
}

/**
 * Сохранение заливки — общий конец для обоих способов ввода. Кнопки и текст
 * обязаны писать ОДНО И ТО ЖЕ: разъехавшись, они дали бы две записи с разными
 * полями и «зависит от того, как вносил» в отчётах.
 */
async function saveRefill(chatId: number, person: PersonRow, deps: CoffeeDeps): Promise<StaffReply> {
  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== "coffee-refill") return { text: coffeeRefillStepHint("") };

  const locationId = String(conv.data.locationId ?? "");
  const locationName = String(conv.data.locationName ?? "");
  const position = Number(conv.data.position);
  const filledWeight = Number(conv.data.filledWeight);
  const packageCount = Number(conv.data.packageCount);
  const containerNumber = typeof conv.data.containerNumber === "number" ? conv.data.containerNumber : null;
  const measuredBefore = typeof conv.data.measuredBefore === "number" ? conv.data.measuredBefore : null;
  deps.conversations.clear(chatId);

  if (!locationId || !Number.isFinite(position) || !Number.isFinite(filledWeight)) {
    return { text: "Данные заливки потерялись — начни заново: «бункер»." };
  }

  await deps.core.submitCoffeeRefill({
    locationId,
    position,
    ...(containerNumber !== null ? { containerNumber } : {}),
    ...(measuredBefore !== null ? { measuredBefore } : {}),
    filledWeight,
    packageCount,
    enteredDate: todayIso(),
    createdBy: `person:${person.id}`,
  });

  return {
    text: await refillSummary(
      { locationName, position, containerNumber, measuredBefore, filledWeight, packageCount },
      deps,
    ),
  };
}

/**
 * Итог заливки. Главная строка — ЧИСТЫЙ вес ингредиента, а не тот, что на весах.
 *
 * Кладовщик взвешивает бункер целиком: внутри ингредиент, снаружи сам бункер
 * (600–680 г в зависимости от набора и позиции). Оператору на точке это число
 * бесполезно: в систему автомата он вносит остаток ИНГРЕДИЕНТА. Пересчёт в уме
 * на морозе у автомата — источник ошибок, поэтому считает бот.
 *
 * Тара не откалибрована или набор не назван — честно говорим, что чистый вес
 * неизвестен, вместо того чтобы показать брутто как будто это нетто.
 */
async function refillSummary(
  r: {
    locationName: string;
    position: number;
    containerNumber: number | null;
    measuredBefore: number | null;
    filledWeight: number;
    packageCount: number;
  },
  deps: CoffeeDeps,
): Promise<string> {
  let tare: number | null = null;
  if (r.containerNumber !== null) {
    try {
      const grid = await deps.core.coffeeTare();
      tare =
        grid.find((t) => t.containerNumber === r.containerNumber && t.position === r.position)?.tareWeight ?? null;
    } catch {
      tare = null; // Тару не спросили — заливка уже записана, молчать о ней нельзя.
    }
  }

  const net = netWeight(r.filledWeight, tare);
  const netBefore = r.measuredBefore === null ? 0 : netWeight(r.measuredBefore, tare);

  const lines = [`✅ Записал: «${r.locationName}», бункер ${r.position}`];
  if (net === null) {
    lines.push(`Вес с бункером: ${r.filledWeight} г`);
    lines.push(
      r.containerNumber === null
        ? "⚠️ Набор не назван — чистый вес не посчитать."
        : `⚠️ Тара набора ${r.containerNumber} не откалибрована — чистый вес не посчитать.`,
    );
  } else {
    lines.push(`☕ Чистый ингредиент: ${net} г — это и вноси в систему автомата`);
    if (netBefore !== null && r.measuredBefore !== null) {
      lines.push(`Было ${netBefore} г → стало ${net} г (досыпали ${net - netBefore} г)`);
    }
    lines.push(`Вес с бункером ${r.filledWeight} г − тара набора ${r.containerNumber} (${tare} г)`);
  }
  lines.push(`Упаковок: ${r.packageCount}`);
  return lines.join("\n");
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
