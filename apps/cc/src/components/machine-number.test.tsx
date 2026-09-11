import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../app/card/actions", () => ({ setMachineNumber: vi.fn(), applyMachineNumberPlan: vi.fn() }));

import { MachineNumber } from "./machine-number";
import { MachineNumbersBlock } from "./machine-numbers-block";

describe("номер автомата в карточке (волна 3)", () => {
  it("присвоен, но не наклеен — видно словами и есть «Номер наклеен»", () => {
    render(<MachineNumber machineId="m1" kind="coffee" inventoryNo="K-014" labelPending />);
    expect(screen.getByText("K-014")).toBeVisible();
    expect(screen.getByText("не наклеен")).toBeVisible();
    expect(screen.getByRole("button", { name: "Номер наклеен" })).toBeVisible();
  });

  it("наклеен — подтверждать нечего, можно только вписать другой", () => {
    render(<MachineNumber machineId="m1" kind="coffee" inventoryNo="K-014" labelPending={false} />);
    expect(screen.queryByRole("button", { name: "Номер наклеен" })).toBeNull();
    expect(screen.getByRole("button", { name: "На автомате другой номер" })).toBeVisible();
  });

  it("вид «прочее» — номер не присваивается, и это сказано", () => {
    render(<MachineNumber machineId="m1" kind="other" inventoryNo={null} labelPending={false} />);
    expect(screen.getByText(/номер не присваивается/)).toBeVisible();
  });
});

describe("«Номера автоматов» над списком парка (М-12)", () => {
  it("план: сколько и что получит номер, одна кнопка присвоить", () => {
    render(
      <MachineNumbersBlock
        plan={[
          { id: "a", name: "American hospital", inventoryNo: "K-001" },
          { id: "b", name: "SKLAD 6S", inventoryNo: "S-001" },
        ]}
        toLabel={[]}
      />,
    );
    expect(screen.getByText(/K-001 ← American hospital · S-001 ← SKLAD 6S/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Присвоить номера 2 автоматам" })).toBeVisible();
  });

  it("очередь наклейки: имя на показ и имя карточки, если разошлись", () => {
    render(<MachineNumbersBlock plan={[]} toLabel={[{ id: "k", displayName: "K-014 · CardioLife", name: "KARDIO Life" }]} />);
    expect(screen.getByRole("link", { name: "K-014 · CardioLife" })).toHaveAttribute("href", "/card/k");
    expect(screen.getByText(/карточка «KARDIO Life»/)).toBeVisible();
  });

  it("нечего присваивать и нечего клеить — блока нет", () => {
    const { container } = render(<MachineNumbersBlock plan={[]} toLabel={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
