import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MonthlyPrice, PriceChangesReport, PriceGapReport } from "../lib/core";
import { VENDHUB_GROUPS, isTableBackedLeaf } from "../lib/domain-nav";
import { PRICE_WINDOWS, PricesTables, VendingPricesView } from "./vending-prices-view";

const mocks = vi.hoisted(() => ({ vendingPriceChanges: vi.fn(), vendingPriceGap: vi.fn() }));
vi.mock("../lib/core", () => ({
  core: { vendingPriceChanges: mocks.vendingPriceChanges, vendingPriceGap: mocks.vendingPriceGap },
  CoreUnavailable: class CoreUnavailable extends Error {
    constructor(readonly detail: string) {
      super("Core недоступен");
    }
  },
}));

/**
 * Боевые числа (inventory-prod.md §9): по витрине за 30 дней ровно одна
 * находка — LaimonFresh Lime 330ml 15000→12000 (−20 %) 08.07; закупочных
 * переходов в окне нет (история старше 43 дней).
 */
const ЦЕНЫ: PriceChangesReport & { monthly: MonthlyPrice[] } = {
  days: 30,
  pct: 5,
  purchase: [],
  retail: [{ product: "LaimonFresh Lime 330ml", from: 15_000, to: 12_000, pct: -20, at: "2026-07-08" }],
  monthly: [
    { product: "Kinder Bueno", month: "2026-07", retail: 11_000, purchase: 7_700 },
    { product: "Kinder Bueno", month: "2026-08", retail: 11_000, purchase: null },
  ],
};

/** Прод: 0 строк разрыва, эталон не задан ни у одного из 34 SKU. */
const ВИТРИНА: PriceGapReport = {
  days: 14,
  pct: 5,
  rows: [],
  noReference: ["Cheers", "Kinder Bueno", "TUC"],
  lostTotal: 0,
};

const РАЗРЫВ: PriceGapReport = {
  days: 14,
  pct: 5,
  rows: [
    { product: "Cheers", fact: 10_000, reference: 12_000, gap: 2_000, gapPct: 16.7, qty: 40, lost: 80_000, action: "raise" },
    { product: "TUC", fact: 13_000, reference: 12_000, gap: -1_000, gapPct: -8.3, qty: 12, lost: -12_000, action: "check" },
  ],
  noReference: [],
  lostTotal: 80_000,
};

describe("Лист «Цены»", () => {
  it("три блока: изменения, витрина против эталона, динамика по месяцам", () => {
    render(<PricesTables report={ЦЕНЫ} gap={ВИТРИНА} />);
    expect(screen.getByText(/Витрина против эталона/)).toBeVisible();
    expect(screen.getByText(/эталон не задан/)).toBeVisible();
    expect(screen.getByText(/Динамика по месяцам/)).toBeVisible();
  });

  it("витринный переход показан числами и процентом", () => {
    render(<PricesTables report={ЦЕНЫ} gap={ВИТРИНА} />);
    expect(screen.getByText(/15 000 → 12 000/)).toBeVisible();
    expect(screen.getByText(/−20,0 %/)).toBeVisible();
  });

  it("закупочных изменений нет — это сказано вслух, а не пустой блок", () => {
    render(<PricesTables report={ЦЕНЫ} gap={ВИТРИНА} />);
    expect(screen.getByText(/закупочные цены за 30 дн\. не менялись/)).toBeVisible();
  });

  it("недобор считается только по положительным разрывам, «дороже эталона» — на проверку", () => {
    render(<PricesTables report={{ ...ЦЕНЫ, retail: [] }} gap={РАЗРЫВ} />);
    expect(screen.getByText(/недобор 80 000 сум/)).toBeVisible();
    expect(screen.getByText(/проверить эталон/)).toBeVisible();
  });

  it("разрыв не спросили — «не проверили», а не «разрывов нет»", () => {
    render(<PricesTables report={ЦЕНЫ} gap={null} />);
    expect(screen.getByText(/Не проверили — Core не ответил/)).toBeVisible();
    expect(screen.queryByText(/эталон не задан/)).toBeNull();
  });
});

describe("Лист «Цены»: поход в ядро", () => {
  it("Core не ответил — честный экран «нет связи»", async () => {
    mocks.vendingPriceChanges.mockRejectedValue(new Error("HTTP 502"));
    mocks.vendingPriceGap.mockResolvedValue(ВИТРИНА);
    render(await VendingPricesView({ domain: "vendhub", days: 30 }));
    expect(screen.getByText("Нет связи с ядром MYDON")).toBeVisible();
  });

  it("окно из адреса — только для изменений; факт витрины считается своим окном", async () => {
    mocks.vendingPriceChanges.mockResolvedValue(ЦЕНЫ);
    mocks.vendingPriceGap.mockResolvedValue(ВИТРИНА);
    render(await VendingPricesView({ domain: "vendhub", days: 180 }));
    expect(mocks.vendingPriceChanges).toHaveBeenCalledWith(180);
    expect(mocks.vendingPriceGap).toHaveBeenCalledWith(14);
  });

  it("разрыв упал, а изменения пришли — лист живёт, секция говорит «не проверили»", async () => {
    mocks.vendingPriceChanges.mockResolvedValue(ЦЕНЫ);
    mocks.vendingPriceGap.mockRejectedValue(new Error("HTTP 502"));
    render(await VendingPricesView({ domain: "vendhub", days: 30 }));
    expect(screen.getByText(/Не проверили — Core не ответил/)).toBeVisible();
    expect(screen.getByText(/Динамика по месяцам/)).toBeVisible();
  });
});

describe("навигация: лист «Цены»", () => {
  it("стоит в «Отчётах» и не гасится счётчиком реестра", () => {
    const reports = VENDHUB_GROUPS.find((g) => g.key === "reports");
    expect(reports?.leaves).toContainEqual({ label: "Цены", type: "prices" });
    expect(isTableBackedLeaf("prices")).toBe(true);
    expect(PRICE_WINDOWS).toEqual([30, 90, 180]);
  });

  it("лист «Себестоимость» (кофе) не тронут — R-P5b-9", () => {
    const reports = VENDHUB_GROUPS.find((g) => g.key === "reports");
    expect(reports?.leaves).toContainEqual({ label: "Себестоимость", type: "cost" });
    expect(isTableBackedLeaf("cost")).toBe(false);
  });
});
