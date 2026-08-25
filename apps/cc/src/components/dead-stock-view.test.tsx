import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DeadStockReport } from "../lib/core";
import { VENDHUB_GROUPS, isTableBackedLeaf } from "../lib/domain-nav";
import { DEAD_STOCK_WINDOWS, DeadStockTables, DeadStockView } from "./dead-stock-view";

const mocks = vi.hoisted(() => ({ vendingDeadStock: vi.fn() }));
vi.mock("../lib/core", () => ({
  core: { vendingDeadStock: mocks.vendingDeadStock },
  CoreUnavailable: class CoreUnavailable extends Error {
    constructor(readonly detail: string) {
      super("Core недоступен");
    }
  },
}));

/**
 * Боевые числа (inventory-prod.md §9): склад — 0 позиций; автоматы — 5 строк,
 * 28 шт, 290 500 сум. Без фильтра «в строю» было бы 129 строк и ~45 млн.
 */
const МЁРТВЫЙ_ПРОД: DeadStockReport = {
  days: 21,
  since: "2026-08-04",
  warehouse: [],
  machines: [
    { product: "Kinder Bueno", qty: 11, serial: "2508160376", machineName: "Olma Администрация", value: 121_000, noPrice: false },
    { product: "TUC", qty: 5, serial: "2508160359", machineName: "American Hospital", value: 62_500, noPrice: false },
    { product: "Cheers", qty: 5, serial: "2508160376", machineName: "Olma Администрация", value: 42_500, noPrice: false },
    { product: "Cheers", qty: 5, serial: "2508160359", machineName: "American Hospital", value: 42_500, noPrice: false },
    { product: "Kinder Bueno", qty: 2, serial: "2508160359", machineName: "American Hospital", value: 22_000, noPrice: false },
  ],
  totalValue: 290_500,
  noPriceCount: 0,
};

const БЕЗ_ЦЕНЫ: DeadStockReport = {
  days: 21,
  since: "2026-08-04",
  warehouse: [{ product: "Новинка", qty: 6, value: 0, noPrice: true }],
  machines: [],
  totalValue: 0,
  noPriceCount: 1,
};

const ПУСТО: DeadStockReport = {
  days: 21,
  since: "2026-08-04",
  warehouse: [],
  machines: [],
  totalValue: 0,
  noPriceCount: 0,
};

describe("Лист «Мёртвый сток»", () => {
  it("склад пуст, автоматы — 5 строк на 290 500", () => {
    render(<DeadStockTables report={МЁРТВЫЙ_ПРОД} />);
    expect(screen.getByText(/290 500/)).toBeVisible();
    expect(screen.getByText(/на складе мёртвых позиций нет/i)).toBeVisible();
    // Пять строк, а не пять товаров: один товар может стоять в двух автоматах.
    expect(screen.getAllByText(/шт/)).toHaveLength(5);
    // Место видно: без него «Kinder Bueno 11 шт» непонятно, куда ехать.
    expect(screen.getAllByText(/Olma Администрация/)).toHaveLength(2);
  });

  it("без цены показывает штуки, а не «0 сум»", () => {
    render(<DeadStockTables report={БЕЗ_ЦЕНЫ} />);
    expect(screen.getByText(/цена закупки неизвестна/)).toBeVisible();
    expect(screen.queryByText(/0 сум/)).toBeNull();
    expect(screen.getByText("нет цены")).toBeVisible();
  });

  it("пусто и на складе, и в автоматах — честное «движение было», а не «данных нет»", () => {
    render(<DeadStockTables report={ПУСТО} />);
    expect(screen.getByText("Мёртвых позиций нет")).toBeVisible();
    expect(screen.queryByText(/на складе мёртвых позиций нет/i)).toBeNull();
  });
});

describe("Лист «Мёртвый сток»: поход в ядро", () => {
  it("Core не ответил — честный экран «нет связи», а не пустой отчёт", async () => {
    mocks.vendingDeadStock.mockRejectedValue(new Error("HTTP 502"));
    render(await DeadStockView({ domain: "vendhub", days: 21 }));
    expect(screen.getByText("Нет связи с ядром MYDON")).toBeVisible();
  });

  it("окно берётся из адреса и уходит в ядро", async () => {
    mocks.vendingDeadStock.mockResolvedValue(МЁРТВЫЙ_ПРОД);
    render(await DeadStockView({ domain: "vendhub", days: 30 }));
    expect(mocks.vendingDeadStock).toHaveBeenCalledWith(30);
    expect(screen.getByRole("link", { name: "14 дн" })).toHaveAttribute(
      "href",
      "/domain/vendhub?tab=reports%3Adead_stock&days=14",
    );
  });
});

describe("навигация: лист «Мёртвый сток»", () => {
  it("стоит в «Отчётах» и не гасится счётчиком реестра", () => {
    const reports = VENDHUB_GROUPS.find((g) => g.key === "reports");
    expect(reports?.leaves).toContainEqual({ label: "Мёртвый сток", type: "dead_stock" });
    expect(isTableBackedLeaf("dead_stock")).toBe(true);
    expect(DEAD_STOCK_WINDOWS).toEqual([14, 21, 30]);
  });
});
