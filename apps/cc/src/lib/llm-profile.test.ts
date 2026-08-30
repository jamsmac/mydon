import { describe, expect, it } from "vitest";
import type { SystemConfigItem } from "./core";
import {
  DEFAULT_LLM_PROFILE,
  genericSystemConfigItems,
  llmProfileFromSystemConfig,
} from "./llm-profile";

function item(key: string, value: string): SystemConfigItem {
  return { key, value, label: key, kind: "text", source: "db" };
}

describe("LLM-профиль из /system/config", () => {
  it("показывает безопасные первоначальные значения даже со старым Core", () => {
    expect(llmProfileFromSystemConfig([])).toEqual(DEFAULT_LLM_PROFILE);
  });

  it("берёт эффективные значения Core, включая законную пустую цепочку fallback", () => {
    const profile = llmProfileFromSystemConfig([
      item("LLM_ENABLED", "1"),
      item("LLM_ROUTE", "openai-api"),
      item("LLM_MODEL", "gpt-5.6-terra"),
      item("LLM_FALLBACK_MODELS", ""),
    ]);

    expect(profile).toMatchObject({
      LLM_ENABLED: "1",
      LLM_ROUTE: "openai-api",
      LLM_MODEL: "gpt-5.6-terra",
      LLM_FALLBACK_MODELS: "",
      LLM_GLOBAL_DAILY_BUDGET_USD: "10",
    });
  });

  it("убирает профиль и оба legacy LLM-поля из generic-редактора", () => {
    const generic = genericSystemConfigItems([
      item("LLM_ENABLED", "0"),
      item("LLM_MODEL", "gpt-5.6-sol"),
      item("LLM_PROVIDER", "claude-cli"),
      item("AGENT_GLOBAL_BUDGET_USD", "5"),
      item("AGENTS_SCHEDULES_PAUSED", "1"),
      item("AGENTS_TASKS_PAUSED", "1"),
    ]);

    expect(generic.map((row) => row.key)).toEqual([
      "AGENTS_SCHEDULES_PAUSED",
      "AGENTS_TASKS_PAUSED",
    ]);
  });
});
