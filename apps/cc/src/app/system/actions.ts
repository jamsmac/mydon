"use server";

import { revalidatePath } from "next/cache";
import { core, CoreUnavailable } from "../../lib/core";
import { LLM_PROFILE_KEYS } from "../../lib/llm-profile";

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

/**
 * Сохранить весь LLM-профиль одной мутацией Core. Ключи формируем
 * по фиксированному allowlist, поэтому лишнее поле не может протащить
 * API key/password в system_config. Неотмеченный checkbox — это LLM_ENABLED=0.
 */
export async function saveLlmProfile(form: FormData): Promise<ActionResult> {
  const values = new Map<string, string>();
  for (const key of LLM_PROFILE_KEYS) {
    if (key === "LLM_ENABLED") {
      values.set(key, form.get(key) === "1" ? "1" : "0");
      continue;
    }
    const value = form.get(key);
    if (typeof value !== "string") {
      return { ok: false, error: `В форме нет поля ${key}` };
    }
    values.set(key, value);
  }

  try {
    await core.saveLlmProfile({
      items: LLM_PROFILE_KEYS.map((key) => ({ key, value: values.get(key) ?? "" })),
      updatedBy: "owner:panel",
    });
    revalidatePath("/system");
    return { ok: true };
  } catch (err) {
    if (err instanceof CoreUnavailable) return { ok: false, error: err.detail };
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Не удалось сохранить LLM-профиль",
    };
  }
}
