import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillDeck, SkillDeckItem } from "../lib/core";
import { SkillsDeck } from "./skills-deck";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  runSkill: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: mocks.refresh }),
}));

vi.mock("../app/skills/actions", () => ({
  runSkill: mocks.runSkill,
}));

/** Строка витрины: значения по умолчанию — «обычный рабочий навык кодом». */
function item(over: Partial<SkillDeckItem> = {}): SkillDeckItem {
  return {
    agent: "finance",
    skill: "watch-money",
    description: "Следит за платежами",
    executor: "code",
    tier: "T1",
    triggers: ["каждое утро"],
    allowedTools: ["Read"],
    modelEffort: null,
    maxTokens: null,
    hasCode: true,
    problems: [],
    agentStatus: "active",
    business: "shared",
    autonomyDefault: "T1",
    enabled: true,
    crons: [],
    tierFloor: "T1",
    duplicates: 1,
    lastRun: null,
    ...over,
  };
}

function deck(items: SkillDeckItem[]): SkillDeck {
  return {
    syncedAt: "2026-09-05T06:00:00.000Z",
    models: { primary: "claude-opus-5", fallbacks: [] },
    items,
  };
}

describe("витрина навыков", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("чип агента оставляет на экране только его навыки", async () => {
    const user = userEvent.setup();
    render(
      <SkillsDeck
        deck={deck([
          item(),
          item({ agent: "vendhub-ops", skill: "check-machines", business: "vendhub" }),
        ])}
      />,
    );

    expect(screen.getByRole("heading", { name: "watch-money" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "check-machines" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "vendhub-ops" }));

    expect(screen.queryByRole("heading", { name: "watch-money" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "check-machines" })).toBeVisible();
  });

  it("отказ Core объясняется словами, а введённый текст остаётся в поле", async () => {
    mocks.runSkill.mockResolvedValue({ ok: false, error: "Агент finance выключен" });
    const user = userEvent.setup();
    render(<SkillsDeck deck={deck([item()])} />);

    const input = screen.getByPlaceholderText("Вход задачи (необязательно)");
    await user.type(input, "Сверить оплаты за август");
    await user.click(screen.getByRole("button", { name: "Запустить" }));

    expect(await screen.findByText("Агент finance выключен")).toBeVisible();
    expect(input).toHaveValue("Сверить оплаты за август");
    const form = mocks.runSkill.mock.calls[0]?.[2] as FormData;
    expect(mocks.runSkill.mock.calls[0]?.[0]).toBe("finance");
    expect(mocks.runSkill.mock.calls[0]?.[1]).toBe("watch-money");
    expect(form.get("input")).toBe("Сверить оплаты за август");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("успешный запуск обновляет экран и даёт ссылку на поставленную задачу", async () => {
    mocks.runSkill.mockResolvedValue({ ok: true, taskId: "task-77", goTo: "/tasks/task-77" });
    const user = userEvent.setup();
    render(<SkillsDeck deck={deck([item()])} />);

    await user.click(screen.getByRole("button", { name: "Запустить" }));

    const link = await screen.findByRole("link", { name: "открыть задачу" });
    expect(link).toHaveAttribute("href", "/tasks/task-77");
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("у выключенного агента запуск недоступен и подсказывает, что сделать", () => {
    render(<SkillsDeck deck={deck([item({ agentStatus: "paused" })])} />);

    const button = screen.getByRole("button", { name: "Запустить" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Включи агента в его карточке");
  });

  it("нереализованный навык (executor code без кода) не запускается из deck", () => {
    render(<SkillsDeck deck={deck([item({ executor: "code", hasCode: false })])} />);

    const button = screen.getByRole("button", { name: "Запустить" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Навык ещё не реализован");
    expect(screen.getByText("не реализован")).toBeVisible();
  });

  it("llm-навык без кода реализован телом файла — запуск доступен", () => {
    render(<SkillsDeck deck={deck([item({ executor: "llm", hasCode: false })])} />);

    expect(screen.getByRole("button", { name: "Запустить" })).toBeEnabled();
    expect(screen.queryByText("не реализован")).not.toBeInTheDocument();
  });

  it("последний запуск виден словами, с причиной остановки и ссылкой в задачу", () => {
    render(
      <SkillsDeck
        deck={deck([
          item({
            lastRun: {
              taskId: "task-12",
              status: "in_progress",
              createdAt: "2026-09-04T09:00:00.000Z",
              completedAt: null,
              blockedReason: "нет ключа модели",
              resultNote: null,
            },
          }),
        ])}
      />,
    );

    expect(screen.getByText(/в работе/)).toBeVisible();
    expect(screen.getByText("Остановлен: нет ключа модели")).toBeVisible();
    expect(screen.getByRole("link", { name: "открыть" })).toHaveAttribute("href", "/tasks/task-12");
  });

  it("усилие модели предлагается только навыкам с исполнителем-моделью", () => {
    const { unmount } = render(<SkillsDeck deck={deck([item()])} />);
    expect(screen.queryByLabelText("Усилие модели")).not.toBeInTheDocument();
    unmount();

    render(<SkillsDeck deck={deck([item({ executor: "llm", modelEffort: "medium" })])} />);
    expect(screen.getByLabelText("Усилие модели")).toBeVisible();
  });
});
