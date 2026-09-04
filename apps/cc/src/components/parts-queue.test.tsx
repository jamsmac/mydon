import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PartUnit, PartsQueue as Queue } from "../lib/core";
import { PartsQueue } from "./parts-queue";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  setPartNumber: vi.fn(),
  retirePartUnit: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: mocks.refresh }),
}));

vi.mock("../app/parts/actions", () => ({
  setPartNumber: mocks.setPartNumber,
  retirePartUnit: mocks.retirePartUnit,
}));

function unit(over: Partial<PartUnit>): PartUnit {
  return {
    id: "u1",
    partKind: "mixer",
    inventoryNo: "M-017",
    labelPending: true,
    serialNumber: null,
    model: null,
    manufacturer: null,
    setNumber: null,
    hopperPosition: null,
    tareWeight: null,
    purchaseDate: null,
    purchasePrice: null,
    warrantyUntil: null,
    retiredAt: null,
    retiredReason: null,
    origin: "auto",
    note: null,
    createdBy: null,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    where: { location: "machine", machineId: "m", machineName: "Kaffit-04", slot: 1, since: "2026-09-04", periodId: "p" },
    attention: ["label_pending", "no_photo"],
    label: "Миксер M-017",
    photoCount: 0,
    ...over,
  };
}

const queue: Queue = {
  counts: { no_number: 0, label_pending: 2, unknown_location: 0, no_tare: 0, no_photo: 2 },
  items: [unit({ id: "u1" }), unit({ id: "u2", inventoryNo: "M-018", label: "Миксер M-018" })],
};

describe("Очередь «Наклеить номер» — по одному узлу", () => {
  beforeEach(() => vi.resetAllMocks());

  it("показывает первый узел, «Наклеил» подтверждает наклейку и обновляет страницу", async () => {
    mocks.setPartNumber.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<PartsQueue queue={queue} />);

    expect(screen.getByRole("heading", { name: "M-017" })).toBeVisible();
    expect(screen.getByText("1 из 2")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Наклеил M-017/ }));

    expect(mocks.setPartNumber).toHaveBeenCalledWith("u1", "", true);
    expect(await screen.findByText("Сохранено")).toBeVisible();
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("«Пропустить» показывает следующий, ничего не сохраняя; «Другой номер» шлёт введённый", async () => {
    mocks.setPartNumber.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<PartsQueue queue={queue} />);

    await user.click(screen.getByRole("button", { name: "Пропустить" }));
    expect(screen.getByRole("heading", { name: "M-018" })).toBeVisible();
    expect(mocks.setPartNumber).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Другой номер" }));
    await user.type(screen.getByPlaceholderText(/M-017 или H-27-3/), "H-27-3");
    await user.click(screen.getByRole("button", { name: "Сохранить номер" }));
    expect(mocks.setPartNumber).toHaveBeenCalledWith("u2", "H-27-3", true);
  });

  it("ошибка Core показывается словами, а не молчанием", async () => {
    mocks.setPartNumber.mockResolvedValue({ ok: false, error: "Номер M-017 уже у узла «Миксер M-001»" });
    const user = userEvent.setup();
    render(<PartsQueue queue={queue} />);
    await user.click(screen.getByRole("button", { name: /Наклеил M-017/ }));
    expect(await screen.findByText(/уже у узла/)).toBeVisible();
  });

  it("пустая очередь — честный пустой экран", () => {
    render(<PartsQueue queue={{ ...queue, items: [] }} />);
    expect(screen.getByText("Очередь пуста")).toBeVisible();
  });
});
