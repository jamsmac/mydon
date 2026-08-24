import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TnvedRate } from "../lib/core";
import { CustomsRatesPanel } from "./customs-rates";

const mocks = vi.hoisted(() => ({
  deactivateTnvedRate: vi.fn(),
  refresh: vi.fn(),
  saveTnvedRate: vi.fn(),
  setBrvValue: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("../app/catalog/actions", () => ({
  deactivateTnvedRate: mocks.deactivateTnvedRate,
  saveTnvedRate: mocks.saveTnvedRate,
  setBrvValue: mocks.setBrvValue,
}));

const rate = {
  id: "rate-1",
  code: "8429519900",
  nameRu: "Погрузчик",
  importDutyRate: "0.05",
  customsFeeRate: "0.002",
  vatRate: "0.12",
  exciseRate: "0",
  utilizationBrvCount: 30,
  extraDutyPerCcUsd: "0",
  grossMassMinKg: null,
  grossMassMaxKg: null,
  engineTypeConstraint: null,
  notes: null,
} as TnvedRate;

describe("таможенные формы", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("сохраняет введённую БРВ при ошибке API", async () => {
    mocks.setBrvValue.mockResolvedValue({ ok: false, message: "Дата пересекается" });
    const user = userEvent.setup();
    render(<CustomsRatesPanel domain="globerent" rates={[]} brv={[]} />);

    const value = screen.getByLabelText("Сумов");
    await user.type(value, "412000");
    await user.type(screen.getByLabelText("Заметка"), "Постановление 2026");
    await user.click(screen.getByRole("button", { name: "Задать БРВ" }));

    expect(await screen.findByText("Дата пересекается")).toBeVisible();
    const form = mocks.setBrvValue.mock.calls[0]?.[1] as FormData;
    expect(form.get("valueUzs")).toBe("412000");
    expect(value).toHaveValue("412000");
  });

  it("передаёт новую ставку и не очищает код при отказе Core", async () => {
    mocks.saveTnvedRate.mockResolvedValue({ ok: false, message: "Код уже действует" });
    const user = userEvent.setup();
    render(<CustomsRatesPanel domain="globerent" rates={[]} brv={[]} />);

    await user.click(screen.getByRole("button", { name: "+ Ставка ТН ВЭД" }));
    const code = screen.getByLabelText("Код ТН ВЭД");
    await user.type(code, "8429519900");
    await user.type(screen.getByLabelText("Название товара"), "Погрузчик");
    await user.type(screen.getByLabelText("Пошлина, %"), "5");
    await user.click(screen.getByRole("button", { name: "Добавить ставку" }));

    expect(await screen.findByText("Код уже действует")).toBeVisible();
    const form = mocks.saveTnvedRate.mock.calls[0]?.[1] as FormData;
    expect(form.get("code")).toBe("8429519900");
    expect(form.get("dutyPct")).toBe("5");
    expect(code).toHaveValue("8429519900");
  });

  it("показывает ошибку деактивации и не обновляет страницу", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mocks.deactivateTnvedRate.mockResolvedValue({ ok: false, message: "Ставка используется" });
    const user = userEvent.setup();
    render(<CustomsRatesPanel domain="globerent" rates={[rate]} brv={[]} />);

    await user.click(screen.getByRole("button", { name: "✕" }));

    expect(window.confirm).toHaveBeenCalled();
    expect(await screen.findByText("Ставка используется")).toBeVisible();
    expect(mocks.deactivateTnvedRate).toHaveBeenCalledWith("globerent", "rate-1");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
