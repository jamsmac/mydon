import type { CoreClient, EntityRow, PersonRow } from "./core-client";
import type { Conversations } from "./conversation";
import { applyPress, NUMPAD_MAX_DIGITS, numpadKeyboard, numpadText, parseNumpadCallback, type NumpadPress } from "./numpad";
import { newRunId } from "./staff-refill";
import type { StaffReply } from "./staff";

/**
 * Инвентаризация склада прямо в Telegram: сотрудник выбирает склад, ингредиент,
 * видит текущий остаток и вводит фактическое количество. Разницу («стало −
 * было») сервер записывает движением-корректировкой — прежние движения не
 * трогаются, история пересчётов видна.
 *
 * Поток короткий, чтобы делать на бегу у полок:
 *   склад → ингредиент → (показываем остаток) → факт числом → корректировка.
 */

export interface InventoryDeps {
  core: CoreClient;
  conversations: Conversations;
}

/** Слова, которыми сотрудник начинает пересчёт. */
export function isInventoryTrigger(text: string): boolean {
  return /инвентар|переуч[её]т|пересч[её]т|пересчита/i.test(text.trim());
}

/**
 * Разбор введённого количества: принимаем «12», «12.5» и «12,5» (запятая —
 * привычный десятичный разделитель). Отрицательное и мусор — не число.
 */
