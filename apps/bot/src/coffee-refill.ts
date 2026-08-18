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
import { visitFromFlow, visitKeyboard, type VisitState } from "./coffee-visit";
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
  | { kind: "dupSkip" }
  | { kind: "dupWrite" }
  | { kind: "cancel" };

export function parseCoffeeRefillCallback(data: string): CoffeeRefillCallback | null {
  if (data === "cf:cancel") return { kind: "cancel" };
  const loc = /^cf:loc:([0-9a-f-]{36})$/.exec(data);
  if (loc) return { kind: "location", id: loc[1] };
  const pos = /^cf:pos:([1-8])$/.exec(data);
  if (pos) return { kind: "position", position: Number(pos[1]) };
  if (data === "cf:dup:skip") return { kind: "dupSkip" };
  if (data === "cf:dup:write") return { kind: "dupWrite" };
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
    case "dup":
      return "Такая запись уже есть — ответь кнопкой: повтор или вторая заливка.";
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
  const current = deps.conversations.get(chatId);

  if (cb.kind === "cancel") {
    // Кнопка «Отмена» живёт на КАЖДОМ экране заливки, и старые экраны остаются
    // в чате. Нажатие на устаревший из них не должно гасить то, чем человек
    // занят сейчас: слот беседы один, и раньше «Отмена» с прошлого экрана
    // уносила набранные расходники или чужой мастер целиком.
    if (current !== null && current.flow !== "coffee-refill") {
      return { answer: "Кнопка устарела", message: { text: "Эта кнопка от прошлого шага — она уже не действует." } };
    }
    // Бросаем заливку, но НЕ обход — если обход НАЧАЛСЯ (на точке уже есть
    // записи). Мастер, открытый напрямую из меню, обходом не является:
    // «Отмена» в нём ведёт к выбору точки, иначе человек, промахнувшийся
    // точкой, оказался бы заперт на ней без кнопки выбора другой.
    const visit = visitFromFlow(current);
    if (visit) {
      deps.conversations.start(chatId, "coffee-visit", "menu", { ...visit });
      return {
        answer: "Отменено",
        message: { text: `Заливку отменил. Ты на точке «${visit.locationName}».`, keyboard: visitKeyboard(visit) },
      };
    }
    deps.conversations.clear(chatId);
    return { answer: "Отменено", message: { text: "Заливку отменил." } };
  }

  const conv = current;
  if (conv?.flow !== "coffee-refill") {
    // Двойное «✅ Готово» по медленной сети: первое нажатие записало заливку и
    // перевело беседу в МЕНЮ ТОЧКИ. Говорить «начни заново» поверх «✅ Записал»
    // значит толкать на второй ввод — ровно на тот дубль, от которого мы
    // защищаемся. Но «уже сохранена» можно говорить ТОЛЬКО из меню точки:
    // из другого мастера сюда попадает и брошенная без записи заливка
    // (человек ушёл в расходники нижней кнопкой), и врать «сохранена» про
    // незаписанное — худшее, что бот может сказать про вес.
    if (conv?.flow === "coffee-visit") {
      const visit = visitFromFlow(conv);
      if (visit) {
        return {
          answer: "Уже записано",
          message: {
            text: `Эта заливка уже сохранена. Ты на точке «${visit.locationName}».`,
            keyboard: visitKeyboard(visit),
          },
        };
      }
    }
    if (conv === null) {
      return { answer: "Визард истёк", message: { text: "Заливка прервалась. Начни заново: «бункер»." } };
    }
    return { answer: "Кнопка устарела", message: { text: "Этот экран уже неактуален. Продолжай там, где остановился." } };
  }

  if (cb.kind === "location") {
    const locations = await deps.core.coffeeLocations();
    const loc = locations.find((l) => l.id === cb.id);
    if (!loc) return { answer: "Точка не найдена", message: { text: "Этой точки уже нет — начни заново." } };
    deps.conversations.advance(chatId, "position", { locationId: loc.id, locationName: loc.name });
    return { answer: loc.name, message: await positionStep(deps, loc.name, "cf") };
  }

  if (cb.kind === "dupSkip") {
    // Повтор: ничего не пишем, но и обход не роняем — человек стоит у машины.
    const visit: VisitState = {
      locationId: String(conv.data.locationId ?? ""),
      locationName: String(conv.data.locationName ?? ""),
      refills: typeof conv.data.refills === "number" ? conv.data.refills : 0,
      consumables: conv.data.consumables === true,
      started: conv.data.started === true,
    };
    deps.conversations.start(chatId, "coffee-visit", "menu", { ...visit });
    return {
      answer: "Не записал",
      edit: { text: "🔁 Понял, это повтор — второй раз не записал.", keyboard: visitKeyboard(visit) },
    };
  }

  if (cb.kind === "dupWrite") {
    deps.conversations.advance(chatId, "weight", { dupConfirmed: true });
    const done = await saveRefill(chatId, person, deps);
    return { answer: "Записал", edit: done };
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
      step === "container" ? containerStep(position, next) : step === "before" ? beforeStep(next) : weightStep(position, next);
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
    deps.conversations.advance(chatId, "weight", { filledWeight: weight, draft: "" });
    const done = await saveRefill(chatId, person, deps);
    return { answer: "Записал", edit: done };
  }

  if (step === "dup") {
    return { answer: "Ответь кнопкой: повтор или вторая заливка" };
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

/** Ввод веса после засыпки — последний шаг, сохраняет заливку. */
export async function handleCoffeeRefillWeight(
  chatId: number,
  text: string,
  deps: CoffeeDeps,
  person?: PersonRow,
): Promise<StaffReply> {
  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== "coffee-refill" || conv.step !== "weight") return { text: coffeeRefillStepHint("") };
  const weight = parseAmount(text);
  if (weight === null || weight <= 0) {
    return { text: "Не понял число. Напиши вес в граммах, например 1600." };
  }
  deps.conversations.advance(chatId, "weight", { filledWeight: weight, draft: "" });
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
  const containerNumber = typeof conv.data.containerNumber === "number" ? conv.data.containerNumber : null;
  const measuredBefore = typeof conv.data.measuredBefore === "number" ? conv.data.measuredBefore : null;

  if (!locationId || !Number.isFinite(position) || !Number.isFinite(filledWeight)) {
    deps.conversations.clear(chatId);
    return { text: "Данные заливки потерялись — начни заново: «бункер»." };
  }

  // Защита от повтора. Сегодня в базе две пары записей, совпадающих ДО ГРАММА
  // (та же точка, тот же бункер, тот же набор, тот же вес, час спустя). Два
  // разных взвешивания так не совпадают — это повторный ввод: человек не понял,
  // что запись прошла, и внёс заново. Спрашиваем, а не решаем за него: вторая
  // заливка того же бункера за день бывает, просто не с точностью до грамма.
  if (conv.data.dupConfirmed !== true) {
    const twin = await findTwin({ locationId, position, containerNumber, filledWeight }, deps);
    if (twin) {
      deps.conversations.advance(chatId, "dup", {});
      return {
        text: [
          `⚠️ Такая же запись уже есть за сегодня:`,
          `бункер ${position}${containerNumber === null ? "" : `, набор ${containerNumber}`}, ${filledWeight} г.`,
          "",
          "Это повтор или ты залил бункер второй раз?",
        ].join("\n"),
        keyboard: {
          inline_keyboard: [
            [{ text: "🔁 Это повтор — не записывать", callback_data: "cf:dup:skip" }],
            [{ text: "✅ Вторая заливка — записать", callback_data: "cf:dup:write" }],
          ],
        },
      };
    }
  }

  // Разговор стираем ПОСЛЕ успешной записи, а не до.
  //
  // Раньше clear() стоял выше вызова Core. Отвалилась сеть (таймаут 10 с, без
  // ретраев) — пять введённых чисел исчезали вместе с разговором: техник у
  // автомата видел исчезающий тост, а на текстовом пути вообще тишину, и
  // уходил с точки, ничего не записав. Теперь ввод переживает сбой, и «Готово»
  // можно нажать повторно, ничего не набирая заново.
  // Ингредиент — из конфига бункеров по позиции. Без него сверка «ожидали
  // против налили» читает 0 из 1150 строк и молчит по каждой. Позиция с ДВУМЯ
  // ингредиентами (в конфиге такая есть) остаётся пустой: угаданное списание
  // хуже отсутствующего — его никто не перепроверит.
  const ingredientId = await ingredientForPosition(position, deps);

  try {
    await deps.core.submitCoffeeRefill({
      locationId,
      position,
      ...(ingredientId !== null ? { ingredientId } : {}),
      ...(containerNumber !== null ? { containerNumber } : {}),
      ...(measuredBefore !== null ? { measuredBefore } : {}),
      filledWeight,
      enteredDate: todayIso(),
      createdBy: `person:${person.id}`,
    });
  } catch {
    // Возвращаем черновик упаковок: без него повторное «Готово» упрётся в
    // «набери число» — набор-то очищен переходом на шаг.
    deps.conversations.advance(chatId, "weight", { draft: String(filledWeight) });
    return {
      text: [
        "⚠️ Не записал — сервер не ответил.",
        `Всё набранное цело: бункер ${position}, ${filledWeight} г${containerNumber === null ? "" : `, набор ${containerNumber}`}.`,
        "Нажми «✅ Готово» ещё раз через минуту — заново вводить не надо.",
      ].join("\n"),
      keyboard: weightStep(position, String(filledWeight)).keyboard,
    };
  }
  deps.conversations.clear(chatId);

  // Обход продолжается: точка остаётся выбранной, дальше — ещё бункер,
  // расходники или «завершить». Заново называть ту же точку не нужно.
  const refills = (typeof conv.data.refills === "number" ? conv.data.refills : 0) + 1;
  const visit: VisitState = {
    locationId,
    locationName,
    refills,
    consumables: conv.data.consumables === true,
    // Запись прошла — обход НАЧАЛСЯ. Только этот момент (и cc:save) даёт
    // право «Отмене» возвращать в меню точки, а не к выбору точки.
    started: true,
  };
  deps.conversations.start(chatId, "coffee-visit", "menu", { ...visit });

  const summary = await refillSummary(
    { locationName, position, containerNumber, measuredBefore, filledWeight },
    deps,
  );
  return { text: summary, keyboard: visitKeyboard(visit) };
}

/**
 * Сколько это упаковок — по весу пачки ингредиента. Дробь оставляем: «1,5» это
 * и есть правда про полторы пачки, а округление до двух её потеряет.
 */
async function packagesFor(position: number, netGrams: number, deps: CoffeeDeps): Promise<string | null> {
  try {
    const config = await deps.core.coffeeBunkerConfig();
    const here = config.filter((c) => c.position === position && (c.packageWeight ?? 0) > 0);
    if (here.length === 0) return null;

    // На позиции может стоять несколько ингредиентов (позиция 3 держит и
    // лимонный чай, и матчу — техник заправляет то, что есть на складе).
    // Если расфасовка у них ОДИНАКОВАЯ, ответ не зависит от того, что именно
    // засыпали, и молчать незачем. Разная — молчим: показать «1 упаковка»,
    // когда для второго ингредиента это две, значит соврать уверенным тоном.
    const per = here[0].packageWeight ?? 0;
    const label = here[0].packageLabel ?? "упаковки";
    const sameForAll = here.every((c) => (c.packageWeight ?? 0) === per && (c.packageLabel ?? "упаковки") === label);
    if (!sameForAll) return null;
    // Штуки — целые: полстика не бывает. Пачки — с десятой долей: половина и
    // полторы пачки это ровно то, что происходит на точке.
    const raw = netGrams / per;
    const value = label === "шт" ? Math.round(raw) : Math.round(raw * 10) / 10;
    if (value <= 0) return null;
    return `${String(value).replace(".", ",")} ${plural(value, label)}`;
  } catch {
    return null;
  }
}

/**
 * Склонение единицы: «1 упаковка», «2 упаковки», «5 упаковок», «1,5 упаковки».
 *
 * Без этого выходило «≈ 1 упаковки» — мелочь, по которой сразу видно, что
 * текст писала программа, а не человек. Полевой инструмент читают на бегу, и
 * доверие к нему складывается из таких мелочей. Своя подпись («шт») не
 * склоняется вовсе.
 */
function plural(value: number, label: string): string {
  if (label !== "упаковки") return label;
  if (!Number.isInteger(value)) return "упаковки"; // 1,5 упаковки
  const n = Math.abs(value) % 100;
  if (n >= 11 && n <= 14) return "упаковок";
  const last = n % 10;
  if (last === 1) return "упаковка";
  if (last >= 2 && last <= 4) return "упаковки";
  return "упаковок";
}

/**
 * Такая же заливка уже есть сегодня? Сверяем точку, позицию, набор и вес: два
 * разных взвешивания не совпадают до грамма.
 */
async function findTwin(
  r: { locationId: string; position: number; containerNumber: number | null; filledWeight: number },
  deps: CoffeeDeps,
): Promise<boolean> {
  try {
    const today = todayIso();
    const recent = await deps.core.recentRefills(60);
    return recent.some(
      (x) =>
        x.enteredDate === today &&
        x.locationId === r.locationId &&
        x.position === r.position &&
        x.filledWeight === r.filledWeight &&
        (x.containerNumber ?? null) === r.containerNumber,
    );
  } catch {
    // Не смогли проверить — записываем. Потерять заливку из-за недоступной
    // проверки хуже, чем пропустить дубль: дубль виден и правится, потеря нет.
    return false;
  }
}

/**
 * Ингредиент позиции. Однозначен — возвращаем; двусмыслен или неизвестен — null.
 * Сеть отвалилась — тоже null: заливку из-за справочника терять нельзя.
 */
async function ingredientForPosition(position: number, deps: CoffeeDeps): Promise<string | null> {
  try {
    const config = await deps.core.coffeeBunkerConfig();
    const here = config.filter((c) => c.position === position && c.ingredientId);
    return here.length === 1 ? (here[0].ingredientId ?? null) : null;
  } catch {
    return null;
  }
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
  } else if (net <= 0) {
    // Ингредиента не может быть ноль или меньше: значит взвесили не то, не тот
    // набор или промахнулись разрядом. Назвать такое «чистым весом» и велеть
    // вносить в автомат — прямая команда испортить остаток в системе. В базе
    // проекта таких строк уже 63 (худшая даёт −639 г), так что случай не
    // выдуманный. Запись оставляем — факт взвешивания был, врать о нём нельзя.
    lines.push(`⚠️ Не сходится: вес с бункером ${r.filledWeight} г, а пустой набор ${r.containerNumber} весит ${tare} г.`);
    lines.push("В систему автомата ЭТО НЕ ВНОСИ. Проверь номер набора и перевесь.");
    lines.push("Ошибся — жми «↩️ Ошибся — исправить».");
  } else {
    lines.push(`☕ Чистый ингредиент: ${net} г — это и вноси в систему автомата`);
    if (netBefore !== null && r.measuredBefore !== null) {
      const added = net - netBefore;
      // Досыпали меньше нуля — физически невозможно: либо «до» и «после»
      // переставлены местами, либо из бункера отсыпали. Показать «-600» как
      // обычную цифру значило бы узаконить ошибку в отчётах.
      lines.push(
        added >= 0
          ? `Было ${netBefore} г → стало ${net} г (досыпали ${added} г)`
          : `⚠️ Было ${netBefore} г, стало ${net} г — стало МЕНЬШЕ. Проверь, не перепутал ли замеры.`,
      );
    }
    lines.push(`Вес с бункером ${r.filledWeight} г − тара набора ${r.containerNumber} (${tare} г)`);
  }
  // Упаковки СЧИТАЕМ, а не спрашиваем: техник сыплет и половину пачки, и
  // полторы, и просить его округлить значило бы записывать округление как факт.
  // Вес пачки не задан — строки просто нет: выдуманное число хуже отсутствия.
  const packs = net !== null && net > 0 ? await packagesFor(r.position, net, deps) : null;
  if (packs !== null) lines.push(`≈ ${packs} по весу`);
  return lines.join("\n");
}

