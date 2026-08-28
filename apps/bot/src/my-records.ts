import {
  CancelVendingRecordError,
  type CancelKind,
  type CoreClient,
  type PersonRow,
} from "./core-client";
import type { StaffReply } from "./staff";

/**
 * Снек-записи сотрудника: заправка, один ввод пересчёта или касса закупа.
 * В отличие от кофейного «Ошибся — исправить» Core ничего не удаляет:
 * выбранная строка отменяется сторнирующей записью и остаётся в аудите.
 */

export interface MyRecordsDeps {
  core: CoreClient;
}

export type MyRecordsCallback =
  | { kind: "cancel"; entry: CancelKind; id: string }
  | { kind: "keep" };

/** Первый шаг выбора отделён префиксом, но несёт ту же выбранную запись. */
export type MyRecordsSelection = MyRecordsCallback & { kind: "cancel" };

const KIND_CODE: Record<CancelKind, string> = { refill: "r", stock_count: "s", cash: "k" };
const CODE_KIND: Record<string, CancelKind> = { r: "refill", s: "stock_count", k: "cash" };
const UUID = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
const ASK_RE = new RegExp(`^mr:a:([rsk]):${UUID}$`, "i");
const CANCEL_RE = new RegExp(`^mr:c:([rsk]):${UUID}$`, "i");

export function isMyRecordsTrigger(text: string): boolean {
  return /^мои\s+записи/i.test(text.trim());
}

/**
 * Строгий разбор кнопок подтверждения. `mr:c` действительно выполняет
 * сторно; кнопки списка имеют отдельный безопасный шаг `mr:a`.
 */
export function parseMyRecordsCallback(data: string): MyRecordsCallback | null {
  if (data === "mr:keep") return { kind: "keep" };
  const match = CANCEL_RE.exec(data);
  if (!match) return null;
  return { kind: "cancel", entry: CODE_KIND[match[1]!.toLowerCase()]!, id: match[2]! };
}

/** Разбор выбора строки из списка — до показа необратимой кнопки сторно. */
export function parseMyRecordsSelection(data: string): MyRecordsSelection | null {
  const match = ASK_RE.exec(data);
  if (!match) return null;
  return { kind: "cancel", entry: CODE_KIND[match[1]!.toLowerCase()]!, id: match[2]! };
}

function dateLabel(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "без даты";
  return date.toLocaleDateString("ru-RU", {
    timeZone: "Asia/Tashkent",
    day: "2-digit",
    month: "2-digit",
  });
}

/** Последние 15 ещё не отменённых записей, свежие сверху. */
export async function startMyRecords(person: PersonRow, deps: MyRecordsDeps): Promise<StaffReply> {
  const rows = (await deps.core.myRecords(person.id)).slice(0, 15);
  if (rows.length === 0) {
    return {
      text: "Записей пока нет — заправь, посчитай склад или запиши кассу, и они появятся здесь.",
    };
  }

  return {
    text: [
      "✏️ Твои последние записи",
      "",
      "Ошибся — выбери запись, проверь её целиком и подтверди отмену:",
      "",
      ...rows.map((row, index) => `${index + 1}. ${dateLabel(row.createdAt)} — ${row.label}`),
    ].join("\n"),
    keyboard: {
      inline_keyboard: rows.map((row, index) => [
        {
          text: `✏️ ${index + 1}. ${row.label}`.slice(0, 64),
          callback_data: `mr:a:${KIND_CODE[row.kind]}:${row.id}`,
        },
      ]),
    },
  };
}

/** Шаг 1: повторно читаем запись из Core и только затем показываем подтверждение. */
export async function askCancel(
  cb: MyRecordsCallback & { kind: "cancel" },
  person: PersonRow,
  deps: MyRecordsDeps,
): Promise<StaffReply> {
  const rows = await deps.core.myRecords(person.id);
  const row = rows.find((item) => item.kind === cb.entry && item.id === cb.id);
  if (!row) {
    return { text: "Эта запись уже отменена или больше недоступна. Открой «Мои записи» заново." };
  }

  return {
    text: `Отменить эту запись?\n\n${dateLabel(row.createdAt)} — ${row.label}\n\nВ журнале останется сторно и полный аудит.`,
    keyboard: {
      // Подтверждение и отказ намеренно в разных рядах: промах пальцем не
      // должен отменить учётную запись.
      inline_keyboard: [
        [{ text: "↩️ Да, отменить", callback_data: `mr:c:${KIND_CODE[cb.entry]}:${cb.id}` }],
        [{ text: "◀️ Оставить", callback_data: "mr:keep" }],
      ],
    },
  };
}

function отказ(reason: string | undefined, hours: number | undefined): { answer: string; message: string } {
  if (reason === "too_old") {
    const value = Number.isFinite(hours) ? hours : 24;
    return { answer: "Слишком старая запись", message: `Записи старше ${value} часов отменяет владелец.` };
  }
  if (reason === "not_yours") {
    return { answer: "Не твоя запись", message: "Отменять можно только свои записи." };
  }
  if (reason === "not_found") {
    return { answer: "Уже отменено", message: "Эта запись уже отменена или больше не существует." };
  }
  return { answer: "Не получилось", message: "Запись отменить не вышло — повтори позже или скажи владельцу." };
}

/** Шаг 2: Core повторно проверяет автора, роли и временное окно и пишет сторно. */
export async function handleMyRecordsCallback(
  cb: MyRecordsCallback,
  person: PersonRow,
  deps: MyRecordsDeps,
): Promise<{ answer: string; message?: string }> {
  if (cb.kind === "keep") return { answer: "Оставил как есть" };

  try {
    const result = await deps.core.cancelVendingRecord(cb.entry, cb.id, person.id);
    if (!result.ok) return отказ(result.reason, result.reason === "too_old" ? result.hours : undefined);
    if (result.alreadyCancelled) {
      return { answer: "Уже отменено", message: "Эта запись уже отменена — повторное нажатие ничего не изменило." };
    }
    if (result.kind === "stock_count") {
      return {
        answer: "Отменено",
        message:
          "Пересчёт отменён и убран из истории. Текущий остаток склада он больше не задаёт — " +
          "если остаток неверен, посчитай заново.",
      };
    }
    return { answer: "Отменено", message: `${result.label}\n\nЗапись отменена ✅` };
  } catch (error) {
    if (error instanceof CancelVendingRecordError) {
      return отказ(error.body.reason, error.body.hours);
    }
    // В unit-тестах и у совместимых клиентов ошибка может быть структурной,
    // но не иметь прототипа класса из этого процесса.
    if (typeof error === "object" && error !== null && "body" in error) {
      const body = (error as { body?: { reason?: string; hours?: number } }).body;
      return отказ(body?.reason, body?.hours);
    }
    return отказ(undefined, undefined);
  }
}
