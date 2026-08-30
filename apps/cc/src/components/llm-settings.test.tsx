import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LLM_PROFILE } from "../lib/llm-profile";
import { LlmSettings } from "./llm-settings";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), saveLlmProfile: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("../app/system/actions", () => ({ saveLlmProfile: mocks.saveLlmProfile }));

describe("атомарная LLM-форма", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("показывает GPT-5.6 Sol выключенным и не рисует поле секрета", () => {
    const { container } = render(<LlmSettings initial={{ ...DEFAULT_LLM_PROFILE }} />);

    expect(screen.getByLabelText(/^Использовать LLM/)).not.toBeChecked();
    expect(screen.getByText("Не активно")).toBeVisible();
    expect(screen.getByLabelText(/^Маршрут/)).toHaveValue("openai-api");
    expect(screen.getByLabelText(/^Модель/)).toHaveValue("gpt-5.6-sol");
    expect(screen.getByLabelText(/^Общий потолок/)).toHaveValue(10);
    expect(screen.getByLabelText(/^Потолок одного/)).toHaveValue(3);
    expect(screen.getByText("Заблокировано — источник оплаты не проверяется")).toBeVisible();
    expect(screen.getByText(/Автоматического переключения.*нет/)).toBeVisible();
    expect(screen.getByText(/не отличает включённый лимит от.*ChatGPT credits/)).toBeVisible();
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelector('[name="LLM_API_KEY"]')).toBeNull();
  });

  it("различает статус рабочего API и заблокированной subscription", () => {
    const { unmount } = render(
      <LlmSettings initial={{ ...DEFAULT_LLM_PROFILE, LLM_ENABLED: "1" }} />,
    );
    expect(screen.getByText("Готовность неизвестна")).toBeVisible();

    unmount();
    render(
      <LlmSettings
        initial={{
          ...DEFAULT_LLM_PROFILE,
          LLM_ENABLED: "1",
          LLM_ROUTE: "codex-subscription",
        }}
      />,
    );
    expect(screen.getByText("Среда выполнения не готова")).toBeVisible();
  });

  it("передаёт все восемь полей одной server action", async () => {
    mocks.saveLlmProfile.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<LlmSettings initial={{ ...DEFAULT_LLM_PROFILE }} />);

    await user.click(screen.getByLabelText(/^Использовать LLM/));
    await user.selectOptions(screen.getByLabelText(/^Маршрут/), "openai-api");
    const model = screen.getByLabelText(/^Модель/);
    await user.clear(model);
    await user.type(model, "gpt-5.6-terra");
    const daily = screen.getByLabelText(/^Общий потолок/);
    await user.clear(daily);
    await user.type(daily, "12");
    const call = screen.getByLabelText(/^Потолок одного/);
    await user.clear(call);
    await user.type(call, "2.5");
    await user.click(screen.getByText("Расширенные настройки"));
    await user.type(screen.getByLabelText(/^Резервные модели/), "gpt-5.6-luna");

    await user.click(screen.getByRole("button", { name: "Сохранить настройки" }));
    await waitFor(() => expect(mocks.saveLlmProfile).toHaveBeenCalledOnce());

    const form = mocks.saveLlmProfile.mock.calls[0]?.[0] as FormData;
    expect(Object.fromEntries(form.entries())).toEqual({
      LLM_ENABLED: "1",
      LLM_ROUTE: "openai-api",
      LLM_MODEL: "gpt-5.6-terra",
      LLM_GLOBAL_DAILY_BUDGET_USD: "12",
      LLM_MAX_RESERVATION_USD: "2.5",
      LLM_BASE_URL: "https://api.openai.com/v1",
      LLM_PRICE_PROVIDER_ID: "openai",
      LLM_FALLBACK_MODELS: "gpt-5.6-luna",
    });
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("после отказа Core показывает ошибку и сохраняет введённые поля", async () => {
    mocks.saveLlmProfile.mockResolvedValue({ ok: false, error: "Preflight ещё не пройден" });
    const user = userEvent.setup();
    render(<LlmSettings initial={{ ...DEFAULT_LLM_PROFILE }} />);

    const enabled = screen.getByLabelText(/^Использовать LLM/);
    await user.click(enabled);
    const route = screen.getByLabelText(/^Маршрут/);
    await user.selectOptions(route, "openai-api");
    const model = screen.getByLabelText(/^Модель/);
    await user.clear(model);
    await user.type(model, "gpt-custom");
    const daily = screen.getByLabelText(/^Общий потолок/);
    await user.clear(daily);
    await user.type(daily, "9");
    const call = screen.getByLabelText(/^Потолок одного/);
    await user.clear(call);
    await user.type(call, "1.75");
    await user.click(screen.getByText("Расширенные настройки"));
    const baseUrl = screen.getByLabelText(/^Базовый URL OpenAI-совместимого API/);
    await user.clear(baseUrl);
    await user.type(baseUrl, "https://gateway.invalid/v1");
    const provider = screen.getByLabelText(/^ID провайдера тарифов/);
    await user.clear(provider);
    await user.type(provider, "custom-provider");
    const fallbacks = screen.getByLabelText(/^Резервные модели/);
    await user.type(fallbacks, "gpt-backup");

    await user.click(screen.getByRole("button", { name: "Сохранить настройки" }));

    expect(await screen.findByText("Preflight ещё не пройден")).toBeVisible();
    expect(enabled).toBeChecked();
    expect(route).toHaveValue("openai-api");
    expect(model).toHaveValue("gpt-custom");
    expect(daily).toHaveValue(9);
    expect(call).toHaveValue(1.75);
    expect(baseUrl).toHaveValue("https://gateway.invalid/v1");
    expect(provider).toHaveValue("custom-provider");
    expect(fallbacks).toHaveValue("gpt-backup");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("после обрыва server action показывает ошибку и не теряет draft", async () => {
    mocks.saveLlmProfile.mockRejectedValue(new Error("Связь с Core оборвалась"));
    const user = userEvent.setup();
    render(<LlmSettings initial={{ ...DEFAULT_LLM_PROFILE }} />);

    const model = screen.getByLabelText(/^Модель/);
    await user.clear(model);
    await user.type(model, "gpt-draft");
    await user.click(screen.getByRole("button", { name: "Сохранить настройки" }));

    expect(await screen.findByText("Связь с Core оборвалась")).toBeVisible();
    expect(model).toHaveValue("gpt-draft");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
