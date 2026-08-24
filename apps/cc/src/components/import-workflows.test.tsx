import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImportContractActions } from "./import-actions";
import { ImportsPanel } from "./imports-panel";

const mocks = vi.hoisted(() => ({
  bulkImportAction: vi.fn(),
  cancelImport: vi.fn(),
  createImport: vi.fn(),
  markImportPaid: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  signImport: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));

vi.mock("../app/imports/actions", () => ({
  bulkImportAction: mocks.bulkImportAction,
  cancelImport: mocks.cancelImport,
  createImport: mocks.createImport,
  markImportPaid: mocks.markImportPaid,
  signImport: mocks.signImport,
}));

describe("формы импортных контрактов", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("передаёт спецификацию импорта и сохраняет её при ошибке", async () => {
    mocks.createImport.mockResolvedValue({ ok: false, message: "Номер контракта занят" });
    const user = userEvent.setup();
    render(<ImportsPanel imports={[]} suppliers={[]} />);

    await user.click(screen.getByRole("button", { name: "+ Импортный контракт" }));
    const contractNo = screen.getByLabelText("Номер контракта");
    await user.type(contractNo, "HL-2026-015");
    const item = screen.getByPlaceholderText("HELI CPCD30");
    await user.type(item, "HELI CPD25");
    await user.clear(screen.getByPlaceholderText("шт"));
    await user.type(screen.getByPlaceholderText("шт"), "3");
    await user.type(screen.getByPlaceholderText("цена"), "19000");
    await user.click(screen.getByRole("button", { name: "Создать контракт" }));

    expect(await screen.findByText("Номер контракта занят")).toBeVisible();
    const form = mocks.createImport.mock.calls[0]?.[0] as FormData;
    expect(form.get("contractNo")).toBe("HL-2026-015");
    expect(JSON.parse(String(form.get("items")))).toEqual([
      { name: "HELI CPD25", qty: 3, price: 19000 },
    ]);
    expect(contractNo).toHaveValue("HL-2026-015");
    expect(item).toHaveValue("HELI CPD25");
  });

  it("передаёт реквизиты ГТД массового перехода и показывает ошибку", async () => {
    mocks.bulkImportAction.mockResolvedValue({ ok: false, message: "Номер ГТД обязателен" });
    const user = userEvent.setup();
    render(
      <ImportContractActions
        id="import-1"
        status="in_progress"
        prepaymentPaid
        balancePaid
        hasPrepayment
        hasBalance
      />,
    );

    await user.click(screen.getByRole("button", { name: "все: ГТД ИМ-74" }));
    const declaration = screen.getByLabelText("Номер ГТД");
    await user.type(declaration, "IM74-9988");
    await user.type(screen.getByLabelText("Дата ГТД"), "2026-08-24");
    await user.click(screen.getByRole("button", { name: "Применить ко всем" }));

    expect(await screen.findByText("Номер ГТД обязателен")).toBeVisible();
    expect(mocks.bulkImportAction).toHaveBeenCalledWith("import-1", "mark-customs-im74", {
      declarationDate: "2026-08-24",
      declarationNumber: "IM74-9988",
    });
    expect(declaration).toHaveValue("IM74-9988");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("не отменяет импортный контракт без подтверждения", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    render(
      <ImportContractActions
        id="import-1"
        status="draft"
        prepaymentPaid={false}
        balancePaid={false}
        hasPrepayment={false}
        hasBalance={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "отменить" }));

    expect(window.confirm).toHaveBeenCalled();
    expect(mocks.cancelImport).not.toHaveBeenCalled();
  });
});
