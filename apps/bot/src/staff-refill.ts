import type { CoreClient, PersonRow } from "./core-client";
import type { Conversations } from "./conversation";
import type { StaffReply } from "./staff";

/**
 * Заливка снек/дринк-автомата прямо в Telegram (WAREHOUSE_SPEC §5.2).
 *
 *   объект → товар → сколько → [ещё товар | готово]
 *
 * Ключевое отличие от остальных мастеров: позиция пишется в Core СРАЗУ, а не
 * копится до «Готово». Техник обходит автомат с 3–6 позициями, и связь в
 * подвале ТЦ отваливается посреди обхода. Копили бы — потеряли бы всё
 * введённое; пишем сразу — теряется максимум текущая позиция.
 *
 * Отсюда же и отмена, которая не отменяет записанное: она заканчивает обход,
 * а не стирает факты. Мастер говорит об этом словами, чтобы техник не решил,
 * будто «Отмена» откатила всё.
 *
 * Кофейные бункеры сюда не входят: у них свой ключ (точка, позиция 1–8) и вес
 * вместо штук — отдельный мастер `coffee-refill.ts`.
 */

export interface RefillDeps {
  core: CoreClient;
  conversations: Conversations;
}

/** Слова, которыми сотрудник начинает заливку автомата. */
export function isRefillTrigger(text: string): boolean {
  return /заполнил|заправил|загрузил.*автомат|пополнил/i.test(text.trim());
}

/**
 * Количество: целые штуки. Дробь не принимаем осознанно — половины батончика
 * в слоте не бывает, а «12.5» почти всегда опечатка в «125».
 */
