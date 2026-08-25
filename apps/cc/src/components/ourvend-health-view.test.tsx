import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { OurvendHealth } from "../lib/core";
import { OurvendHealthCard, OurvendHealthSection } from "./ourvend-health-view";

const mocks = vi.hoisted(() => ({ ourvendHealth: vi.fn() }));
vi.mock("../lib/core", () => ({
  core: { ourvendHealth: mocks.ourvendHealth },
  CoreUnavailable: class CoreUnavailable extends Error {
    constructor(readonly detail: string) {
      super("Core недоступен");
    }
  },
}));

const прогон = (status: OurvendHealth["runs"][number]["status"], startedAt: string) => ({
  id: `r-${startedAt}`,
  startedAt,
  finishedAt: startedAt,
  status,
  machinesTotal: 2,
  machinesOk: status === "success" ? 2 : 0,
  error: status === "failed" ? "аборт приёма слотов 10 с" : null,
  durationMs: 10_000,
});

/**
 * Боевое состояние 25.08 (inventory-prod.md §9): синк падает с 24.08, лаг
 * продаж 10.7 ч, слотов снимков нет вовсе, паритет own↔stock 14/14 дней.
 */
const ЗДОРОВЬЕ: OurvendHealth = {
  runs: [прогон("failed", "2026-08-25T06:00:00.000Z"), прогон("failed", "2026-08-25T03:00:00.000Z")],
  failedStreak: 12,
  lastSuccessAt: "2026-08-24T03:10:00.000Z",
  slotsLagMin: null,
  salesLagH: 10.7,
  productSaleLagH: 36.8,
  parity: { days: 14, ok: true, mismatches: 0, stockOk: true, note: null },
};

const ЗДОРОВ: OurvendHealth = {
  runs: [прогон("success", "2026-08-25T06:00:00.000Z")],
  failedStreak: 0,
  lastSuccessAt: "2026-08-25T06:00:00.000Z",
  slotsLagMin: 48,
  salesLagH: 1.2,
  productSaleLagH: 2.4,
  parity: { days: 14, ok: true, mismatches: 0, stockOk: true, note: null },
};

describe("Секция «Здоровье сбора»", () => {
  it("серия отказов — тревожная пилюля, лаг null — «снимков нет»", () => {
    render(<OurvendHealthCard health={ЗДОРОВЬЕ} />);
    expect(screen.getByText(/12 отказов подряд/)).toBeVisible();
    expect(screen.getByText(/снимков нет/)).toBeVisible();
    // Серия ≥ 3 и лаг продаж > 6 ч — обе пилюли красные, плюс общая тревога.
    expect(screen.getByText(/12 отказов подряд/).className).toMatch(/bad/);
    expect(screen.getByText("тревога")).toBeVisible();
  });

  it("сбор здоров — ни одной красной пилюли и никакой тревоги", () => {
    render(<OurvendHealthCard health={ЗДОРОВ} />);
    expect(screen.queryByText("тревога")).toBeNull();
    expect(screen.getByText("сбоев подряд нет")).toBeVisible();
    expect(document.querySelectorAll(".pill.bad")).toHaveLength(0);
  });

  it("паритет: продажи и остатки — две разные пилюли, расхождение красное", () => {
    render(
      <OurvendHealthCard
        health={{ ...ЗДОРОВ, parity: { days: 14, ok: false, mismatches: 3, stockOk: false, note: "снапшот моложе окна" } }}
      />,
    );
    expect(screen.getByText("3 расхождений")).toBeVisible();
    expect(screen.getByText("остатки расходятся")).toBeVisible();
    expect(screen.getByText(/снапшот моложе окна/)).toBeVisible();
  });

  it("свежесть: молодой лаг в минутах, взрослый — в часах (одна шкала с ботом)", () => {
    render(<OurvendHealthCard health={ЗДОРОВ} />);
    // 48 мин слотов — минуты, а не «0,8 ч»; 1,2 ч продаж — часы.
    expect(screen.getByText("48,0 мин")).toBeVisible();
    expect(screen.getByText("1,2 ч")).toBeVisible();
  });

  it("витрина (product_sale) старше 6 ч — красная пилюля и общая тревога", () => {
    render(<OurvendHealthCard health={{ ...ЗДОРОВ, productSaleLagH: 36.8 }} />);
    expect(screen.getByText("36,8 ч").className).toMatch(/bad/);
    expect(screen.getByText("тревога")).toBeVisible();
  });

  it("отказы названы причиной, а не только счётчиком", () => {
    render(<OurvendHealthCard health={ЗДОРОВЬЕ} />);
    expect(screen.getAllByText(/аборт приёма слотов 10 с/)).toHaveLength(2);
  });

  it("сбор идёт — списка отказов нет вовсе, а не пустой заголовок", () => {
    render(<OurvendHealthCard health={ЗДОРОВ} />);
    expect(screen.queryByText(/Последние отказы/)).toBeNull();
  });

  it("Core не ответил — «не проверили», а не пропавшая секция", async () => {
    mocks.ourvendHealth.mockRejectedValue(new Error("HTTP 502"));
    render(await OurvendHealthSection());
    expect(screen.getByText("Здоровье сбора")).toBeVisible();
    expect(screen.getByText("Здоровье сбора: не проверили (Core не ответил)")).toBeVisible();
  });

  it("ядро ответило — секция показывает карточку", async () => {
    mocks.ourvendHealth.mockResolvedValue(ЗДОРОВЬЕ);
    render(await OurvendHealthSection());
    expect(screen.getByText(/12 отказов подряд/)).toBeVisible();
  });
});
