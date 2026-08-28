"use server";

import { revalidatePath } from "next/cache";
import { core, CoreUnavailable } from "../../lib/core";
import { parseDue } from "@mydon/shared";

export interface ActionResult {
  ok: boolean;
  error?: string;
  goTo?: string;
}

function fail(err: unknown): ActionResult {
  if (err instanceof CoreUnavailable) return { ok: false, error: err.detail };
  return { ok: false, error: err instanceof Error ? err.message : "Не удалось сохранить" };
}

/** Быстрое создание: заголовок + исполнитель + срок словами. */
export async function quickAddTask(form: FormData): Promise<ActionResult> {
  const title = String(form.get("title") ?? "").trim();
  if (title.length < 2) return { ok: false, error: "Напиши, что нужно сделать" };

  const owner = String(form.get("owner") ?? "").trim(); // "human:<id>" | "agent:<name>"
  const [kind, ...rest] = owner.split(":");
  const ownerRef = rest.join(":");
  if (kind !== "human" && kind !== "agent") {
    return { ok: false, error: "Выбери, кому поручить" };
  }

  const due = parseDue(String(form.get("due") ?? ""));

  try {
    await core.createTask({
      title,
      ownerKind: kind,
      ownerRef,
      priority: String(form.get("priority") ?? "normal"),
      createdBy: "owner",
      ...(due ? { due: due.toISOString() } : {}),
    });
  } catch (err) {
    return fail(err);
  }

  revalidatePath("/tasks");
  revalidatePath("/mydon");
  return { ok: true };
}

/**
 * Быстрая кнопка с дашборда направления: «Пополнение», «Инкассация»…
 * Исполнитель выбирается позже в задаче — кнопка не должна требовать раздумий.
 */
export async function quickDomainTask(
  domain: string,
  title: string,
  ownerRef: string | null,
): Promise<ActionResult> {
  try {
    await core.createTask({
      title,
      domain,
      // Есть кому поручить (первый активный человек направления) — сразу ему,
      // нет — задача встаёт без исполнителя, назначается в карточке.
      ownerKind: "human",
      ownerRef: ownerRef ?? "",
      priority: "high",
      createdBy: "owner",
      due: new Date(Date.now() + 24 * 3600_000).toISOString(),
    });
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/tasks");
  revalidatePath(`/domain/${domain}`);
  return { ok: true };
}

/** Закрытие задачи. Отчёт обязателен: «сделано» без объяснения ничего не значит. */
export async function completeTask(id: string, resultNote: string): Promise<ActionResult> {
  const note = resultNote.trim();
  if (note.length < 3) {
    return { ok: false, error: "Напиши коротко, что сделано — это и есть отчёт" };
  }
  try {
    await core.setTaskStatus(id, { status: "done", actor: "owner", resultNote: note });
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/tasks");
  revalidatePath(`/tasks/${id}`);
  revalidatePath("/mydon");
  return { ok: true };
}

/** Оценка сделанной задачи. «Переделать» возвращает её в работу с напоминаниями. */
export async function rateTask(
  id: string,
  quality: "excellent" | "accepted" | "redo",
): Promise<ActionResult> {
  try {
    await core.rateTask(id, quality);
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/tasks");
  revalidatePath(`/tasks/${id}`);
  revalidatePath("/team");
  return { ok: true };
}

/**
 * Приёмка работы. «Переделать» живёт отдельно — это `rateTask(id, "redo")`:
 * у них разные последствия, и одна кнопка на оба означала бы, что владелец
 * возвращает задачу в работу, думая, что закрывает вопрос.
 */
export async function confirmTask(id: string): Promise<ActionResult> {
  try {
    await core.confirmTask(id);
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/tasks");
  revalidatePath(`/tasks/${id}`);
  revalidatePath("/team");
  return { ok: true };
}

/** Смена статуса без закрытия: «взял в работу», «отменить». */
export async function changeStatus(
  id: string,
  status: "todo" | "in_progress" | "cancelled",
): Promise<ActionResult> {
  try {
    await core.setTaskStatus(id, { status, actor: "owner" });
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/tasks");
  revalidatePath(`/tasks/${id}`);
  return { ok: true };
}

/**
 * Правка полей задачи: переназначить исполнителя, приоритет, срок, заголовок,
 * описание. Меняются только переданные поля. Исполнитель приходит строкой
 * "human:<id>" | "agent:<name>" | "" (снять). Срок — словами (parseDue) или
 * пусто (снять).
 */
export async function editTask(
  id: string,
  patch: {
    title?: string;
    description?: string;
    owner?: string;
    priority?: "low" | "normal" | "high" | "urgent";
    due?: string;
  },
): Promise<ActionResult> {
  const body: Record<string, unknown> = { actor: "owner" };

  if (patch.title !== undefined) {
    const t = patch.title.trim();
    if (t.length < 2) return { ok: false, error: "Заголовок слишком короткий" };
    body.title = t;
  }
  if (patch.description !== undefined) body.description = patch.description.trim();
  if (patch.priority !== undefined) body.priority = patch.priority;

  if (patch.owner !== undefined) {
    const [kind, ...rest] = patch.owner.split(":");
    if (patch.owner === "") {
      body.ownerRef = ""; // снять исполнителя (человек по умолчанию)
    } else if (kind === "human" || kind === "agent") {
      body.ownerKind = kind;
      body.ownerRef = rest.join(":");
    } else {
      return { ok: false, error: "Неверный исполнитель" };
    }
  }

  if (patch.due !== undefined) {
    const raw = patch.due.trim();
    if (raw === "") {
      body.due = ""; // снять срок
    } else {
      const d = parseDue(raw);
      if (!d) return { ok: false, error: "Не понял срок — попробуй «завтра», «через 3 дня», дату" };
      body.due = d.toISOString();
    }
  }

  try {
    await core.editTask(id, body);
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/tasks");
  revalidatePath(`/tasks/${id}`);
  revalidatePath("/team");
  return { ok: true };
}

export async function addComment(id: string, body: string): Promise<ActionResult> {
  const text = body.trim();
  if (text.length === 0) return { ok: false, error: "Пустой комментарий" };
  try {
    await core.addTaskComment(id, { body: text, author: "owner" });
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/tasks/${id}`);
  return { ok: true };
}
