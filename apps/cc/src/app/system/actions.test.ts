import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveLlmProfile } from "./actions";

const mocks = vi.hoisted(() => ({ revalidatePath: vi.fn(), saveLlmProfile: vi.fn() }));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("../../lib/core", () => ({
  core: { saveLlmProfile: mocks.saveLlmProfile },
  CoreUnavailable: class CoreUnavailable extends Error {
    constructor(readonly detail: string) {
      super("Core недоступен");
    }
  },
}));

function profileForm(enabled = true): FormData {
  const form = new FormData();
  if (enabled) form.set("LLM_ENABLED", "1");
  form.set("LLM_ROUTE", "codex-subscription");
  form.set("LLM_MODEL", "gpt-5.6-sol");
  form.set("LLM_BASE_URL", "https://api.openai.com/v1");
  form.set("LLM_PRICE_PROVIDER_ID", "openai");
  form.set("LLM_FALLBACK_MODELS", "");
  form.set("LLM_GLOBAL_DAILY_BUDGET_USD", "10");
  form.set("LLM_MAX_RESERVATION_USD", "3");
  return form;
}

describe("saveLlmProfile", () => {
  beforeEach(() => vi.resetAllMocks());

  it("пишет полный allowlist одним атомарным вызовом", async () => {
    mocks.saveLlmProfile.mockResolvedValue([]);
    const form = profileForm();
    // Даже подделанное лишнее поле не попадает в белый список payload.
    form.set("LLM_API_KEY", "never-send-this-secret");

    await expect(saveLlmProfile(form)).resolves.toEqual({ ok: true });
    expect(mocks.saveLlmProfile).toHaveBeenCalledOnce();
    expect(mocks.saveLlmProfile).toHaveBeenCalledWith({
      items: [
        { key: "LLM_ENABLED", value: "1" },
        { key: "LLM_ROUTE", value: "codex-subscription" },
        { key: "LLM_MODEL", value: "gpt-5.6-sol" },
        { key: "LLM_BASE_URL", value: "https://api.openai.com/v1" },
        { key: "LLM_PRICE_PROVIDER_ID", value: "openai" },
        { key: "LLM_FALLBACK_MODELS", value: "" },
        { key: "LLM_GLOBAL_DAILY_BUDGET_USD", value: "10" },
        { key: "LLM_MAX_RESERVATION_USD", value: "3" },
      ],
      updatedBy: "owner:panel",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/system");
  });

  it("превращает отсутствующий checkbox в LLM_ENABLED=0", async () => {
    mocks.saveLlmProfile.mockResolvedValue([]);
    await saveLlmProfile(profileForm(false));
    expect(mocks.saveLlmProfile.mock.calls[0]?.[0].items[0]).toEqual({
      key: "LLM_ENABLED",
      value: "0",
    });
  });

  it("не делает частичную запись, если поле формы потеряно", async () => {
    const form = profileForm();
    form.delete("LLM_MODEL");
    await expect(saveLlmProfile(form)).resolves.toEqual({
      ok: false,
      error: "В форме нет поля LLM_MODEL",
    });
    expect(mocks.saveLlmProfile).not.toHaveBeenCalled();
  });
});
