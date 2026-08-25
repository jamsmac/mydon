import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MarginProduct, MarginReport } from "../lib/core";
import { VENDHUB_GROUPS, isTableBackedLeaf } from "../lib/domain-nav";
import { MARGIN_WINDOWS, MarginTables, MarginView } from "./margin-view";

const mocks = vi.hoisted(() => ({ vendingMargin: vi.fn() }));
// В одном файле с таблицами живёт серверный `MarginView`, а он тянет клиент
// Core — тот первой строкой импортирует `server-only`, которого вне RSC нет.
// Сами таблицы Core не трогают: им отдают готовый отчёт пропом.
vi.mock("../lib/core", () => ({
  core: { vendingMargin: mocks.vendingMargin },
  CoreUnavailable: class CoreUnavailable extends Error {
    constructor(readonly detail: string) {
      super("Core недоступен");
    }
  },
}));

const товар = (
  product: string,
  qty: number,
  revenue: number,
  cogs: number,
  pct: number,
  low = false,
): MarginProduct => ({ product, qty, revenue, cogs, margin: revenue - cogs, pct, unknownUnits: 0, low });

/**
 * Боевые числа первого прогона (inventory-prod.md §9): 30 дней, 2 автомата,
 * 1047 шт, выручка 8 974 000, закуп 6 500 879, маржа 2 473 121 (27.6 %),
 * по автоматам 1 621 385 (Olma) и 851 736 (American Hospital).
 */
const МАРЖА_ПРОД: MarginReport = {
  days: 30,
  from: "2026-07-27",
  to: "2026-08-25",
  lowPct: 15,
  machines: [
    {
      serial: "2508160376",
      name: "Olma Администрация",
      qty: 690,
      revenue: 5_874_000,
      cogs: 4_252_615,
      margin: 1_621_385,
      pct: 27.6,
      unknownUnits: 0,
      low: false,
      products: [
        товар("Kinder Bueno", 300, 3_300_000, 2_310_000, 30),
        товар("LaimonFresh Lime 330ml", 140, 824_000, 367_615, 55.4),
        товар("Cheers", 250, 1_750_000, 1_575_000, 10, true),
      ],
    },
    {
      serial: "2508160359",
      name: "American Hospital",
      qty: 357,
      revenue: 3_100_000,
      cogs: 2_248_264,
      margin: 851_736,
      pct: 27.5,
      unknownUnits: 0,
      low: false,
      products: [товар("Snickers 50gr", 200, 2_000_000, 1_500_000, 25), товар("TUC", 157, 1_100_000, 748_264, 32)],
    },
  ],
  products: [
    товар("Kinder Bueno", 300, 3_300_000, 2_310_000, 30),
    товар("Snickers 50gr", 200, 2_000_000, 1_500_000, 25),
    товар("LaimonFresh Lime 330ml", 140, 824_000, 367_615, 55.4),
    товар("TUC", 157, 1_100_000, 748_264, 32),
    товар("Cheers", 250, 1_750_000, 1_575_000, 10, true),
  ],
  totals: { qty: 1047, revenue: 8_974_000, cogs: 6_500_879, margin: 2_473_121, pct: 27.6, unknownUnits: 0 },
  unknownUnits: 0,
  unknownProducts: [],
  excluded: [],
};

const ПУСТАЯ_МАРЖА: MarginReport = {
  days: 30,
  from: "2026-07-27",
  to: "2026-08-25",
  lowPct: 15,
  machines: [],
  products: [],
  totals: { qty: 0, revenue: 0, cogs: 0, margin: 0, pct: null, unknownUnits: 0 },
  unknownUnits: 0,
  unknownProducts: [],
  excluded: [],
};

describe("Лист «Маржа»", () => {
  it("боевые числа и порядок по деньгам", () => {
    render(<MarginTables report={МАРЖА_ПРОД} />);
    expect(screen.getByText(/2 473 121/)).toBeVisible();
    const строки = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(строки[0]).toMatch(/Olma Администрация/);
    expect(строки[1]).toMatch(/American Hospital/);
  });

  it("штуки без себестоимости названы вслух", () => {
    render(<MarginTables report={{ ...МАРЖА_ПРОД, unknownUnits: 4, unknownProducts: ["Новинка"] }} />);
    expect(screen.getByText(/4 шт без себестоимости/)).toBeVisible();
    // Не просто счётчик: сказано, ЧТО именно завышает маржу (R-P5b-2).
    expect(screen.getByText(/Новинка/)).toBeVisible();
  });

  it("нет продаж — «продаж за период нет», а не нули", () => {
    render(<MarginTables report={ПУСТАЯ_МАРЖА} />);
    expect(screen.getByText(/продаж за 30 дн\. нет/)).toBeVisible();
    // Нулевая выручка не показывается как достижение: строки итогов нет вовсе.
    expect(screen.queryByText(/порог низкой/)).toBeNull();
    expect(screen.queryByText(/выручка 0 сум/)).toBeNull();
  });

  it("автоматы не в строю названы отдельной строкой, а не спрятаны", () => {
    render(<MarginTables report={{ ...МАРЖА_ПРОД, excluded: [{ serial: "2508160360", qty: 1, amount: 12000 }] }} />);
    expect(screen.getByText(/не в строю/)).toBeVisible();
    expect(screen.getByText("2508160360")).toBeVisible();
  });

  it("низкая маржа помечена пилюлей, а не спрятана в процентах", () => {
    render(<MarginTables report={МАРЖА_ПРОД} />);
    // Cheers (10 %) ниже порога 15 % — и в автомате, и в своде по парку.
    expect(screen.getAllByText(/низкая маржа/)).toHaveLength(2);
  });

  it("суммы без неразрывного пробела — копипаста и поиск не ломаются", () => {
    render(<MarginTables report={МАРЖА_ПРОД} />);
    for (const el of screen.getAllByText(/сум/)) expect(el.textContent).not.toMatch(/\u00a0/);
  });
});

describe("Лист «Маржа»: поход в ядро", () => {
  it("Core не ответил — честный экран «нет связи», а не нули", async () => {
    mocks.vendingMargin.mockRejectedValue(new Error("HTTP 502"));
    render(await MarginView({ domain: "vendhub", days: 30 }));
    expect(screen.getByText("Нет связи с ядром MYDON")).toBeVisible();
  });

  it("окно берётся из адреса и уходит в ядро", async () => {
    mocks.vendingMargin.mockResolvedValue(МАРЖА_ПРОД);
    render(await MarginView({ domain: "vendhub", days: 90 }));
    expect(mocks.vendingMargin).toHaveBeenCalledWith(90);
    expect(screen.getByRole("link", { name: "7 дн" })).toHaveAttribute(
      "href",
      "/domain/vendhub?tab=reports%3Amargin&days=7",
    );
  });
});

describe("навигация: лист «Маржа»", () => {
  it("стоит в «Отчётах» и не гасится счётчиком реестра", () => {
    const reports = VENDHUB_GROUPS.find((g) => g.key === "reports");
    expect(reports?.leaves).toContainEqual({ label: "Маржа", type: "margin" });
    // Своих карточек реестра лист не заводит — счёт по byType был бы 0.
    expect(isTableBackedLeaf("margin")).toBe(true);
    expect(MARGIN_WINDOWS).toEqual([7, 30, 90]);
  });
});
