import type { LlmProfileKey, SystemConfigItem } from "./core";

/** Порядок полей задаёт и payload атомарной мутации. */
export const LLM_PROFILE_KEYS = [
  "LLM_ENABLED",
  "LLM_ROUTE",
  "LLM_MODEL",
  "LLM_BASE_URL",
  "LLM_PRICE_PROVIDER_ID",
  "LLM_FALLBACK_MODELS",
  "LLM_GLOBAL_DAILY_BUDGET_USD",
  "LLM_MAX_RESERVATION_USD",
] as const satisfies readonly LlmProfileKey[];

export type LlmProfileValues = Record<LlmProfileKey, string>;

/**
 * Безопасный первый экран: профиль уже виден владельцу, но вызовы
 * выключены. Рабочий маршрут заранее привязан к официальному OpenAI API,
 * но без серверного ключа и явного LLM_ENABLED=1 расход невозможен.
 */
export const DEFAULT_LLM_PROFILE: LlmProfileValues = {
  LLM_ENABLED: "0",
  LLM_ROUTE: "openai-api",
  LLM_MODEL: "gpt-5.6-sol",
  LLM_BASE_URL: "https://api.openai.com/v1",
  LLM_PRICE_PROVIDER_ID: "openai",
  LLM_FALLBACK_MODELS: "",
  LLM_GLOBAL_DAILY_BUDGET_USD: "10",
  LLM_MAX_RESERVATION_USD: "3",
};

const PROFILE_KEY_SET = new Set<string>(LLM_PROFILE_KEYS);

/** Профиль берёт эффективные значения GET /system/config, а на старом Core — UX-дефолты. */
export function llmProfileFromSystemConfig(items: readonly SystemConfigItem[]): LlmProfileValues {
  const profile = { ...DEFAULT_LLM_PROFILE };
  for (const item of items) {
    if (PROFILE_KEY_SET.has(item.key)) {
      profile[item.key as LlmProfileKey] = item.value;
    }
  }
  return profile;
}

/**
 * Профиль рисуется один раз в отдельной карточке. Legacy LLM_PROVIDER больше
 * не даём редактировать отдельно: иначе он расходится с LLM_ROUTE.
 */
export function genericSystemConfigItems(items: readonly SystemConfigItem[]): SystemConfigItem[] {
  return items.filter(
    (item) =>
      !PROFILE_KEY_SET.has(item.key) &&
      item.key !== "LLM_PROVIDER" &&
      item.key !== "AGENT_GLOBAL_BUDGET_USD",
  );
}
