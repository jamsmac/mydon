import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Person } from "../lib/core";
import { QuickAdd } from "./task-quick-add";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  quickAddTask: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));

vi.mock("../app/tasks/actions", () => ({
  quickAddTask: mocks.quickAddTask,
}));

const person: Person = {
  id: "person-1",
  name: "Рустам",
  role: "оператор",
  domain: "vendhub",
  email: null,
  phone: null,
  tgUsername: null,
  tgChatId: "123",
  active: "yes",
  createdAt: "2026-08-24T00:00:00.000Z",
};

describe("QuickAdd", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("передаёт заполненную форму и срочный приоритет, затем очищает её", async () => {
    mocks.quickAddTask.mockResolvedValue({ ok: true });
    const user = userEvent.setup();

    render(<QuickAdd people={[person]} agents={[{ name: "planner", status: "active" }]} />);

    const title = screen.getByPlaceholderText("Что нужно сделать?");
    await user.type(title, "Проверить автомат");
    await user.selectOptions(screen.getByRole("combobox", { name: "Направление" }), "vendhub");
    await user.selectOptions(screen.getByRole("combobox", { name: "Исполнитель" }), "human:person-1");
    await user.type(screen.getByPlaceholderText(/Когда\?/), "завтра");
    await user.click(screen.getByTitle("Срочно"));
    await user.click(screen.getByRole("button", { name: "Поставить" }));

    await waitFor(() => expect(mocks.quickAddTask).toHaveBeenCalledOnce());
    const form = mocks.quickAddTask.mock.calls[0]?.[0] as FormData;
    expect(form.get("title")).toBe("Проверить автомат");
    expect(form.get("domain")).toBe("vendhub");
    expect(form.get("owner")).toBe("human:person-1");
    expect(form.get("due")).toBe("завтра");
    expect(form.get("priority")).toBe("urgent");
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    expect(title).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Направление" })).toHaveValue("");
    expect(screen.getByTitle("Срочно")).not.toHaveClass("on");
  });

  it("показывает ошибку действия и сохраняет введённые данные", async () => {
    mocks.quickAddTask.mockResolvedValue({ ok: false, error: "Core временно недоступен" });
    const user = userEvent.setup();

    render(<QuickAdd people={[person]} agents={[]} />);
    const title = screen.getByPlaceholderText("Что нужно сделать?");
    await user.type(title, "Снять показания");
    await user.selectOptions(screen.getByRole("combobox", { name: "Направление" }), "vendhub");
    await user.selectOptions(screen.getByRole("combobox", { name: "Исполнитель" }), "human:person-1");
    await user.click(screen.getByRole("button", { name: "Поставить" }));

    expect(await screen.findByText("Core временно недоступен")).toBeVisible();
    expect(title).toHaveValue("Снять показания");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("объясняет отсутствие исполнителей", () => {
    render(<QuickAdd people={[]} agents={[]} />);

    expect(screen.getByText(/Сотрудников пока нет/)).toBeVisible();
  });

  it("требует canonical-направление", () => {
    render(<QuickAdd people={[person]} agents={[]} />);

    const direction = screen.getByRole("combobox", { name: "Направление" });
    expect(direction).toBeRequired();
    expect(Array.from(direction.querySelectorAll("option")).map((option) => option.value)).toEqual([
      "",
      "globerent",
      "vendhub",
      "personal",
      "mydon",
    ]);
  });
});
