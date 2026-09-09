import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocationPanel, type LocationPeriod, type PlaceOption } from "./location-panel";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  saveLocation: vi.fn(),
  setMachineStatus: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("next/dynamic", () => ({
  default: () => () => <div data-testid="map-picker" />,
}));

vi.mock("../app/card/actions", () => ({
  saveLocation: mocks.saveLocation,
  setMachineStatus: mocks.setMachineStatus,
}));

const places: PlaceOption[] = [
  { id: "loc-1", name: "CardioLife", type: "location" },
  { id: "wh-1", name: "Основной склад", type: "warehouse" },
  { id: "ws-1", name: "Мастерская", type: "workshop" },
];

const период = (over: Partial<LocationPeriod> = {}): LocationPeriod => ({
  id: "p-1",
  locationId: "loc-1",
  locationName: "CardioLife",
  startDate: "2026-09-08",
  endDate: null,
  note: null,
  ...over,
});

function панель(over: Partial<Parameters<typeof LocationPanel>[0]> = {}) {
  return render(
    <LocationPanel
      machineId="m-1"
      periods={[]}
      places={places}
      status="in_service"
      statusNote={null}
      lat={null}
      lng={null}
      address={null}
      {...over}
    />,
  );
}

describe("«Где стоит»: место и состояние одной записью", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("вид места подставляет состояние — владелец не называет одно дважды", async () => {
    const user = userEvent.setup();
    панель();

    await user.selectOptions(screen.getByLabelText("Место"), "wh-1");

    // Склад выбран — состояние стало «На складе» само.
    expect(screen.getByRole("button", { name: "На складе" })).toHaveClass("active");
  });

  it("одно сохранение пишет и место, и состояние", async () => {
    mocks.setMachineStatus.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    панель({ status: "repair" });

    await user.selectOptions(screen.getByLabelText("Место"), "loc-1");
    await user.type(screen.getByLabelText("Причина / примечание"), "экран заменили");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));

    expect(mocks.setMachineStatus).toHaveBeenCalledWith(
      "m-1",
      "in_service",
      "экран заменили",
      "loc-1",
    );
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("«в эксплуатации» без места не уходит на сервер — это и есть «локация не записана»", async () => {
    // Ровно тот путь, которым ломался KARDIO Life: состояние вернули в строй,
    // место не назвали, период размещения остался закрытым.
    const user = userEvent.setup();
    панель({ status: "repair" });

    await user.click(screen.getByRole("button", { name: "В эксплуатации" }));
    await user.click(screen.getByRole("button", { name: "Сохранить" }));

    expect(mocks.setMachineStatus).not.toHaveBeenCalled();
    expect(await screen.findByText(/торговать нигде автомат не может/)).toBeVisible();
  });

  it("противоречие место↔состояние ловится тем же правилом, что и в Core", async () => {
    const user = userEvent.setup();
    панель();

    await user.selectOptions(screen.getByLabelText("Место"), "wh-1");
    // Владелец переопределил подсказку на несовместимое состояние.
    await user.click(screen.getByRole("button", { name: "В эксплуатации" }));
    await user.click(screen.getByRole("button", { name: "Сохранить" }));

    expect(mocks.setMachineStatus).not.toHaveBeenCalled();
    expect(await screen.findByText(/«Основной склад» — это склад/)).toBeVisible();
  });

  it("«в ремонте» на точке продаж разрешено — чинят и на месте", async () => {
    mocks.setMachineStatus.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    панель();

    await user.selectOptions(screen.getByLabelText("Место"), "loc-1");
    await user.click(screen.getByRole("button", { name: "В ремонте" }));
    await user.click(screen.getByRole("button", { name: "Сохранить" }));

    expect(mocks.setMachineStatus).toHaveBeenCalledWith("m-1", "repair", undefined, "loc-1");
  });

  it("отказ Core не стирает ввод — выбор места и причина остаются", async () => {
    mocks.setMachineStatus.mockResolvedValue({ ok: false, error: "Core недоступен" });
    const user = userEvent.setup();
    панель({ status: "repair" });

    await user.selectOptions(screen.getByLabelText("Место"), "loc-1");
    await user.type(screen.getByLabelText("Причина / примечание"), "заявка №12");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));

    expect(await screen.findByText("Core недоступен")).toBeVisible();
    expect(screen.getByLabelText("Место")).toHaveValue("loc-1");
    expect(screen.getByLabelText("Причина / примечание")).toHaveValue("заявка №12");
  });

  it("без изменений сохранять нечего — кнопка выключена", () => {
    панель({ periods: [период()] });
    expect(screen.getByRole("button", { name: "Сохранить" })).toBeDisabled();
  });

  it("мест ещё нет — экран говорит, что сделать, а не показывает пустой список", () => {
    панель({ places: [] });
    expect(screen.getByText("Мест ещё нет")).toBeVisible();
  });

  it("пустая история больше не отсылает в «Обслуживание» — форма здесь же", () => {
    панель();
    // История свёрнута в <details> — проверяем наличие текста, не видимость.
    expect(screen.getByText(/Поставьте его на место формой «Где стоит» выше/)).toBeInTheDocument();
  });
});
