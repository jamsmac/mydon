import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PartUnit } from "../lib/core";
import { WashingList, daysSince } from "./parts-washing";

const mocks = vi.hoisted(() => ({ movePartUnit: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("../app/parts/actions", () => ({ movePartUnit: mocks.movePartUnit }));

function unit(over: Partial<PartUnit> & { id: string }): PartUnit {
  return {
    partKind: "mixer",
    inventoryNo: "M-017",
    labelPending: false,
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
    origin: "manual",
    note: null,
    createdBy: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    where: { location: "washing", machineId: null, machineName: null, slot: null, since: "2026-09-01", periodId: "p1" },
    attention: [],
    label: "Миксер M-017",
    photoCount: 0,
    ...over,
  } as PartUnit;
}

const МОЙКА = { to: "washed", label: "Помыл", okText: "Помыт — ушёл дальше по цепочке" } as const;

describe("Мойка и сушка (У3)", () => {
  beforeEach(() => {
    mocks.movePartUnit.mockReset();
    mocks.refresh.mockReset();
  });

  it("суток на месте считается по началу периода, а не по времени рендера", () => {
    expect(daysSince("2026-09-01", "2026-09-05")).toBe(4);
    expect(daysSince("2026-09-05", "2026-09-05")).toBe(0);
    expect(daysSince(undefined, "2026-09-05")).toBeNull();
    // Дата из будущего (часовой пояс, ручная правка) не даёт отрицательных суток.
    expect(daysSince("2026-09-09", "2026-09-05")).toBe(0);
  });

  it("зависшая мойка помечена тревожной строкой, свежая — нет", () => {
    const { container } = render(
      <WashingList
        units={[unit({ id: "u1", inventoryNo: "M-001", where: { location: "washing", machineId: null, machineName: null, slot: null, since: "2026-08-25", periodId: "p1" } }),
                unit({ id: "u2", inventoryNo: "M-002", where: { location: "washing", machineId: null, machineName: null, slot: null, since: "2026-09-05", periodId: "p2" } })]}
        action={МОЙКА}
        today="2026-09-05"
      />,
    );
    const rows = container.querySelectorAll(".row");
    expect(rows).toHaveLength(2);
    expect(rows[0].className).toContain("hot");
    expect(rows[1].className).not.toContain("hot");
    expect(screen.getByText(/11 сут\./)).toBeTruthy();
  });

  it("«Помыл» зовёт перемещение и обновляет страницу", async () => {
    mocks.movePartUnit.mockResolvedValue({ ok: true });
    render(<WashingList units={[unit({ id: "u1" })]} action={МОЙКА} today="2026-09-05" />);
    await userEvent.click(screen.getByRole("button", { name: "Помыл" }));
    expect(mocks.movePartUnit).toHaveBeenCalledWith("u1", "washed");
    expect(await screen.findByText("Помыт — ушёл дальше по цепочке")).toBeTruthy();
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("отказ Core виден на строке, список остаётся, страница не обновляется", async () => {
    mocks.movePartUnit.mockResolvedValue({ ok: false, error: "Узел стоит на автомате — сначала снимите его" });
    render(<WashingList units={[unit({ id: "u1" })]} action={МОЙКА} today="2026-09-05" />);
    await userEvent.click(screen.getByRole("button", { name: "Помыл" }));
    expect(await screen.findByText("Узел стоит на автомате — сначала снимите его")).toBeTruthy();
    expect(screen.getByText(/M-017/)).toBeTruthy();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("бункер без тары говорит об этом здесь же — без тары возврат остатка не приходуется", () => {
    render(
      <WashingList
        units={[unit({ id: "h1", partKind: "hopper", inventoryNo: "H-27-3", setNumber: 27, tareWeight: null })]}
        action={МОЙКА}
        today="2026-09-05"
      />,
    );
    expect(screen.getByText(/набор 27 · тара не внесена/)).toBeTruthy();
  });
});