export function parseCount(text: string): number | null {
  const t = text.trim().replace(/\s+/g, "");
  if (!/^\d{1,4}$/.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
}

/**
 * Ключ идемпотентности позиции.
 *
 * Складывается из id обхода (одна штука на весь мастер) и порядкового номера
 * позиции. Двойное нажатие «Готово» на одной позиции даёт тот же ключ — Core
 * вернёт прежнюю запись и не спишет склад дважды. Законная вторая заливка
 * того же слота идёт следующим номером и проходит как новая.
 */
export function refillClientKey(runId: string, index: number): string {
  return `rf:${runId}:${index}`;
}

/** Идентификатор обхода. Время + случайное: два техника на одном автомате. */
export function newRunId(now = Date.now(), rnd = Math.random): string {
  return `${now.toString(36)}${Math.floor(rnd() * 1e6).toString(36)}`;
}

export type RefillCallback =
  | { kind: "product"; name: string }
  | { kind: "more" }
  | { kind: "done" }
  | { kind: "other" }
  | { kind: "cancel" };

/**
 * Строгий разбор нажатия. Имя товара едет в callback_data закодированным:
 * лимит 64 байта, кириллица в UTF-8 занимает по два — поэтому индекс списка,
 * а не имя. Индекс валиден только вместе с сохранённым в визарде списком.
 */
export function parseRefillCallback(data: string): (RefillCallback & { index?: number }) | null {
  if (data === "rf:cancel") return { kind: "cancel" };
  if (data === "rf:more") return { kind: "more" };
  if (data === "rf:done") return { kind: "done" };
  if (data === "rf:other") return { kind: "other" };
  const p = /^rf:p:(\d{1,3})$/.exec(data);
  if (p) return { kind: "product", name: "", index: Number(p[1]) };
  return null;
}

/** Подсказка, когда ждут кнопку или число, а сотрудник пишет иное. */
export function refillStepHint(step: string): string {
  switch (step) {
    case "product":
      return "Выбери товар кнопкой или напиши его название.";
    case "count":
      return "Сколько штук загрузил? Ответь числом, например 12.";
    default:
      return "Выбери автомат кнопкой.";
  }
}

/**
 * Клавиатура выбора товара: сначала то, что стоит в этом автомате по зеркалу
 * Ourvend, потом «другой товар». Показывать весь справочник значит заставить
 * техника листать сотню позиций там, где нужны пять.
 */
export function productKeyboard(names: string[]): NonNullable<StaffReply["keyboard"]> {
  return {
    inline_keyboard: [
      ...names.slice(0, 20).map((n, i) => [{ text: n.slice(0, 40), callback_data: `rf:p:${i}` }]),
      [{ text: "🔎 Другой товар", callback_data: "rf:other" }],
      [{ text: "✖️ Отмена", callback_data: "rf:cancel" }],
    ],
  };
}

/** Клавиатура после записанной позиции: продолжить обход или закончить. */
export function afterItemKeyboard(): NonNullable<StaffReply["keyboard"]> {
  return {
    inline_keyboard: [
      [{ text: "➕ Ещё товар", callback_data: "rf:more" }],
      [{ text: "✅ Готово", callback_data: "rf:done" }],
    ],
  };
}

/** Строка итога обхода: что записано и сколько осталось на складе. */
export function summaryText(items: { product: string; qty: number; left: number | null }[]): string {
  if (items.length === 0) return "Ничего не записал.";
  const lines = items.map(
    (i) => `· ${i.product} — ${i.qty} шт.${i.left === null ? "" : ` (на складе ${i.left})`}`,
  );
  return [`Записал ${items.length} ${plural(items.length)}:`, ...lines].join("\n");
}

/** «позицию / позиции / позиций» — иначе бот говорит «записал 3 позицию». */
export function plural(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "позицию";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "позиции";
  return "позиций";
}

/**
 * Текст отмены. Отдельной функцией, потому что формулировка тут важнее кода:
 * техник, нажавший «Отмена» после трёх записанных позиций, должен понять, что
 * они на месте, а не искать их потом в панели.
 */
export function cancelText(recorded: number): string {
  return recorded === 0
    ? "Отменил, ничего не записано."
    : `Обход закончен. Записано ${recorded} ${plural(recorded)} — они сохранены.`;
}

/** Состояние обхода внутри визарда. */
export interface RefillState {
  runId: string;
  machineId: string;
  machineSerial: string;
  machineName: string;
  /** Индекс следующей позиции — он же часть ключа идемпотентности. */
  index: number;
  /** Что уже записано за обход: для итога и для текста отмены. */
  items: { product: string; qty: number; left: number | null }[];
  /** Список товаров зеркала, показанный кнопками: индекс → имя. */
  choices: string[];
  /** Товар текущей позиции, пока ждём количество. */
  pending?: string;
}

/** Разбор состояния из визарда: данные пришли из памяти, но форму проверяем. */
export function readState(data: Record<string, unknown>): RefillState | null {
  const s = data as Partial<RefillState>;
  if (typeof s.runId !== "string" || typeof s.machineSerial !== "string") return null;
  if (typeof s.index !== "number" || !Array.isArray(s.items) || !Array.isArray(s.choices)) return null;
  return {
    runId: s.runId,
    machineId: typeof s.machineId === "string" ? s.machineId : "",
    machineSerial: s.machineSerial,
    machineName: typeof s.machineName === "string" ? s.machineName : "автомат",
    index: s.index,
    items: s.items as RefillState["items"],
    choices: s.choices as string[],
    pending: typeof s.pending === "string" ? s.pending : undefined,
  };
}

/**
 * Записать позицию и вернуть ответ сотруднику.
 *
 * Ошибка Core не роняет обход: техник видит, что позиция не записана, и может
 * повторить её или продолжить. Потерять обход целиком из-за одной сетевой
 * ошибки — худшее, что можно сделать с человеком у открытого автомата.
 */
export async function recordItem(
  state: RefillState,
  qty: number,
  person: PersonRow,
  deps: RefillDeps,
): Promise<{ state: RefillState; reply: StaffReply }> {
  const product = state.pending ?? "";
  try {
    const res = await deps.core.createRefill({
      machineSerial: state.machineSerial,
      machineId: state.machineId || undefined,
      productName: product,
      qty,
      personId: person.id,
      clientKey: refillClientKey(state.runId, state.index),
      createdBy: `person:${person.id}`,
    });
    const next: RefillState = {
      ...state,
      index: state.index + 1,
      pending: undefined,
      items: [...state.items, { product, qty, left: res.stockLeft }],
    };
    const left =
      res.stockLeft === null
        ? ""
        : res.stockLeft < 0
          ? `\nНа складе ${res.stockLeft} — склад давно не пересчитывали.`
          : `\nНа складе осталось ${res.stockLeft}.`;
    return {
      state: next,
      reply: { text: `Записал: ${product} — ${qty} шт.${left}`, keyboard: afterItemKeyboard() },
    };
  } catch {
    // Позиция не записана, индекс не двигаем: повтор пойдёт тем же ключом,
    // и если запись всё-таки прошла на сервере, дубля не будет.
    return {
      state,
      reply: {
        text: `Не смог записать «${product}». Попробуй ещё раз или продолжи — записанное сохранено.`,
        keyboard: afterItemKeyboard(),
      },
    };
  }
}
