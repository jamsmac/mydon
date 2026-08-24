import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCard } from "../lib/core";
import { AgentEditor } from "./agent-editor";
import { NewAgentForm } from "./agent-new";

const mocks = vi.hoisted(() => ({
  createAgent: vi.fn(),
  deleteAgent: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  saveAgent: vi.fn(),
  toggleAgent: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));

vi.mock("../app/agents/actions", () => ({
  createAgent: mocks.createAgent,
  deleteAgent: mocks.deleteAgent,
  saveAgent: mocks.saveAgent,
  toggleAgent: mocks.toggleAgent,
}));

const agent: AgentCard = {
  id: "agent-1",
  name: "finance",
  business: "shared",
  status: "paused",
  autonomyDefault: "T1",
  description: "Финансовый контроль",
  mission: "Следить за платежами",
  nonGoals: ["Не платит сам"],
  skills: ["watch-money"],
  schedule: [{ cron: "0 9 * * *", skill: "watch-money" }],
  budgetPerDayUsd: "3",
  budgetOnExceeded: "ask",
  ideaChannels: [],
  webSources: [],
  breakGlass: [],
  archivedAt: null,
  updatedAt: "2026-08-24T00:00:00.000Z",
};

describe("формы агентов", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("передаёт конфигурацию нового агента и не очищает её при ошибке", async () => {
    mocks.createAgent.mockResolvedValue({ ok: false, error: "Имя уже занято" });
    const user = userEvent.setup();
    render(<NewAgentForm />);

    await user.click(screen.getByRole("button", { name: "+ Новый агент" }));
    const name = screen.getByLabelText(/Имя \(машинное\)/);
    await user.type(name, "stock-watch");
    await user.selectOptions(screen.getByLabelText("Направление"), "vendhub");
    await user.type(screen.getByLabelText("Короткое описание"), "Контроль остатков");
    await user.click(screen.getByRole("button", { name: "Создать" }));

    expect(await screen.findByText("Имя уже занято")).toBeVisible();
    const form = mocks.createAgent.mock.calls[0]?.[0] as FormData;
    expect(form.get("name")).toBe("stock-watch");
    expect(form.get("business")).toBe("vendhub");
    expect(name).toHaveValue("stock-watch");
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("сохраняет отредактированную конфигурацию при отказе API", async () => {
    mocks.saveAgent.mockResolvedValue({ ok: false, error: "Некорректный cron" });
    const user = userEvent.setup();
    render(<AgentEditor agent={agent} />);

    const mission = screen.getByLabelText("Зачем нужен (миссия)");
    await user.clear(mission);
    await user.type(mission, "Сверять деньги каждый день");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));

    expect(await screen.findByText("Некорректный cron")).toBeVisible();
    const form = mocks.saveAgent.mock.calls[0]?.[1] as FormData;
    expect(form.get("mission")).toBe("Сверять деньги каждый день");
    expect(mission).toHaveValue("Сверять деньги каждый день");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("показывает ошибку включения агента", async () => {
    mocks.toggleAgent.mockResolvedValue({ ok: false, error: "Расписания на паузе" });
    const user = userEvent.setup();
    render(<AgentEditor agent={agent} />);

    await user.click(screen.getByRole("button", { name: "Включить" }));

    expect(await screen.findByText("Расписания на паузе")).toBeVisible();
    expect(mocks.toggleAgent).toHaveBeenCalledWith("finance", true);
  });

  it("удаляет агента только после второго подтверждающего действия", async () => {
    mocks.deleteAgent.mockResolvedValue({ ok: true, goTo: "/agents" });
    const user = userEvent.setup();
    render(<AgentEditor agent={agent} />);

    await user.click(screen.getByRole("button", { name: "Удалить агента" }));
    expect(mocks.deleteAgent).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Да, удалить" }));

    expect(mocks.deleteAgent).toHaveBeenCalledWith("finance");
    expect(mocks.push).toHaveBeenCalledWith("/agents");
  });
});
