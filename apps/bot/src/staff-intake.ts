import type { CoreClient, EntityRow, PersonRow } from "./core-client";
import type { Conversations } from "./conversation";
import type { StaffReply } from "./staff";
import { fmtQty, parseQty } from "./staff-inventory";

/**
 * Приход сырья по уже заведённой карточке — прямо в Telegram.
 *
 * Зеркало инвентаризации, но движение — `intake` (склад пополняется), а не
 * корректировка. Сотрудник принял мешок зёрен: выбрал существующий ингредиент,
 * склад, ввёл сколько пришло — приход в ленте, остаток вырос. Цену/поставщика
 * владелец допишет в панели: у полок их обычно не знают, и держать ими ввод
 * значило бы, что приход просто не отметят.
 *
 *   склад → ингредиент → (показываем остаток) → сколько пришло → приход.
 */

export interface IntakeDeps {
  core: CoreClient;
  conversations: Conversations;
}

/** Слова, которыми сотрудник начинает приход. */
export function isIntakeTrigger(text: string): boolean {
  return /приход|пришл[оаи]|завоз|поступил|приняли?\s+товар/i.test(text.trim());
}

/** Клавиатура выбора (склад/ингредиент). Префикс «n:» — своё пространство. */
function pickKeyboard(items: EntityRow[], kind: "wh" | "ing"): NonNullable<StaffReply["keyboard"]> {
  return {
    inline_keyboard: [
      ...items.slice(0, 30).map((it) => [{ text: it.name.slice(0, 40), callback_data: `n:${kind}:${it.id}` }]),
      [{ text: "✖️ Отмена", callback_data: "n:cancel" }],
    ],
  };
}

export type IntakeCallback =
  | { kind: "warehouse"; id: string }
  | { kind: "ingredient"; id: string }
  | { kind: "cancel" };

/** Строгий разбор нажатия. Данные кнопки приходят снаружи — доверять нельзя. */
export function parseIntakeCallback(data: string): IntakeCallback | null {
  if (data === "n:cancel") return { kind: "cancel" };
  const wh = /^n:wh:([0-9a-f-]{36})$/.exec(data);
  if (wh) return { kind: "warehouse", id: wh[1] };
  const ing = /^n:ing:([0-9a-f-]{36})$/.exec(data);
  if (ing) return { kind: "ingredient", id: ing[1] };
  return null;
}

/** Подсказка, когда ждут кнопку/число, а сотрудник пишет иное. */
export function intakeStepHint(step: string): string {
  switch (step) {
    case "warehouse":
      return "Выбери склад кнопкой.";
    case "ingredient":
      return "Выбери ингредиент кнопкой.";
    case "count":
      return "Напиши, сколько пришло, числом (например 10 или 10.5). «отмена» — бросить.";
    default:
      return "Продолжай по кнопкам.";
  }
}

/** Начать приход: выбрать склад. */
export async function startIntake(chatId: number, deps: IntakeDeps): Promise<StaffReply> {
  const whs = await deps.core.warehouses();
  if (whs.length === 0) {
    return { text: "Складов в реестре пока нет — скажи владельцу." };
  }
  if (whs.length === 1) {
    deps.conversations.start(chatId, "intake", "ingredient", { warehouseId: whs[0].id, warehouseName: whs[0].name });
    return ingredientStep(chatId, deps, whs[0].name);
  }
  deps.conversations.start(chatId, "intake", "warehouse");
  return { text: "На какой склад пришло?", keyboard: pickKeyboard(whs, "wh") };
}

async function ingredientStep(chatId: number, deps: IntakeDeps, warehouseName: string): Promise<StaffReply> {
  const ings = await deps.core.ingredients();
  if (ings.length === 0) {
    deps.conversations.clear(chatId);
    return { text: "Ингредиентов в реестре пока нет — сначала заведи их («новый ингредиент»)." };
  }
  const note = ings.length > 30 ? "\n(показаны первые 30)" : "";
  return { text: `Склад «${warehouseName}». Что пришло?${note}`, keyboard: pickKeyboard(ings, "ing") };
}

/** Нажатие кнопки прихода: склад, ингредиент, отмена. */
export async function handleIntakeCallback(
  chatId: number,
  cb: IntakeCallback,
  _person: PersonRow,
  deps: IntakeDeps,
): Promise<{ answer: string; message?: StaffReply }> {
  if (cb.kind === "cancel") {
    deps.conversations.clear(chatId);
    return { answer: "Отменено", message: { text: "Приход отменил." } };
  }

  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== "intake") {
    return { answer: "Визард истёк", message: { text: "Приход прервался. Начни заново: «приход»." } };
  }

  if (cb.kind === "warehouse") {
    const whs = await deps.core.warehouses();
    const wh = whs.find((w) => w.id === cb.id);
    if (!wh) return { answer: "Склад не найден", message: { text: "Этого склада уже нет — начни заново." } };
    deps.conversations.advance(chatId, "ingredient", { warehouseId: wh.id, warehouseName: wh.name });
    return { answer: wh.name, message: await ingredientStep(chatId, deps, wh.name) };
  }

  // cb.kind === "ingredient": показываем остаток и ждём количество.
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
        text: `У «${bal.ingredientName}» не задана единица измерения — приход невозможен, пока её не укажут.`,
      },
    };
  }
  deps.conversations.advance(chatId, "count", {
    ingredientId: cb.id,
    ingredientName: bal.ingredientName,
    baseUnit: bal.baseUnit,
  });
  const known = bal.qty ?? 0;
  return {
    answer: bal.ingredientName,
    message: {
      text:
        `«${bal.ingredientName}» на складе «${bal.warehouseName}».\n` +
        `Сейчас по учёту: ${fmtQty(known)} ${bal.baseUnit}.\n\n` +
        `Сколько пришло? Напиши число в ${bal.baseUnit}.`,
    },
  };
}

/** Ввод количества прихода: пишем движение и показываем новый остаток. */
export async function handleIntakeCount(
  chatId: number,
  text: string,
  person: PersonRow,
  deps: IntakeDeps,
): Promise<StaffReply> {
  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== "intake" || conv.step !== "count") {
    return { text: intakeStepHint("") };
  }
  const qty = parseQty(text);
  if (qty === null || qty === 0) {
    return { text: "Не понял число. Напиши, сколько пришло, например 10 или 10.5." };
  }
  const warehouseId = String(conv.data.warehouseId ?? "");
  const ingredientId = String(conv.data.ingredientId ?? "");
  const baseUnit = String(conv.data.baseUnit ?? "");
  const ingredientName = String(conv.data.ingredientName ?? "ингредиент");
  if (!warehouseId || !ingredientId || !baseUnit) {
    deps.conversations.clear(chatId);
    return { text: "Данные прихода потерялись — начни заново: «приход»." };
  }

  await deps.core.addIntake({
    warehouseId,
    ingredientId,
    qty,
    unit: baseUnit,
    createdBy: `person:${person.id}`,
  });
  deps.conversations.clear(chatId);

  // Новый остаток — чтобы сотрудник видел итог, а не только «записал».
  const bal = await deps.core.stockBalance(warehouseId, ingredientId);
  const now = bal.qty !== null ? ` Стало ${fmtQty(bal.qty)} ${baseUnit}.` : "";
  return {
    text: `📦 Приход записан: +${fmtQty(qty)} ${baseUnit} «${ingredientName}».${now} ✅`,
  };
}