export function parseQty(text: string): number | null {
  const t = text.trim().replace(",", ".").replace(/\s+/g, "");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Короткая запись количества без хвостовых нулей. */
export function fmtQty(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/** Клавиатура выбора (склад/ингредиент). Префикс задаёт пространство callback. */
function pickKeyboard(items: EntityRow[], kind: "wh" | "ing"): NonNullable<StaffReply["keyboard"]> {
  return {
    inline_keyboard: [
      ...items.slice(0, 30).map((it) => [{ text: it.name.slice(0, 40), callback_data: `i:${kind}:${it.id}` }]),
      // Парсер «i:cancel» был с самого начала, а кнопки не было: выйти из
      // мастера можно было только словом «отмена», о котором надо знать.
      [{ text: "✖️ Отмена", callback_data: "i:cancel" }],
    ],
  };
}

export type InventoryCallback =
  | { kind: "warehouse"; id: string }
  | { kind: "ingredient"; id: string }
  | { kind: "num"; press: NumpadPress }
  | { kind: "cancel" };

/** Строгий разбор нажатия. Данные кнопки приходят снаружи — доверять нельзя. */
export function parseInventoryCallback(data: string): InventoryCallback | null {
  if (data === "i:cancel") return { kind: "cancel" };
  const wh = /^i:wh:([0-9a-f-]{36})$/.exec(data);
  if (wh) return { kind: "warehouse", id: wh[1] };
  const ing = /^i:ing:([0-9a-f-]{36})$/.exec(data);
  if (ing) return { kind: "ingredient", id: ing[1] };
  const press = parseNumpadCallback("i", data);
  if (press) return { kind: "num", press };
  return null;
}

/** Подсказка, когда ждут кнопку/число, а сотрудник пишет иное. */
export function inventoryStepHint(step: string): string {
  switch (step) {
    case "warehouse":
      return "Выбери склад кнопкой.";
    case "ingredient":
      return "Выбери ингредиент кнопкой.";
    case "count":
      return "Напиши фактическое количество числом (например 8 или 8.5). «отмена» — бросить.";
    default:
      return "Продолжай по кнопкам.";
  }
}

/** Начать инвентаризацию: выбрать склад. */
export async function startInventory(chatId: number, deps: InventoryDeps): Promise<StaffReply> {
  const whs = await deps.core.warehouses();
  if (whs.length === 0) {
    return { text: "Складов в реестре пока нет — скажи владельцу." };
  }
  // Один склад — не спрашиваем, сразу к ингредиенту.
  if (whs.length === 1) {
    deps.conversations.start(chatId, "inventory", "ingredient", { warehouseId: whs[0].id, warehouseName: whs[0].name, runId: newRunId() });
    return ingredientStep(chatId, deps, whs[0].name);
  }
  deps.conversations.start(chatId, "inventory", "warehouse", { runId: newRunId() });
  return { text: "Какой склад считаем?", keyboard: pickKeyboard(whs, "wh") };
}

/** Шаг выбора ингредиента: общий для «один склад» и «выбрали склад». */
async function ingredientStep(chatId: number, deps: InventoryDeps, warehouseName: string): Promise<StaffReply> {
  const ings = await deps.core.ingredients();
  if (ings.length === 0) {
    deps.conversations.clear(chatId);
    return { text: "Ингредиентов в реестре пока нет — сначала заведи их («новый ингредиент»)." };
  }
  const note = ings.length > 30 ? "\n(показаны первые 30)" : "";
  return { text: `Склад «${warehouseName}». Какой ингредиент?${note}`, keyboard: pickKeyboard(ings, "ing") };
}

/** Нажатие кнопки инвентаризации: склад, ингредиент, нумпад, отмена. */
export async function handleInventoryCallback(
  chatId: number,
  cb: InventoryCallback,
  person: PersonRow,
  deps: InventoryDeps,
): Promise<{ answer: string; message?: StaffReply; edit?: StaffReply }> {
  if (cb.kind === "cancel") {
    // Барьер #149, распространённый на некофейные мастера: «Отмена» с чужого
    // устаревшего экрана не должна гасить текущее дело — слот беседы один,
    // а кнопки живут в чате вечно.
    const current = deps.conversations.get(chatId);
    if (current !== null && current.flow !== "inventory") {
      return { answer: "Кнопка устарела", message: { text: "Эта кнопка от прошлого шага — она уже не действует." } };
    }
    deps.conversations.clear(chatId);
    return { answer: "Отменено", message: { text: "Инвентаризацию отменил." } };
  }

  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== "inventory") {
    // Нумпад устаревшего экрана — без совета «начни заново»: после успешной
    // записи он звучал бы как приглашение к повторной корректировке.
    if (cb.kind === "num") {
      return { answer: "Экран устарел", message: { text: "Этот нумпад уже неактуален. Если пересчёт не записан — начни заново: «инвентаризация»." } };
    }
    return { answer: "Визард истёк", message: { text: "Пересчёт прервался. Начни заново: «инвентаризация»." } };
  }

  if (cb.kind === "num") {
    if (conv.step !== "count") {
      // «saving» — идёт запись по первому тапу: второй не должен ни писать,
      // ни пугать.
      return { answer: conv.step === "saving" ? "Уже записываю…" : "Не сейчас" };
    }
    const draft = String(conv.data.draft ?? "");
    if (cb.press.kind === "digit" || cb.press.kind === "erase") {
      const next = applyPress(draft, cb.press);
      if (next === draft) {
        return { answer: cb.press.kind === "digit" ? `Не больше ${NUMPAD_MAX_DIGITS} цифр` : "Пусто" };
      }
      deps.conversations.advance(chatId, "count", { draft: next });
      return { answer: next === "" ? "—" : next, edit: countScreen(conv.data, next) };
    }
    if (cb.press.kind !== "done") return { answer: "Не сейчас" };
    if (draft === "") return { answer: "Набери число" };
    // Двойной тап «Готово»: помечаем «пишу» ДО запроса — повтор увидит шаг
    // saving и не создаст вторую корректировку.
    deps.conversations.advance(chatId, "saving", {});
    try {
      return { answer: draft, edit: await saveInventoryCount(chatId, Number(draft), person, deps) };
    } catch (err) {
      deps.conversations.advance(chatId, "count", { draft });
      throw err;
    }
  }

  if (cb.kind === "warehouse") {
    const whs = await deps.core.warehouses();
    const wh = whs.find((w) => w.id === cb.id);
    if (!wh) return { answer: "Склад не найден", message: { text: "Этого склада уже нет — начни заново." } };
    deps.conversations.advance(chatId, "ingredient", { warehouseId: wh.id, warehouseName: wh.name });
    return { answer: wh.name, message: await ingredientStep(chatId, deps, wh.name) };
  }

  // cb.kind === "ingredient": показываем остаток и ждём факт.
  const warehouseId = String(conv.data.warehouseId ?? "");
  if (!warehouseId) {
    return { answer: "Сначала склад", message: { text: "Склад не выбран — начни заново." } };
  }
  const bal = await deps.core.stockBalance(warehouseId, cb.id);
  if (!bal.baseUnit) {
    deps.conversations.clear(chatId);
    return {
      answer: "Нет единицы",
      message: {
        text: `У «${bal.ingredientName}» не задана единица измерения — инвентаризация невозможна, пока её не укажут.`,
      },
    };
  }
  const known = bal.qty ?? 0;
  const warn = bal.unconvertible > 0 ? `\n⚠️ ${bal.unconvertible} движ. в несводимой единице — остаток неполон.` : "";
  // Заголовок шага храним в беседе: нумпад перерисовывает экран на каждом
  // нажатии, и остаток «по учёту» должен оставаться перед глазами.
  const header =
    `«${bal.ingredientName}» на складе «${bal.warehouseName}».\n` +
    `Сейчас по учёту: ${fmtQty(known)} ${bal.baseUnit}.${warn}\n\n` +
    "Сколько по факту?";
  deps.conversations.advance(chatId, "count", {
    ingredientId: cb.id,
    ingredientName: bal.ingredientName,
    baseUnit: bal.baseUnit,
    countHeader: header,
    draft: "",
  });
  // Нумпад — тот же полевой способ ввода, что у заливки: способ ввода числа
  // не должен зависеть от раздела. Дробные («10.5») по-прежнему текстом —
  // текстовый канал не отнимается.
  return {
    answer: bal.ingredientName,
    message: { text: numpadText(header, "", bal.baseUnit), keyboard: numpadKeyboard("i") },
  };
}

/** Экран набора числа — перерисовка при каждом нажатии нумпада. */
function countScreen(data: Record<string, unknown>, draft: string): StaffReply {
  return {
    text: numpadText(String(data.countHeader ?? "Сколько по факту?"), draft, String(data.baseUnit ?? "")),
    keyboard: numpadKeyboard("i"),
  };
}

/** Ввод фактического количества текстом: тот же путь, что у нумпада. */
export async function handleInventoryCount(
  chatId: number,
  text: string,
  person: PersonRow,
  deps: InventoryDeps,
): Promise<StaffReply> {
  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== "inventory" || conv.step !== "count") {
    return { text: inventoryStepHint("") };
  }
  const actual = parseQty(text);
  if (actual === null) {
    return { text: "Не понял число. Напиши количество, например 8 или 8.5." };
  }
  return saveInventoryCount(chatId, actual, person, deps);
}

