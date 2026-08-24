import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoffeeContainerConsumptionReport, CoffeeLocation } from "../../lib/core";
import { CoffeeClient } from "./coffee-client";

const mocks = vi.hoisted(() => ({
  createCoffeeLocation: vi.fn(),
  updateCoffeeLocation: vi.fn(),
}));

vi.mock("./actions", () => ({
  addBunkerIngredient: vi.fn(),
  autoLinkCoffeeLocations: vi.fn(),
  createCoffeeAlertTask: vi.fn(),
  createCoffeeLocation: mocks.createCoffeeLocation,
  deleteCoffeeContainerReturn: vi.fn(),
  deleteCoffeeRefill: vi.fn(),
  ingestCoffeeStock: vi.fn(),
  linkCoffeeLocation: vi.fn(),
  recordCoffeeConsumable: vi.fn(),
  removeBunkerIngredient: vi.fn(),
  removeCoffeeWashSchedule: vi.fn(),
  setCoffeeIngredientPrice: vi.fn(),
  setCoffeeTare: vi.fn(),
  setCoffeeTargetFillWeight: vi.fn(),
  setCoffeeWashSchedule: vi.fn(),
  submitCoffeeRefill: vi.fn(),
  unlinkCoffeeMachine: vi.fn(),
  updateCoffeeLocation: mocks.updateCoffeeLocation,
}));

const location: CoffeeLocation = {
  id: "location-1",
  name: "Olma",
  isActive: true,
  entityId: null,
  machineName: null,
  machineRef: null,
  machines: [],
  operational: true,
};

const consumption: CoffeeContainerConsumptionReport = {
  from: "2026-08-01",
  to: "2026-08-24",
  rows: [],
  locations: [],
  totalGrams: 0,
  totalCost: null,
};

function renderCoffee(): void {
  render(
    <CoffeeClient
      locations={[location]}
      bunkerConfig={[]}
      tareGrid={[]}
      recentRefills={[]}
      summary={[]}
      consumables={[]}
      stockLevels={[]}
      fillStatus={[]}
      reconcile={[]}
      reconcileFrom="2026-08-01"
      reconcileTo="2026-08-24"
      washScheduleStatus={[]}
      washSchedules={[]}
      machineCandidates={[]}
      refillJournal={[]}
      containerReturns={[]}
      placements={[]}
      containerConsumption={consumption}
      defaultOwnerRef={null}
      peopleById={{}}
    />,
  );
}

describe("формы настроек кофе", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("показывает ошибку создания локации и сохраняет название", async () => {
    mocks.createCoffeeLocation.mockResolvedValue({ ok: false, message: "Локация уже существует" });
    const user = userEvent.setup();
    renderCoffee();

    await user.click(screen.getByRole("button", { name: "Настройки" }));
    const name = screen.getByPlaceholderText("Новая локация — название");
    await user.type(name, "  Chilanzar  ");
    await user.click(screen.getByRole("button", { name: "Добавить локацию" }));

    expect(mocks.createCoffeeLocation).toHaveBeenCalledWith("Chilanzar");
    expect(await screen.findByText("Локация уже существует")).toBeVisible();
    expect(name).toHaveValue("  Chilanzar  ");
  });

  it("передаёт очищенное имя при переименовании и показывает отказ Core", async () => {
    mocks.updateCoffeeLocation.mockResolvedValue({ ok: false, message: "Имя занято" });
    const user = userEvent.setup();
    renderCoffee();

    await user.click(screen.getByRole("button", { name: "Настройки" }));
    const name = screen.getByDisplayValue("Olma");
    await user.clear(name);
    await user.type(name, "  Olma склад  ");
    await user.tab();

    expect(mocks.updateCoffeeLocation).toHaveBeenCalledWith("location-1", {
      name: "Olma склад",
    });
    expect(await screen.findByText("Имя занято")).toBeVisible();
  });
});
