import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Entity } from "../lib/core";
import { EntityEditor } from "./entity-editor";
import { NewEntityForm } from "./entity-new";
import { NewPlaceForm } from "./place-new";

const mocks = vi.hoisted(() => ({
  createEntity: vi.fn(),
  refresh: vi.fn(),
  saveEntity: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("next/dynamic", () => ({
  default: () => () => <div data-testid="map-picker" />,
}));

vi.mock("../app/card/actions", () => ({
  createEntity: mocks.createEntity,
  saveEntity: mocks.saveEntity,
}));

const entity: Entity = {
  id: "entity-1",
  domain: "vendhub",
  type: "product",
  name: "Капучино",
  externalRef: "CAP-01",
  attrs: { вид: "перепродажа", "цена покупки": 5000 },
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z",
};

describe("формы реестра", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("передаёт новую карточку товара и сохраняет поля при ошибке", async () => {
    mocks.createEntity.mockResolvedValue({ ok: false, error: "Такой код уже существует" });
    const user = userEvent.setup();
    render(<NewEntityForm domain="vendhub" type="product" label="товар" />);

    await user.click(screen.getByRole("button", { name: "+ товар" }));
    const name = screen.getByLabelText("Название");
    await user.type(name, "Латте");
    await user.type(screen.getByLabelText(/Номер или код/), "LATTE-01");
    await user.type(screen.getByLabelText("Цена, сум"), "22000");
    await user.click(screen.getByRole("button", { name: "Добавить" }));

    expect(await screen.findByText("Такой код уже существует")).toBeVisible();
    expect(mocks.createEntity).toHaveBeenCalledWith("vendhub", "product", expect.any(FormData));
    const form = mocks.createEntity.mock.calls[0]?.[2] as FormData;
    expect(form.get("name")).toBe("Латте");
    expect(form.get("price")).toBe("22000");
    expect(name).toHaveValue("Латте");
  });

  it("не теряет правки карточки при ошибке сохранения", async () => {
    mocks.saveEntity.mockResolvedValue({ ok: false, error: "Конфликт версии" });
    const user = userEvent.setup();
    render(<EntityEditor entity={entity} />);

    await user.click(screen.getByRole("button", { name: "Изменить" }));
    const name = screen.getByLabelText("Название");
    await user.clear(name);
    await user.type(name, "Капучино XL");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));

    expect(await screen.findByText("Конфликт версии")).toBeVisible();
    const form = mocks.saveEntity.mock.calls[0]?.[1] as FormData;
    expect(form.get("name")).toBe("Капучино XL");
    expect(name).toHaveValue("Капучино XL");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("передаёт координаты нового места и сохраняет их при отказе Core", async () => {
    mocks.createEntity.mockResolvedValue({ ok: false, error: "Координаты вне диапазона" });
    const user = userEvent.setup();
    render(<NewPlaceForm />);

    await user.click(screen.getByRole("button", { name: "+ Новое место" }));
    const name = screen.getByLabelText("Название");
    await user.type(name, "Склад Olma");
    await user.type(screen.getByLabelText("Широта"), "41.2995");
    await user.type(screen.getByLabelText("Долгота"), "69.2401");
    await user.click(screen.getByRole("button", { name: "Создать место" }));

    expect(await screen.findByText("Координаты вне диапазона")).toBeVisible();
    expect(mocks.createEntity).toHaveBeenCalledWith("vendhub", "location", expect.any(FormData));
    const form = mocks.createEntity.mock.calls[0]?.[2] as FormData;
    expect(form.get("lat")).toBe("41.2995");
    expect(form.get("lng")).toBe("69.2401");
    expect(name).toHaveValue("Склад Olma");
  });
});