/** Общий конец для текста и нумпада: корректировка + итог одним видом. */
async function saveInventoryCount(
  chatId: number,
  actual: number,
  person: PersonRow,
  deps: InventoryDeps,
): Promise<StaffReply> {
  const conv = deps.conversations.get(chatId);
  const warehouseId = String(conv?.data.warehouseId ?? "");
  const ingredientId = String(conv?.data.ingredientId ?? "");
  const baseUnit = String(conv?.data.baseUnit ?? "");
  if (!warehouseId || !ingredientId) {
    deps.conversations.clear(chatId);
    return { text: "Данные пересчёта потерялись — начни заново: «инвентаризация»." };
  }

  // Ключ идемпотентности: повтор того же факта в том же заходе — повтор
  // нажатия; вторая корректировка «стало − было» при гонке не появляется.
  const runId = typeof conv?.data.runId === "string" ? conv.data.runId : null;
  const res = await deps.core.stocktake({
    warehouseId,
    ingredientId,
    actual,
    unit: baseUnit || undefined,
    ...(runId ? { clientKey: `ic:${runId}:${actual}` } : {}),
    countedBy: `person:${person.id}`,
  });
  deps.conversations.clear(chatId);

  if (!res.changed) {
    return {
      text: `«${res.ingredientName}»: факт совпал с учётом (${fmtQty(res.actual)} ${res.unit}). Корректировка не нужна ✅`,
    };
  }
  const sign = res.delta > 0 ? `+${fmtQty(res.delta)}` : fmtQty(res.delta);
  const kind = res.delta > 0 ? "излишек" : "недостача";
  return {
    text:
      `📋 Пересчёт «${res.ingredientName}» на «${res.warehouseName}»:\n` +
      `было ${fmtQty(res.before)} → стало ${fmtQty(res.actual)} ${res.unit} (${sign}, ${kind}).\n` +
      "Корректировка записана ✅",
  };
}
