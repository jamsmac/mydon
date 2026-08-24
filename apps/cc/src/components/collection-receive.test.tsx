import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CollectionReceive } from "./collection-receive";

const mocks = vi.hoisted(() => ({
  cancelCollection: vi.fn(),
  receiveCollection: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("../app/collections/actions", () => ({
  cancelCollection: mocks.cancelCollection,
  receiveCollection: mocks.receiveCollection,
}));

describe("CollectionReceive", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("блокирует приём, пока сумма купюр не совпадает", async () => {
    const user = userEvent.setup();
    render(<CollectionReceive id="collection-1" />);

    await user.type(screen.getByPlaceholderText("сумма, сум"), "10000");
    await user.click(screen.getByRole("button", { name: "По купюрам" }));
    await user.type(screen.getByLabelText("купюр номиналом 5 000 сум"), "1");

    expect(screen.getByText(/Купюры дают 5 000 сум, введено 10 000 сум/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Принять" })).toBeDisabled();
    expect(mocks.receiveCollection).not.toHaveBeenCalled();
  });

  it("отправляет проверенную сумму и разбивку купюр", async () => {
    mocks.receiveCollection.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<CollectionReceive id="collection-1" />);

    await user.type(screen.getByPlaceholderText("сумма, сум"), "10000");
    await user.click(screen.getByRole("button", { name: "По купюрам" }));
    await user.type(screen.getByLabelText("купюр номиналом 5 000 сум"), "2");
    await user.click(screen.getByRole("button", { name: "Принять" }));

    await waitFor(() =>
      expect(mocks.receiveCollection).toHaveBeenCalledWith("collection-1", "10000", {
        "5000": 2,
      }),
    );
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("показывает отказ Core и не обновляет страницу", async () => {
    mocks.receiveCollection.mockResolvedValue({ ok: false, error: "Инкассация уже принята" });
    const user = userEvent.setup();
    render(<CollectionReceive id="collection-1" />);

    await user.type(screen.getByPlaceholderText("сумма, сум"), "10000");
    await user.click(screen.getByRole("button", { name: "Принять" }));

    expect(await screen.findByText("Инкассация уже принята")).toBeVisible();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