/**
 * Ещё один бункер на той же точке: сразу к позиции, точку не переспрашиваем.
 * Ради этого и заведён обход — см. coffee-visit.ts.
 */
export async function continueVisitRefill(
  chatId: number,
  visit: VisitState,
  deps: CoffeeDeps,
): Promise<StaffReply> {
  // Спрашиваем Core ДО подмены беседы. Раньше состояние обхода уже уезжало
  // внутрь заливки, а следом падал запрос конфига — и повторное нажатие
  // «Ещё бункер» не находило обхода: человек оставался и без клавиатуры
  // бункеров, и без меню точки, с четырьмя записанными заливками в никуда.
  const step = await positionStep(deps, visit.locationName, "cf");
  deps.conversations.start(chatId, "coffee-refill", "position", {
    locationId: visit.locationId,
    locationName: visit.locationName,
    refills: visit.refills,
    consumables: visit.consumables,
    started: visit.started,
    draft: "",
  });
  return step;
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
    const current = deps.conversations.get(chatId);
    // Тот же шаблон, что у заливки: «Отмена» с чужого экрана не гасит текущее
    // дело, «Отмена» посреди обхода возвращает в меню точки. Мойка была
    // единственным кофейным мастером со слепым clear — и её старый экран
    // уносил обход целиком.
    if (current !== null && current.flow !== "coffee-wash") {
      return { answer: "Кнопка устарела", message: { text: "Эта кнопка от прошлого шага — она уже не действует." } };
    }
    const visit = visitFromFlow(current);
    if (visit) {
      deps.conversations.start(chatId, "coffee-visit", "menu", { ...visit });
      return {
        answer: "Отменено",
        message: { text: `Мойку отменил. Ты на точке «${visit.locationName}».`, keyboard: visitKeyboard(visit) },
      };
    }
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
  if (!locationId) {
    deps.conversations.clear(chatId);
    return { answer: "Данные потерялись", message: { text: "Начни заново: «помыл»." } };
  }

  await deps.core.recordCoffeeWash({
    locationId,
    position: cb.position,
    kind: "wash",
    performedBy: `person:${person.id}`,
  });
  // Разговор стираем ПОСЛЕ успешной записи, а не до — тот же принцип, что в
  // saveRefill: иначе сбой Core оставлял человека с советом «попробуй ещё
  // раз», который упирался в «Визард истёк», а «начни заново» дублировал
  // мойку, если сбой был таймаутом при успехе на сервере.
  deps.conversations.clear(chatId);
  return {
    answer: "Записал",
    message: { text: `✅ Мойка отмечена: «${locationName}», бункер ${cb.position}.` },
  };
}
