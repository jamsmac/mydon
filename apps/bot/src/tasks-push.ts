import { dueLabel } from "@mydon/shared";
import type { PersonRow, TaskRow } from "./core-client";
import { внутриРабочихЧасов } from "./push-hours";
import { taskKeyboard, type StaffReply } from "./staff";

export interface AssignmentPushDeps {
  assignUnnotified(): Promise<TaskRow[]>;
  people(): Promise<Pick<PersonRow, "id" | "tgChatId">[]>;
  markAssignNotified(id: string): Promise<void>;
  send(chat: number, text: string, keyboard?: StaffReply["keyboard"]): Promise<void>;
  reportUnreachable(personId: string, reason: string): Promise<void>;
  isUnreachable(error: unknown): boolean;
  reportFailure?(message: string, error: unknown): void;
}

function причина(error: unknown): string {
  if (typeof error === "object" && error !== null && "description" in error) {
    return String(error.description);
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Доставляет новые назначения. Каждый необратимый шаг вынесен в зависимости,
 * чтобы порядок «отправили → отметили» проверялся без живого Telegram.
 */
export async function доставитьНазначения(deps: AssignmentPushDeps, now: Date): Promise<void> {
  if (!внутриРабочихЧасов(now)) return;

  const tasks = await deps.assignUnnotified();
  if (tasks.length === 0) return;
  const people = await deps.people();
  const chatById = new Map(people.filter((p) => p.tgChatId).map((p) => [p.id, p.tgChatId!]));

  for (const t of tasks) {
    if (t.ownerRef === null) continue;
    const chat = chatById.get(t.ownerRef);
    if (chat === undefined) continue;
    const chatId = Number(chat);
    if (!Number.isSafeInteger(chatId) || chatId <= 0) {
      deps.reportFailure?.(`Некорректный Telegram chat_id у исполнителя ${t.ownerRef}`, chat);
      continue;
    }

    try {
      const текст = `📌 Тебе поручили: ${t.title}\n${dueLabel(t.due, now)}`;
      await deps.send(chatId, текст, taskKeyboard(t));
    } catch (error) {
      if (deps.isUnreachable(error)) {
        await deps.reportUnreachable(t.ownerRef, причина(error));
        // Недоступный чат иначе получает тот же запрос на каждом тике вечно.
        await deps.markAssignNotified(t.id).catch(() => undefined);
      } else {
        deps.reportFailure?.(`Сообщение о назначении ${t.id} не доставлено`, error);
      }
      continue;
    }

    // Сбой Core после доставки оставляет at-least-once повтор на следующий тик:
    // возможный дубль лучше молчаливой потери назначения.
    await deps.markAssignNotified(t.id).catch((error: unknown) => {
      deps.reportFailure?.(`Доставка назначения ${t.id} не отмечена`, error);
    });
  }
}
