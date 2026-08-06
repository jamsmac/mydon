import type { CoreClient, PersonRow, TaskRow } from "./core-client";
import type { Conversations } from "./conversation";
import type { StaffReply } from "./staff";

/**
 * Закрытие задачи сотрудником: отчёт → фото → подтверждение.
 *
 * До этого закрытие было одношаговым: «Сделал» → одна строка текста → задача
 * done. Владелец видел «Пополнил, всё работает» и должен был верить на слово.
 * Фотография — единственное дешёвое доказательство в полевой работе, и до
 * сих пор она умела приклеиваться только к карточке номенклатуры.
 *
 * Фото не обязательное. Обязательное фото звучит правильно, но на практике
 * упирается в подвал без связи: человек не сможет закрыть сделанную работу и
 * либо бросит задачу открытой, либо начнёт закрывать «на потом» пачками из
 * дома. Поэтому «без фото» — явная кнопка с записью в отчёт, а не тихий обход:
 * владелец видит, что доказательства нет, и может спросить.
 *
 * Состояние живёт в памяти (Conversations, TTL 45 мин) и не переживает
 * перезапуск бота — тот же осознанный размен, что и у остальных мастеров.
 * Отчёт пишется в задачу последним шагом, поэтому потерять можно только
 * незавершённый ввод, а не закрытую работу.
 */

export interface TaskDoneDeps {
  core: CoreClient;
  conversations: Conversations;
}

/** Стадия съёмки — та же, что в attachment.stage на стороне Core. */
export type PhotoStage = "before" | "after";

const FLOW = "task-done";

export type TaskDoneCallback =
  | { kind: "send" }
  | { kind: "noPhoto" }
  | { kind: "cancel" };

/**
 * Разбор нажатия. Пространство «dn:» свободно; занятые — t:, c:, r:, i:, n:,
 * cf:, cw:, cc:, fx:, ap:, m:.
 */
export function parseTaskDoneCallback(data: string): TaskDoneCallback | null {
  if (data === "dn:ok") return { kind: "send" };
  if (data === "dn:np") return { kind: "noPhoto" };
  if (data === "dn:x") return { kind: "cancel" };
  return null;
}

/** Подсказка по шагу — сотрудник не должен гадать, чего от него ждут. */
export function taskDoneStepHint(step: string): string {
  switch (step) {
    case "report":
      return "Напиши одной строкой, что сделано. Это отчёт — его увидит владелец.";
    case "photo":
      return "Пришли фото результата. Нет возможности — жми «Без фото».";
    default:
      return "Продолжай по кнопкам.";
  }
}

function photoKeyboard(count: number): NonNullable<StaffReply["keyboard"]> {
  return {
    inline_keyboard: [
      count > 0
        ? [{ text: `✅ Отправить (фото: ${count})`, callback_data: "dn:ok" }]
        : [{ text: "📷 Без фото", callback_data: "dn:np" }],
      [{ text: "✖️ Отмена", callback_data: "dn:x" }],
    ],
  };
}

/**
 * Начать закрытие. Вызывается из кнопки «✅ Выполнил» под карточкой задачи.
 *
 * Проверку «моя ли задача» делает вызывающий: он уже загрузил задачу, и
 * повторный запрос в Core ради того же ответа — лишний круг по сети на точке
 * с плохой связью.
 */
export function startTaskDone(chatId: number, task: TaskRow, deps: TaskDoneDeps): StaffReply {
  deps.conversations.start(chatId, FLOW, "report", { taskId: task.id, title: task.title, photos: 0 });
  return {
    text: `📌 ${task.title}\n\n✍️ Что сделано? Напиши одним сообщением — это отчёт.`,
    keyboard: { inline_keyboard: [[{ text: "✖️ Отмена", callback_data: "dn:x" }]] },
  };
}

/** Шаг «отчёт»: текст сотрудника. */
export function handleTaskDoneReport(chatId: number, text: string, deps: TaskDoneDeps): StaffReply {
  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== FLOW) {
    return { text: "Закрытие прервалось. Открой задачу и нажми «Выполнил» заново." };
  }
  const report = text.trim();
  if (report.length < 3) {
    return {
      text: "Слишком коротко. Напиши, что именно сделано — одной строкой достаточно.",
      keyboard: { inline_keyboard: [[{ text: "✖️ Отмена", callback_data: "dn:x" }]] },
    };
  }
  deps.conversations.advance(chatId, "photo", { report });
  return {
    text: `Записал: «${report}».\n\n📷 Пришли фото результата — это подтверждение работы.`,
    keyboard: photoKeyboard(0),
  };
}

