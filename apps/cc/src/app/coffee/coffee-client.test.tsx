import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoffeeBunkerIngredient, CoffeeContainerConsumptionReport, CoffeeLocation } from "../../lib/core";
import { CoffeeClient } from "./coffee-client";

const mocks = vi.hoisted(() => ({
  createCoffeeLocation: vi.fn(),
  updateCoffeeLocation: vi.fn(),
  submitCoffeeRefill: vi.fn(),
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
  submitCoffeeRefill: mocks.submitCoffeeRefill,
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

/**
 * Живая раскладка позиций: 3 держит ДВА ингредиента (лимонный чай и матча),
 * 4 — один, 8 не используется. Не выдуманный пример: ровно так лежит
 * COFFEE_BUNKER_INGREDIENTS в packages/db/src/seed-coffee.ts.
 */
const пусто = { purchasePrice: null, entityId: null, priceSource: null, targetFillWeight: null } as const;
const bunkers: CoffeeBunkerIngredient[] = [
  { position: 3, ingredientId: "ing-lemon", ingredientName: "Лимонный чай", ...пусто },
  { position: 3, ingredientId: "ing-matcha", ingredientName: "Матча", ...пусто },
  { position: 4, ingredientId: "ing-sugar", ingredientName: "Сахар", ...пусто },
];

function renderCoffee(bunkerConfig: CoffeeBunkerIngredient[] = []): void {
  render(
    <CoffeeClient
      locations={[location]}
      bunkerConfig={bunkerConfig}
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

describe("ввод заливки: выбор ингредиента", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("двусмысленную позицию расщепляет на два выбора, однозначную оставляет одним", () => {
    renderCoffee(bunkers);

    const select = screen.getByRole("combobox", { name: /Бункер/ });
    const labels = [...select.querySelectorAll("option")].map((o) => o.textContent);
    expect(labels).toContain("3 · Лимонный чай");
    expect(labels).toContain("3 · Матча");
    expect(labels).toContain("4 · Сахар");
    // Позиция без ингредиентов названа прямо, а не пустым номером.
    expect(labels).toContain("8 · пусто");
  });

  it("на двусмысленной позиции отправляет выбранный ингредиент", async () => {
    mocks.submitCoffeeRefill.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderCoffee(bunkers);

    await user.selectOptions(screen.getByRole("combobox", { name: /Адрес/ }), "location-1");
    await user.selectOptions(screen.getByRole("combobox", { name: /Бункер/ }), "3:ing-matcha");
    await user.type(screen.getByRole("spinbutton", { name: /Вес/ }), "1250");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));

    expect(mocks.submitCoffeeRefill).toHaveBeenCalledWith(
      expect.objectContaining({ position: 3, ingredientId: "ing-matcha", filledWeight: 1250 }),
    );
  });

  it("на однозначной позиции ингредиент не шлёт — его выводит ядро", async () => {
    mocks.submitCoffeeRefill.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderCoffee(bunkers);

    await user.selectOptions(screen.getByRole("combobox", { name: /Адрес/ }), "location-1");
    await user.selectOptions(screen.getByRole("combobox", { name: /Бункер/ }), "4");
    await user.type(screen.getByRole("spinbutton", { name: /Вес/ }), "900");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));

    const arg = mocks.submitCoffeeRefill.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.position).toBe(4);
    expect(arg).not.toHaveProperty("ingredientId");
  });
});
