import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GrUnit } from "../lib/core";
import { UnitsPanel } from "./units-panel";

const mocks = vi.hoisted(() => ({
  cancelUnitReserve: vi.fn(),
  createUnit: vi.fn(),
  refresh: vi.fn(),
  reserveUnit: vi.fn(),
  setUnitSalesStage: vi.fn(),
  setUnitVin: vi.fn(),
  unitAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("../app/units/actions", () => ({
  cancelUnitReserve: mocks.cancelUnitReserve,
  createUnit: mocks.createUnit,
  reserveUnit: mocks.reserveUnit,
  setUnitSalesStage: mocks.setUnitSalesStage,
  setUnitVin: mocks.setUnitVin,
  unitAction: mocks.unitAction,
}));

function unit(status: string): GrUnit {
  return {
    id: `unit-${status}`,
    domain: "globerent",
    code: "GR-001",
    modelId: null,
    name: "HELI CPCD30",
    year: 2026,
    vin: "VIN001",
    status,
    salesStage: null,
    lostReason: null,
    salesPrice: null,
    clientId: null,
    contractId: null,
    arrivalDate: null,
    declarationType: null,
    declarationNumber: null,
    declarationDate: null,
    transportCompany: null,
    notes: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    clientName: null,
    activeReserve: null,
    costUzs: 0,
  };
}

describe("формы склада техники", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("передаёт новую единицу и сохраняет VIN при ошибке", async () => {
    mocks.createUnit.mockResolvedValue({ ok: false, message: "VIN уже занят" });
    const user = userEvent.setup();
    render(<UnitsPanel units={[]} summary={[]} clients={[]} />);

    await user.click(screen.getByRole("button", { name: "+ Единица техники" }));
    await user.type(screen.getByLabelText("Название (модель, комплектация)"), "HELI CPCD35");
    const vin = screen.getByLabelText("VIN — если уже известен");
    await user.type(vin, "VIN-DUPLICATE");
    await user.click(screen.getByRole("button", { name: "Добавить" }));

    expect(await screen.findByText("VIN уже занят")).toBeVisible();
    const form = mocks.createUnit.mock.calls[0]?.[0] as FormData;
    expect(form.get("name")).toBe("HELI CPCD35");
    expect(form.get("vin")).toBe("VIN-DUPLICATE");
    expect(vin).toHaveValue("VIN-DUPLICATE");
  });

  it("передаёт номер и дату ГТД перехода, сохраняя их при отказе", async () => {
    mocks.unitAction.mockResolvedValue({ ok: false, message: "Переход уже выполнен" });
    const user = userEvent.setup();
    render(<UnitsPanel units={[unit("AT_BORDER")]} summary={[]} clients={[]} />);

    await user.click(screen.getByRole("button", { name: "ГТД ИМ-74" }));
    const declaration = screen.getByLabelText("Номер ГТД");
    await user.type(declaration, "IM74-77");
    await user.type(screen.getByLabelText("Дата ГТД"), "2026-08-24");
    await user.click(screen.getByRole("button", { name: "Подтвердить" }));

    expect(await screen.findByText("Переход уже выполнен")).toBeVisible();
    expect(mocks.unitAction).toHaveBeenCalledWith("unit-AT_BORDER", "mark-customs-im74", {
      declarationDate: "2026-08-24",
      declarationNumber: "IM74-77",
    });
    expect(declaration).toHaveValue("IM74-77");
  });

  it("передаёт реквизиты резерва и не закрывает форму при ошибке", async () => {
    mocks.reserveUnit.mockResolvedValue({ ok: false, message: "Дата резерва в прошлом" });
    const user = userEvent.setup();
    render(
      <UnitsPanel
        units={[unit("IN_STOCK")]}
        summary={[]}
        clients={[{ id: "client-1", name: "ООО Клиент", inn: "123" }]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "резерв" }));
    const endDate = screen.getByLabelText("Держим до");
    await user.type(endDate, "2026-08-20");
    await user.selectOptions(screen.getByLabelText("Клиент"), "client-1");
    await user.type(screen.getByLabelText("Заметка"), "Для тендера");
    await user.click(screen.getByRole("button", { name: "Поставить резерв" }));

    expect(await screen.findByText("Дата резерва в прошлом")).toBeVisible();
    const form = mocks.reserveUnit.mock.calls[0]?.[1] as FormData;
    expect(form.get("endDate")).toBe("2026-08-20");
    expect(form.get("clientId")).toBe("client-1");
    expect(endDate).toHaveValue("2026-08-20");
  });
});
