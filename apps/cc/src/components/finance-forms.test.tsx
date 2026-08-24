import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FlowRowActions, FxForm, NewFlowForm } from "./finance-forms";

const mocks = vi.hoisted(() => ({
  cancelFinanceFlow: vi.fn(),
  createFinanceFlow: vi.fn(),
  payFinanceFlow: vi.fn(),
  refresh: vi.fn(),
  refreshFxRates: vi.fn(),
  setFxRate: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("../app/finance/actions", () => ({
  cancelFinanceFlow: mocks.cancelFinanceFlow,
  createFinanceFlow: mocks.createFinanceFlow,
  payFinanceFlow: mocks.payFinanceFlow,
  refreshFxRates: mocks.refreshFxRates,
  setFxRate: mocks.setFxRate,
}));

describe("финансовые формы", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("передаёт валютный платёж и сохраняет сумму при ошибке Core", async () => {
    mocks.createFinanceFlow.mockResolvedValue({ ok: false, message: "Курс устарел" });
    const user = userEvent.setup();
    render(<NewFlowForm domain="globerent" counterparties={[]} fx={[]} />);

    await user.click(screen.getByRole("button", { name: "+ Долг или платёж" }));
    const amount = screen.getByLabelText("Сумма");
    await user.type(amount, "150000");
    await user.selectOptions(screen.getByLabelText("Валюта"), "USD");
    await user.type(screen.getByLabelText(/Курс к суму/), "12600");
    await user.type(screen.getByLabelText("Назначение словами"), "Предоплата");
    await user.click(screen.getByRole("button", { name: "Записать" }));

    expect(await screen.findByText("Курс устарел")).toBeVisible();
    expect(mocks.createFinanceFlow).toHaveBeenCalledWith("globerent", expect.any(FormData));
    const form = mocks.createFinanceFlow.mock.calls[0]?.[1] as FormData;
    expect(form.get("amount")).toBe("150000");
    expect(form.get("currency")).toBe("USD");
    expect(form.get("rate")).toBe("12600");
    expect(amount).toHaveValue("150000");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("не отменяет финансовую запись без подтверждения", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    render(<FlowRowActions domain="globerent" id="flow-1" status="planned" />);

    await user.click(screen.getByRole("button", { name: "✕" }));

    expect(window.confirm).toHaveBeenCalled();
    expect(mocks.cancelFinanceFlow).not.toHaveBeenCalled();
  });

  it("показывает ошибку курса и не очищает введённое значение", async () => {
    mocks.setFxRate.mockResolvedValue({ ok: false, message: "Курс должен быть положительным" });
    const user = userEvent.setup();
    render(<FxForm domain="globerent" />);

    const rate = screen.getByLabelText("Сумов за единицу");
    await user.type(rate, "-1");
    await user.type(screen.getByLabelText("Заметка"), "ручной ввод");
    await user.click(screen.getByRole("button", { name: "Задать курс" }));

    expect(await screen.findByText("Курс должен быть положительным")).toBeVisible();
    const form = mocks.setFxRate.mock.calls[0]?.[1] as FormData;
    expect(form.get("rate")).toBe("-1");
    expect(rate).toHaveValue("-1");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
