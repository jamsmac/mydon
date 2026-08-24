import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MenuEditor } from "./menu-editor";

const mocks = vi.hoisted(() => ({
  copyMenuFrom: vi.fn(),
  createMenuProduct: vi.fn(),
  refresh: vi.fn(),
  saveMenu: vi.fn(),
  setProductCategory: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("../app/card/actions", () => ({
  copyMenuFrom: mocks.copyMenuFrom,
  createMenuProduct: mocks.createMenuProduct,
  saveMenu: mocks.saveMenu,
  setProductCategory: mocks.setProductCategory,
}));

describe("редактор меню", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("показывает ошибку создания товара и сохраняет введённые поля", async () => {
    mocks.createMenuProduct.mockResolvedValue({ ok: false, error: "Товар уже существует" });
    const user = userEvent.setup();
    render(
      <MenuEditor
        machineId="machine-1"
        domain="vendhub"
        menu={[]}
        products={[]}
        machines={[]}
        history={{}}
        unlinked={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "+ Новый товар" }));
    const name = screen.getByLabelText("Название");
    await user.type(name, "Cappuccino 250ml");
    await user.selectOptions(screen.getByLabelText("Категория"), "10");
    await user.type(screen.getByLabelText("Цена, сум"), "25000");
    await user.click(screen.getByRole("button", { name: "Создать и в меню" }));

    expect(await screen.findByText("Товар уже существует")).toBeVisible();
    expect(mocks.createMenuProduct).toHaveBeenCalledWith(
      "vendhub",
      "machine-1",
      expect.any(FormData),
    );
    const form = mocks.createMenuProduct.mock.calls[0]?.[2] as FormData;
    expect(form.get("name")).toBe("Cappuccino 250ml");
    expect(form.get("price")).toBe("25000");
    expect(name).toHaveValue("Cappuccino 250ml");
  });

  it("передаёт черновик меню и показывает конфликт Core", async () => {
    mocks.saveMenu.mockResolvedValue({ ok: false, error: "Меню изменилось в другом окне" });
    const user = userEvent.setup();
    render(
      <MenuEditor
        machineId="machine-1"
        domain="vendhub"
        menu={[]}
        products={[{ id: "product-1", name: "Latte", cat: 10, price: 20000 }]}
        machines={[]}
        history={{}}
        unlinked={[]}
      />,
    );

    await user.selectOptions(screen.getByRole("combobox"), "product-1");
    await user.click(screen.getByRole("button", { name: "В меню" }));
    await user.click(screen.getByRole("button", { name: "Сохранить меню" }));

    expect(await screen.findByText("Меню изменилось в другом окне")).toBeVisible();
    expect(mocks.saveMenu).toHaveBeenCalledWith(
      "machine-1",
      [{ productId: "product-1", price: null }],
      "[]",
    );
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
