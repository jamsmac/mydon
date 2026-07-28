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
