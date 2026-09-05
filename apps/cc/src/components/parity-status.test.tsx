import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ParityStatusPill } from "./parity-status";

describe("Статус сверки словами (R-GS-5)", () => {
  it("каждому статусу — своё слово, расхождение — с числом", () => {
    const { rerender } = render(<ParityStatusPill status="ok" diff={0} />);
    expect(screen.getByText("сходится")).toBeTruthy();
    rerender(<ParityStatusPill status="mismatch" diff={-5} />);
    expect(screen.getByText("-5")).toBeTruthy();
    rerender(<ParityStatusPill status="no_row" diff={null} />);
    expect(screen.getByText("нет строки в таблице")).toBeTruthy();
    rerender(<ParityStatusPill status="no_card" diff={null} />);
    expect(screen.getByText("нет карточки")).toBeTruthy();
    rerender(<ParityStatusPill status="inactive_with_stock" diff={null} />);
    expect(screen.getByText("неактивен, но есть остаток")).toBeTruthy();
    rerender(<ParityStatusPill status="no_warehouse" diff={null} />);
    expect(screen.getByText("склад не выбран")).toBeTruthy();
  });
});
