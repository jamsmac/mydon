"use server";

import { revalidatePath } from "next/cache";
import { core, CoreUnavailable } from "../../lib/core";
import type { ActionResult } from "../agents/actions";

/**
 * Ручной запуск навыка с панели «Навыки».
 *
 * Отказ Core («агент выключен», «навык не закреплён») — не поломка, а ответ
 * владельцу: возвращаем его словами, а не кодом, и без исключения — форма
 * обязана сохранить набранный вход.
 */
function fail(err: unknown): ActionResult {
  if (err instanceof CoreUnavailable) return { ok: false, error: err.detail };
  return { ok: false, error: err instanceof Error ? err.message : "Не удалось запустить навык" };
}

export async function runSkill(
  agent: string,
  skill: string,
  form: FormData,
): Promise<ActionResult & { taskId?: string }> {
  const input = String(form.get("input") ?? "").trim();
  const effort = String(form.get("modelEffort") ?? "").trim();

  let taskId: string;
  try {
    // Пустые поля не шлём вовсе: у Core «не задано» значит «как в навыке»,
    // а пустая строка прошла бы валидацию и затёрла бы настройку навыка.
    const res = await core.runSkill(agent, skill, {
      ...(input ? { input } : {}),
      ...(effort ? { modelEffort: effort } : {}),
      actor: "owner",
    });
    taskId = res.taskId;
  } catch (err) {
    return fail(err);
  }

  // Витрина показывает «последний запуск» — после постановки задачи она врёт,
  // пока страницу не пересобрали.
  revalidatePath("/skills");
  return { ok: true, taskId, goTo: `/tasks/${taskId}` };
}
