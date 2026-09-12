import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OccurredAtField } from "./occurred-at-field";

const now = new Date("2026-09-11T09:00:00+05:00");

describe("поле «когда произошло» (R-H-3, R-H-4, R-H-12)", () => {
  it("свёрнуто и показывает «сейчас» ташкентскими часами — обычный ввод без лишнего движения", () => {
    render(<OccurredAtField value="" onChange={vi.fn()} now={now} />);
    expect(screen.getByText("2026-09-11, 09:00")).toBeVisible();
    expect(screen.queryByLabelText("Когда произошло")).toBeNull();
  });

  it("сегодняшнее время — одобрения не требует, и это сказано", async () => {
    const { rerender } = render(<OccurredAtField value="" onChange={vi.fn()} now={now} />);
    screen.getByRole("button", { name: "изменить" }).click();
    rerender(<OccurredAtField value="2026-09-11T08:40" onChange={vi.fn()} now={now} />);
    expect(await screen.findByText(/одобрения не требует/)).toBeVisible();
  });

  it("вчерашнее — предупреждает про одобрение ДО отправки", async () => {
    render(<OccurredAtField value="2026-09-10T18:30" onChange={vi.fn()} now={now} />);
    screen.getByRole("button", { name: "изменить" }).click();
    expect(await screen.findByText(/задним числом: за вчера/)).toBeVisible();
    expect(screen.getByText(/уйдёт владельцу на одобрение/)).toBeVisible();
  });

  it("будущее — отказ прямо в форме, той же проверкой, что на сервере", async () => {
    render(<OccurredAtField value="2026-09-11T10:30" onChange={vi.fn()} now={now} />);
    screen.getByRole("button", { name: "изменить" }).click();
    expect(await screen.findByText(/будущем записать нельзя/)).toBeVisible();
  });
});
