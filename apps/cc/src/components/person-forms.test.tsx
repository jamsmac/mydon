import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Person } from "../lib/core";
import { PersonEditor } from "./person-editor";
import { NewPersonForm } from "./person-new";

const mocks = vi.hoisted(() => ({
  createPerson: vi.fn(),
  refresh: vi.fn(),
  savePerson: vi.fn(),
  setPersonActive: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("../app/team/actions", () => ({
  createPerson: mocks.createPerson,
  savePerson: mocks.savePerson,
  setPersonActive: mocks.setPersonActive,
}));

const person: Person = {
  id: "person-1",
  name: "Рустам",
  role: "оператор",
  domain: "vendhub",
  email: "rustam@example.com",
  phone: "+998901234567",
  tgUsername: "@rustam",
  tgChatId: null,
  active: "yes",
  createdAt: "2026-08-24T00:00:00.000Z",
};

describe("формы сотрудников", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("передаёт данные нового сотрудника и сохраняет их при ошибке Core", async () => {
    mocks.createPerson.mockResolvedValue({ ok: false, error: "Телефон уже занят" });
    const user = userEvent.setup();
    render(<NewPersonForm />);

    await user.click(screen.getByRole("button", { name: "+ Сотрудник" }));
    const name = screen.getByLabelText("Имя");
    await user.type(name, "Дилшод");
    await user.type(screen.getByLabelText("Кто он"), "инженер");
    await user.selectOptions(screen.getByLabelText("Направление"), "globerent");
    await user.type(screen.getByLabelText("Телефон"), "+998909999999");
    await user.click(screen.getByRole("button", { name: "Добавить" }));

    expect(await screen.findByText("Телефон уже занят")).toBeVisible();
    const form = mocks.createPerson.mock.calls[0]?.[0] as FormData;
    expect(form.get("name")).toBe("Дилшод");
    expect(form.get("role")).toBe("инженер");
    expect(form.get("domain")).toBe("globerent");
    expect(name).toHaveValue("Дилшод");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("сохраняет изменённые данные сотрудника при отказе API", async () => {
    mocks.savePerson.mockResolvedValue({ ok: false, error: "Версия записи устарела" });
    const user = userEvent.setup();
    render(<PersonEditor person={person} />);

    const name = screen.getByLabelText("Имя");
    await user.clear(name);
    await user.type(name, "Рустам Алиев");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));

    expect(await screen.findByText("Версия записи устарела")).toBeVisible();
    const form = mocks.savePerson.mock.calls[0]?.[1] as FormData;
    expect(mocks.savePerson).toHaveBeenCalledWith("person-1", expect.any(FormData));
    expect(form.get("name")).toBe("Рустам Алиев");
    expect(name).toHaveValue("Рустам Алиев");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("показывает ошибку переключения рабочего статуса", async () => {
    mocks.setPersonActive.mockResolvedValue({ ok: false, error: "Нет права менять статус" });
    const user = userEvent.setup();
    render(<PersonEditor person={person} />);

    await user.click(screen.getByRole("button", { name: "Больше не работает" }));

    expect(await screen.findByText("Нет права менять статус")).toBeVisible();
    expect(mocks.setPersonActive).toHaveBeenCalledWith("person-1", false);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
