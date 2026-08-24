import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GrPreorder } from "../lib/core";
import { PreordersSection } from "./preorders-section";

const mocks = vi.hoisted(() => ({
  cancelPreorder: vi.fn(),
  createPreorder: vi.fn(),
  preorderAction: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("../app/preorders/actions", () => ({
  cancelPreorder: mocks.cancelPreorder,
  createPreorder: mocks.createPreorder,
  preorderAction: mocks.preorderAction,
}));

const preorder = {
  id: "preorder-1",
  domain: "globerent",
  code: "PO-001",
  modelId: null,
  name: "HELI CPD25",
  qty: 2,
  clientId: null,
  supplierId: null,
  contractRef: null,
  factoryPriceUsd: null,
  promisedDeliveryDate: null,
  status: "requested",
  cancelledReason: null,
  notes: null,
  createdBy: null,
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z",
  clientName: null,
} as GrPreorder;

describe("формы предзаказов", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("передаёт новый предзаказ и сохраняет название при ошибке", async () => {
    mocks.createPreorder.mockResolvedValue({
      ok: false,
      message: "Количество должно быть больше нуля",
    });
    const user = userEvent.setup();
    render(<PreordersSection preorders={[]} clients={[]} />);

    await user.click(screen.getByRole("button", { name: "+ Предзаказ" }));
    const name = screen.getByLabelText("Что заказываем");
    await user.type(name, "HELI CPD25");
    await user.clear(screen.getByLabelText("Количество"));
    await user.type(screen.getByLabelText("Количество"), "0");
    await user.click(screen.getByRole("button", { name: "Создать" }));

    expect(await screen.findByText("Количество должно быть больше нуля")).toBeVisible();
    const form = mocks.createPreorder.mock.calls[0]?.[0] as FormData;
    expect(form.get("name")).toBe("HELI CPD25");
    expect(form.get("qty")).toBe("0");
    expect(name).toHaveValue("HELI CPD25");
  });

  it("передаёт контракт и дату при заказе заводу", async () => {
    mocks.preorderAction.mockResolvedValue({ ok: false, message: "Контракт не найден" });
    const user = userEvent.setup();
    render(<PreordersSection preorders={[preorder]} clients={[]} />);

    await user.click(screen.getByRole("button", { name: "заказан заводу" }));
    const contract = screen.getByLabelText("Контракт завода (обязателен)");
    await user.type(contract, "HL-2026-015");
    await user.type(screen.getByLabelText("Обещанная поставка"), "2026-10-01");
    await user.click(screen.getByRole("button", { name: "Заказан" }));

    expect(await screen.findByText("Контракт не найден")).toBeVisible();
    expect(mocks.preorderAction).toHaveBeenCalledWith("preorder-1", "order", {
      contractRef: "HL-2026-015",
      promisedDeliveryDate: "2026-10-01",
    });
    expect(contract).toHaveValue("HL-2026-015");
  });

  it("обрезает причину отмены и показывает отказ Core", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("  клиент отказался  ");
    mocks.cancelPreorder.mockResolvedValue({ ok: false, message: "Предзаказ уже закрыт" });
    const user = userEvent.setup();
    render(<PreordersSection preorders={[preorder]} clients={[]} />);

    await user.click(screen.getByRole("button", { name: "✕" }));

    expect(mocks.cancelPreorder).toHaveBeenCalledWith("preorder-1", "клиент отказался");
    expect(await screen.findByText("Предзаказ уже закрыт")).toBeVisible();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
