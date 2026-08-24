import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeleteEntityButton } from "./entity-delete";

const mocks = vi.hoisted(() => ({
  deleteEntity: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));

vi.mock("../app/card/actions", () => ({
  deleteEntity: mocks.deleteEntity,
}));

describe("DeleteEntityButton", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("не удаляет запись без явного подтверждения", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    render(<DeleteEntityButton id="entity-1" domain="vendhub" type="product" name="Кофе" />);

    await user.click(screen.getByRole("button", { name: "Удалить запись" }));

    expect(window.confirm).toHaveBeenCalledWith("Удалить «Кофе»? Содержимое останется в журнале.");
    expect(mocks.deleteEntity).not.toHaveBeenCalled();
  });

  it("после подтверждения удаляет и возвращает в каталог направления", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mocks.deleteEntity.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<DeleteEntityButton id="entity-1" domain="vendhub" type="product" name="Кофе" />);

    await user.click(screen.getByRole("button", { name: "Удалить запись" }));

    await waitFor(() => expect(mocks.deleteEntity).toHaveBeenCalledWith("entity-1", "vendhub"));
    expect(mocks.push).toHaveBeenCalledWith("/domain/vendhub?tab=settings:product");
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("показывает ошибку удаления и остаётся на карточке", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mocks.deleteEntity.mockResolvedValue({ ok: false, error: "Есть связанные операции" });
    const user = userEvent.setup();
    render(<DeleteEntityButton id="entity-1" domain="globerent" type="unit" name="GR-01" />);

    await user.click(screen.getByRole("button", { name: "Удалить запись" }));

    expect(await screen.findByText("Есть связанные операции")).toBeVisible();
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
