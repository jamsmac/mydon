import type { StaffReply } from "./staff";

/**
 * Цифровая клавиатура для полевого ввода чисел.
 *
 * Зачем кнопки там, где есть текстовое поле: техник стоит у автомата, телефон
 * в одной руке, бункер в другой. Текстовый ввод требует трёх точных действий —
 * открыть клавиатуру, попасть по мелким цифрам, попасть по «отправить». Крупная
 * inline-кнопка нажимается большим пальцем не глядя, а набранное видно прямо в
 * сообщении: промахнулся — «⌫», а не переписывать строку целиком.
 *
 * Текстовый ввод НЕ отменяется. Кто привык слать «1234» словами — шлёт как
 * раньше; клавиатура добавляет способ, а не отбирает прежний. Полевой инструмент
 * нельзя менять «в один день на новый»: половина смены узнает об этом у автомата.
 *
 * Раскладка телефонная (1-2-3 сверху), а не калькуляторная (7-8-9 сверху):
 * на телефоне цифры набирают в звонилке, и мышечная память у людей оттуда.
 */

/** Предел набора: вес бункера — четыре цифры, пять с запасом. Шестая — промах. */
export const NUMPAD_MAX_DIGITS = 5;

export type NumpadPress =
  | { kind: "digit"; digit: string }
  | { kind: "erase" }
  | { kind: "done" }
  | { kind: "skip" };

/**
 * Разбор нажатия. Префикс тот же, что у остального визарда (`cf`), чтобы
 * пространства колбэков не пересекались между мастерами.
 */
export function parseNumpadCallback(prefix: string, data: string): NumpadPress | null {
  const head = `${prefix}:n:`;
  if (!data.startsWith(head)) return null;
  const tail = data.slice(head.length);
  if (tail === "del") return { kind: "erase" };
  if (tail === "ok") return { kind: "done" };
  if (tail === "skip") return { kind: "skip" };
  return /^[0-9]$/.test(tail) ? { kind: "digit", digit: tail } : null;
}

/**
 * Новое состояние набора. Ведущие нули не копим: «007» и «7» — одно число, а
 * лишние нули на экране читаются как чужой формат номера набора.
 */
export function applyPress(draft: string, press: NumpadPress): string {
  if (press.kind === "erase") return draft.slice(0, -1);
  if (press.kind !== "digit") return draft;
  if (draft.length >= NUMPAD_MAX_DIGITS) return draft;
  const next = draft + press.digit;
  return next.replace(/^0+(?=\d)/, "");
}

/**
 * Клавиатура. «⌫» и «✅» в одном ряду с нулём — большой палец не уходит с
 * нижней строки, где он и так лежит.
 */
export function numpadKeyboard(
  prefix: string,
  opts: { skip?: boolean; cancel?: boolean } = {},
): NonNullable<StaffReply["keyboard"]> {
  const key = (t: string, d: string) => ({ text: t, callback_data: `${prefix}:n:${d}` });
  const rows = [
    [key("1", "1"), key("2", "2"), key("3", "3")],
    [key("4", "4"), key("5", "5"), key("6", "6")],
    [key("7", "7"), key("8", "8"), key("9", "9")],
    [key("⌫", "del"), key("0", "0"), key("✅ Готово", "ok")],
  ];
  if (opts.skip === true) rows.push([key("— пропустить", "skip")]);
  if (opts.cancel !== false) rows.push([{ text: "✖️ Отмена", callback_data: `${prefix}:cancel` }]);
  return { inline_keyboard: rows };
}

/**
 * Текст над клавиатурой. Пустой набор показываем прочерком, а не нулём: ноль —
 * это введённое значение, а прочерк честно говорит «ещё ничего не набрано».
 */
export function numpadText(title: string, draft: string, unit = ""): string {
  const shown = draft === "" ? "—" : `${draft}${unit === "" ? "" : ` ${unit}`}`;
  return `${title}\n\nНабрано: ${shown}`;
}