/**
 * Фото на шаге «photo». Возвращает null, если мастер не в этом шаге —
 * тогда фото разбирает кто-то другой (например визард заведения карточки).
 */
export async function handleTaskDonePhoto(
  chatId: number,
  file: { bytes: Buffer; mime: string | null },
  person: PersonRow,
  deps: TaskDoneDeps,
): Promise<StaffReply | null> {
  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== FLOW || conv.step !== "photo") return null;
  const taskId = String(conv.data.taskId ?? "");
  if (!taskId) return null;

  const count = Number(conv.data.photos ?? 0) + 1;
  await uploadTaskPhoto(taskId, count, "after", file, person, deps);
  deps.conversations.advance(chatId, "photo", { photos: count });

  return {
    text: `Фото принято (${count}). Ещё? Или отправляй.`,
    keyboard: photoKeyboard(count),
  };
}

/**
 * Фото «до» вне мастера: сотрудник взял задачу в работу и сфотографировал
 * состояние до вмешательства. Ловим это, а не отвечаем молчанием — иначе
 * снимок просто пропадёт, а второй раз его уже не сделать.
 */
export async function attachBeforePhoto(
  task: TaskRow,
  file: { bytes: Buffer; mime: string | null },
  person: PersonRow,
  deps: TaskDoneDeps,
): Promise<StaffReply> {
  const existing = await deps.core.attachmentsOfOwner("task", task.id).catch(() => []);
  const count = existing.filter((a) => a.stage === "before").length + 1;
  await uploadTaskPhoto(task.id, count, "before", file, person, deps);
  return {
    text:
      `📷 Приложил как «до» к задаче «${task.title}» (${count}).\n` +
      "Когда закончишь — открой задачу и нажми «Выполнил».",
  };
}

async function uploadTaskPhoto(
  taskId: string,
  index: number,
  stage: PhotoStage,
  file: { bytes: Buffer; mime: string | null },
  person: PersonRow,
  deps: TaskDoneDeps,
): Promise<void> {
  const ext = file.mime === "image/png" ? "png" : "jpg";
  await deps.core.uploadPhoto({
    ownerType: "task",
    ownerId: taskId,
    bytes: file.bytes,
    mime: file.mime,
    filename: `${stage}-${index}.${ext}`,
    createdBy: `person:${person.id}`,
    stage,
  });
}

/** Нажатие кнопки мастера: отправить, без фото, отмена. */
export async function handleTaskDoneCallback(
  chatId: number,
  cb: TaskDoneCallback,
  person: PersonRow,
  deps: TaskDoneDeps,
): Promise<{ answer: string; message?: StaffReply }> {
  if (cb.kind === "cancel") {
    deps.conversations.clear(chatId);
    return {
      answer: "Отменено",
      message: { text: "Закрытие отменил. Задача осталась в работе." },
    };
  }

  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== FLOW) {
    return {
      answer: "Мастер истёк",
      message: { text: "Закрытие прервалось. Открой задачу и нажми «Выполнил» заново." },
    };
  }

  const taskId = String(conv.data.taskId ?? "");
  const title = String(conv.data.title ?? "задача");
  const report = String(conv.data.report ?? "").trim();
  if (!taskId || report.length === 0) {
    deps.conversations.clear(chatId);
    return { answer: "Нет отчёта", message: { text: "Отчёт потерялся — начни закрытие заново." } };
  }

  const photos = Number(conv.data.photos ?? 0);
  // «Без фото» пишется в сам отчёт, а не теряется: владелец должен видеть,
  // что доказательства нет, не заходя в галерею вложений.
  const note = cb.kind === "noPhoto" && photos === 0 ? `${report} (без фото)` : report;

  await deps.core.setTaskStatus(taskId, "done", `person:${person.id}`, note);
  deps.conversations.clear(chatId);

  const photoLine = photos > 0 ? `\n📷 Фото: ${photos}` : "\n📷 Без фото";
  return {
    answer: "Задача закрыта",
    message: { text: `✅ Закрыл «${title}».\n📝 ${report}${photoLine}` },
  };
}
