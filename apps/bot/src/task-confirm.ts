import { can, effectiveRoles, TZ } from "@mydon/shared";
import { CoreError, type CoreClient, type PersonRow, type TaskRow } from "./core-client";
import type { Conversations } from "./conversation";
import { внутриРабочихЧасов } from "./push-hours";
import type { StaffReply } from "./staff";
import { TelegramError } from "./telegram";

export const CONFIRM_CANCEL = "tc:x";
export const REDO_FLOW = "task-redo";
export const NO_CONFIRMERS_EVENT = "tasks.no_confirmers";

/** Кому положено подтверждать: право `tasks.confirm`, активен, есть чат. */
export function confirmRecipients(people: readonly PersonRow[]): PersonRow[] {
  return people.filter(
    (person) =>
      person.active === "yes" &&
      typeof person.tgChatId === "string" &&
      person.tgChatId.trim().length > 0 &&
      can(effectiveRoles(person), "tasks.confirm"),
  );
}

/** Ключ веера — отдельный для каждого получателя. */
export function confirmKey(taskId: string, personId: string): string {
  return `task-confirm:${taskId}:${personId}`;
}

/** Ключ запасного пути «адресатов нет». */
export function ownerFallbackKey(taskId: string): string {
  return `task-confirm:${taskId}:owner-fallback`;
}

