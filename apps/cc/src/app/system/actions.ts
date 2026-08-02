"use server";

import { revalidatePath } from "next/cache";
import { core, CoreUnavailable } from "../../lib/core";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/**
 * Сохранить один глобальный тумблер. Валидацию и белый список держит Core:
 * панель не может записать произвольную переменную или секрет. Пустое значение
 * = сброс к env/дефолту.
 */
export async function saveSystemConfig(key: string, value: string): Promise<ActionResult> {
  try {
    await core.saveSystemConfig({ key, value, updatedBy: "owner:panel" });
    revalidatePath("/system");
    return { ok: true };
  } catch (err) {
    if (err instanceof CoreUnavailable) return { ok: false, error: err.detail };
    return { ok: false, error: err instanceof Error ? err.message : "Не удалось сохранить" };
  }
}
