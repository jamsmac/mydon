import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VendingProductRow } from "../lib/core";
import { ProductFiscalForm } from "./product-fiscal-form";

const mocks = vi.hoisted(() => ({
  onDone: vi.fn(),
  refresh: vi.fn(),
  saveVendingProductFiscal: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("../app/vending/actions", () => ({
  saveVendingProductFiscal: mocks.saveVendingProductFiscal,
  saveVendingProductRules: vi.fn(),
  submitVendingPurchase: vi.fn(),
}));

const row: VendingProductRow = {
  id: "p-lit",
  name: "Lit Energy Blueberry CAN 0,45",
  category: "drink",
  purchasePrice: 9000,
  salePrice: 15000,
  packSize: 12,
  isActive: true,
  excludedFromPurchase: false,
  fixedPurchaseQty: null,
  fiscal: { ikpu: null, mxik: null, vatPct: 12, barcode: null, packageCode: "796", marked: false },
};

describe("Форма «Фискальные данные»", () => {
  beforeEach(() => vi.resetAllMocks());

  it("отказ Core сохраняет введённые 17 цифр", async () => {
    mocks.saveVendingProductFiscal.mockResolvedValue({
      ok: false,
      message: "ИКПУ должен быть 17 цифр или пусто",
    });
    const user = userEvent.setup();
    render(<ProductFiscalForm domain="vendhub" row={row} onDone={mocks.onDone} />);
    const ikpu = screen.getByLabelText("ИКПУ");
    await user.type(ikpu, "02202003001086002");
    await user.click(screen.getByRole("button", { name: "Сохранить фискальные данные" }));
    expect(await screen.findByText("ИКПУ должен быть 17 цифр или пусто")).toBeVisible();
    expect(ikpu).toHaveValue("02202003001086002");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("показывает точную причину Core, а не общий отказ", async () => {
    mocks.saveVendingProductFiscal.mockResolvedValue({
      ok: false,
      message: "Код упаковки — 3 цифры ОКЕИ",
    });
    const user = userEvent.setup();
    render(<ProductFiscalForm domain="vendhub" row={row} onDone={mocks.onDone} />);
    await user.click(screen.getByRole("button", { name: "Сохранить фискальные данные" }));
    expect(await screen.findByText("Код упаковки — 3 цифры ОКЕИ")).toBeVisible();
    expect(screen.queryByText("Не получилось")).toBeNull();
  });

  it("успех обновляет страницу и закрывает форму", async () => {
    const message = "Фискальные данные «Lit Energy Blueberry CAN 0,45» сохранены";
    mocks.saveVendingProductFiscal.mockResolvedValue({ ok: true, message });
    const user = userEvent.setup();
    render(<ProductFiscalForm domain="vendhub" row={row} onDone={mocks.onDone} />);
    await user.click(screen.getByRole("button", { name: "Сохранить фискальные данные" }));
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    expect(mocks.onDone).toHaveBeenCalledWith(message);
  });

  it("НДС, ОКЕИ и маркировка выбираются из словарей", () => {
    render(<ProductFiscalForm domain="vendhub" row={row} onDone={mocks.onDone} />);
    expect(screen.getByLabelText("Ставка НДС").tagName).toBe("SELECT");
    expect(screen.getByLabelText("Код упаковки (ОКЕИ)").tagName).toBe("SELECT");
    expect(screen.getByLabelText("Маркировка (КИЗ)").tagName).toBe("SELECT");
    expect(screen.queryByRole("option", { name: /1218841/ })).toBeNull();
    expect(screen.getByRole("option", { name: /Штука/ })).toBeInTheDocument();
  });

  it("пустое поле ИКПУ уходит как сброс", async () => {
    mocks.saveVendingProductFiscal.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    const заполненный = { ...row, fiscal: { ...row.fiscal, ikpu: "02202003001086002" } };
    render(<ProductFiscalForm domain="vendhub" row={заполненный} onDone={mocks.onDone} />);
    await user.clear(screen.getByLabelText("ИКПУ"));
    await user.click(screen.getByRole("button", { name: "Сохранить фискальные данные" }));
    const form = mocks.saveVendingProductFiscal.mock.calls[0]?.[1] as FormData;
    expect(form.get("ikpu")).toBe("");
  });

  it("подпись ОКЕИ отделяет единицу измерения от каталога", () => {
    render(<ProductFiscalForm domain="vendhub" row={row} onDone={mocks.onDone} />);
    expect(screen.getByText(/единица измерения, не идентификатор каталога/i)).toBeVisible();
  });

  it("показывает точную дыру сохранённого кода", () => {
    const неверный = { ...row, fiscal: { ...row.fiscal, ikpu: "2202002001010032" } };
    render(<ProductFiscalForm domain="vendhub" row={неверный} onDone={mocks.onDone} />);
    expect(screen.getByText("ИКПУ: должно быть 17 цифр, а тут 16")).toBeVisible();
  });
});