function момент(iso: string | null, now: Date): string {
  const parsed = iso === null ? now : new Date(iso);
  const value = Number.isNaN(parsed.getTime()) ? now : parsed;
  return value
    .toLocaleString("ru-RU", {
      timeZone: TZ,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
    .replace(", ", " ");
}

/** Текст и кнопки одного запроса приёмки. */
export function formatConfirmRequest(t: TaskRow, closerName: string, now = new Date()): StaffReply {
  const report = t.resultNote?.trim() ? `Отчёт: ${t.resultNote.trim()}` : "Отчёта нет.";
  return {
    text: `🟡 Выполнена: ${t.title}\nЗакрыл: ${closerName} · ${момент(t.completedAt, now)}\n${report}`,
    keyboard: {
      inline_keyboard: [[
        { text: "👌 Принять", callback_data: `tc:${t.id}:ok` },
        { text: "↩ Вернуть в работу", callback_data: `tc:${t.id}:redo` },
      ]],
    },
  };
}

export function parseConfirmCallback(data: string): { id: string; action: "ok" | "redo" } | null {
  const match = /^tc:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(ok|redo)$/.exec(data);
  if (!match) return null;
  return { id: match[1]!, action: match[2] as "ok" | "redo" };
}

export function startConfirmRedo(chatId: number, t: TaskRow, deps: { conversations: Conversations }): StaffReply {
  deps.conversations.start(chatId, REDO_FLOW, "reason", { taskId: t.id, title: t.title });
  return {
    text: `↩ Вернуть в работу «${t.title}». Напиши одной строкой, что нужно исправить.`,
    keyboard: { inline_keyboard: [[{ text: "✖️ Отмена", callback_data: CONFIRM_CANCEL }]] },
  };
}

export function confirmRedoStepHint(step: string): string {
  return step === "reason"
    ? "Напиши, что не так и что нужно исправить. Без причины вернуть задачу нельзя."
    : "Этот ввод устарел. Нажми «Вернуть в работу» ещё раз.";
}

export async function handleConfirmRedoReason(
  chatId: number,
  text: string,
  person: PersonRow,
  deps: { conversations: Conversations; core: CoreClient },
): Promise<StaffReply> {
  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== REDO_FLOW || conv.step !== "reason" || typeof conv.data.taskId !== "string") {
    return { text: "Этот ввод уже истёк. Нажми «Вернуть в работу» ещё раз." };
  }
  const reason = text.trim();
  if (!reason) return { text: confirmRedoStepHint(conv.step) };

  const actor = `person:${person.id}`;
  await deps.core.addTaskComment(conv.data.taskId, reason, actor);
  await deps.core.rateTask(conv.data.taskId, "redo", actor);
  deps.conversations.clear(chatId);
  return { text: `↩ Вернул в работу «${String(conv.data.title ?? "задачу")}». Причина сохранена в комментариях.` };
}

/** Экран «ждут подтверждения»: нумерованный список и пара кнопок на строку. */
export function formatAwaitingScreen(
  tasks: readonly TaskRow[],
  names: ReadonlyMap<string, string>,
  now = new Date(),
): StaffReply {
  if (tasks.length === 0) {
    return { text: "Ничего не ждёт приёмки. Как только кто-то закроет задачу, она появится здесь." };
  }
  const строки = tasks.map((t, i) => {
    const closerId = t.closedBy?.startsWith("person:") ? t.closedBy.slice("person:".length) : t.ownerRef;
    const closerName = (closerId ? names.get(closerId) : null) ?? "сотрудник";
    const report = t.resultNote?.trim() ? t.resultNote.trim().split("\n")[0] : "Отчёта нет.";
    return `${i + 1}. ${t.title}\nЗакрыл: ${closerName} · ${момент(t.completedAt, now)}\n${report}`;
  });
  return {
    text: строки.join("\n\n"),
    keyboard: {
      inline_keyboard: tasks.map((t) => [
        { text: "👌 Принять", callback_data: `tc:${t.id}:ok` },
        { text: "↩ Вернуть в работу", callback_data: `tc:${t.id}:redo` },
      ]),
    },
  };
}

export interface ConfirmCallbackResult {
  answer: string;
  message?: StaffReply;
  recipientNote?: { chat: number; text: string };
}

/** Обрабатывает решение менеджера; окончательное право всё равно проверяет Core. */
export async function handleConfirmCallback(
  chatId: number,
  parsed: { id: string; action: "ok" | "redo" },
  person: PersonRow,
  deps: { conversations: Conversations; core: CoreClient },
): Promise<ConfirmCallbackResult> {
  if (!can(effectiveRoles(person), "tasks.confirm")) {
    return { answer: "Недоступно", message: { text: "Подтверждать может менеджер. Попроси владельца проставить роль." } };
  }
  const task = await deps.core.task(parsed.id);
  if (parsed.action === "redo") {
    return { answer: "Напиши причину", message: startConfirmRedo(chatId, task, deps) };
  }
  if (task.confirmedAt !== null) return { answer: "Уже принято", message: { text: `✅ «${task.title}» уже принята.` } };

  const actor = `person:${person.id}`;
  try {
    const confirmed = await deps.core.confirmTask(task.id, actor);
    const closerId = task.closedBy?.startsWith("person:") ? task.closedBy.slice("person:".length) : task.ownerRef;
    if (closerId !== null) {
      const closer = (await deps.core.people()).find((candidate) => candidate.id === closerId);
      const chat = Number(closer?.tgChatId);
      if (closer?.tgChatId && Number.isSafeInteger(chat) && chat > 0) {
        return {
          answer: "Принято",
          message: { text: `✅ Принял: ${confirmed.title}.` },
          recipientNote: { chat, text: `✅ Задача принята: ${confirmed.title}. Спасибо!` },
        };
      }
    }
    return { answer: "Принято", message: { text: `✅ Принял: ${confirmed.title}.` } };
  } catch (error) {
    if (error instanceof CoreError && error.status === 403) {
      return { answer: "Недоступно", message: { text: "Подтверждать может менеджер. Попроси владельца проставить роль." } };
    }
    throw error;
  }
}

export interface ConfirmDeps {
  awaitingTasks(): Promise<TaskRow[]>;
  people(): Promise<PersonRow[]>;
  claimNotification(key: string): Promise<boolean>;
  /**
   * Освободить ранее занятый ключ рассылки, чтобы следующий прогон занял его
   * заново. Нужно, когда отправка после `claimNotification` сорвалась
   * транзиентно: без освобождения метка «уведомлён» осталась бы стоять, и
   * запрос приёмки потерялся бы навсегда.
   */
  releaseNotification(key: string): Promise<void>;
  recordEvent(type: string, payload: Record<string, unknown>): Promise<void>;
  send(chat: number, text: string, keyboard?: StaffReply["keyboard"]): Promise<void>;
  ownerChats: Iterable<number>;
  sendOwner(chat: number, text: string): Promise<void>;
  warn(message: string): void;
}

function текстОшибки(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Стоит ли переотправлять после этого сбоя. Транзиентный (сеть, 429, 5xx) —
 * да: результат ещё не известен, следующий прогон может пройти. Перманентный
 * `TelegramError.isUnreachable` (403: бот заблокирован/чат удалён) — нет:
 * результат уже известен, а метку снимать нельзя, иначе каждый тик планировщика
 * (≈60 с) вечно бьёт в тот же недоступный чат по одному 403 на пару
 * «задача × адресат». Контракт TelegramError.isUnreachable — тот же принцип.
 */
function стоитПовторить(error: unknown): boolean {
  return !(error instanceof TelegramError && error.isUnreachable);
}

/** Доставка веера менеджерам с отдельным ключом на каждого адресата. */
export async function разослатьПодтверждения(deps: ConfirmDeps, now = new Date()): Promise<void> {
  if (!внутриРабочихЧасов(now)) return;
  const [tasks, people] = await Promise.all([deps.awaitingTasks(), deps.people()]);
  const eligible = confirmRecipients(people);
  const byId = new Map(people.map((person) => [person.id, person]));

  for (const task of tasks) {
    const recipients = eligible.filter((person) => task.closedBy !== `person:${person.id}`);
    if (recipients.length === 0) {
      const fallbackKey = ownerFallbackKey(task.id);
      if (!(await deps.claimNotification(fallbackKey))) continue;
      const warning = `Задача «${task.title}» выполнена, но подтвердить её некому. Проставь роль менеджера или владельца с Telegram.`;
      deps.warn(warning);
      await deps.recordEvent(NO_CONFIRMERS_EVENT, { taskId: task.id, title: task.title }).catch((error: unknown) =>
        deps.warn(`Событие ${NO_CONFIRMERS_EVENT} не записано: ${текстОшибки(error)}`),
      );
      let адресатов = 0;
      let доставлено = false;
      let естьТранзиентныйСбой = false;
      for (const chat of deps.ownerChats) {
        адресатов += 1;
        try {
          await deps.sendOwner(chat, `🟡 ${warning}`);
          доставлено = true;
        } catch (error: unknown) {
          deps.warn(`Владельцу (${chat}) не отправлено: ${текстОшибки(error)}`);
          if (стоитПовторить(error)) естьТранзиентныйСбой = true;
        }
      }
      // Один ключ `owner-fallback` на всех владельцев: семантика «хотя бы одному
      // дошло» — это одно предупреждение об одной задаче, дублировать его каждому
      // владельцу не нужно, и второй прогон при частичной доставке молчит (не
      // переотправляет уже дошедшим). Освобождаем ключ, только если ни одному не
      // дошло И был транзиентный сбой (есть смысл повторить). Если единственный
      // сбой перманентный (владелец заблокировал бота) — ключ держим, иначе
      // каждый тик планировщика вечно писал бы событие + warn + повторный send в
      // недоступный чат. Когда адресатов нет вовсе, повторять нечего — держим.
      if (адресатов > 0 && !доставлено && естьТранзиентныйСбой) {
        await deps.releaseNotification(fallbackKey).catch((error: unknown) =>
          deps.warn(`Метка ${fallbackKey} не освобождена после сбоя отправки владельцу: ${текстОшибки(error)}`),
        );
      }
      continue;
    }

    const closerId = task.closedBy?.startsWith("person:") ? task.closedBy.slice("person:".length) : task.ownerRef;
    const closerName = (closerId ? byId.get(closerId)?.name : null) ?? "сотрудник";
    const message = formatConfirmRequest(task, closerName, now);
    for (const recipient of recipients) {
      const chat = Number(recipient.tgChatId);
      if (!Number.isSafeInteger(chat) || chat <= 0) {
        deps.warn(`Запрос приёмки ${task.id}: chat_id «${recipient.tgChatId}» у ${recipient.name} не число.`);
        continue;
      }
      const key = confirmKey(task.id, recipient.id);
      if (!(await deps.claimNotification(key))) continue;
      try {
        await deps.send(chat, message.text, message.keyboard);
      } catch (error: unknown) {
        deps.warn(`Запрос приёмки ${task.id} не доставлен ${recipient.name}: ${текстОшибки(error)}`);
        // Только транзиентный сбой Telegram: снимаем метку, чтобы следующий
        // прогон переотправил, иначе запрос приёмки потерялся бы навсегда. При
        // перманентном (403 «бот заблокирован/чат удалён») метку держим — иначе
        // планировщик каждую минуту вечно бил бы 403 в тот же недоступный чат.
        if (стоитПовторить(error)) {
          await deps.releaseNotification(key).catch((releaseError: unknown) =>
            deps.warn(`Метка ${key} не освобождена после сбоя отправки: ${текстОшибки(releaseError)}`),
          );
        }
      }
    }
  }
}
