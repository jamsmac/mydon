import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StockCountsReport } from "../lib/core";
import { VENDHUB_GROUPS, isTableBackedLeaf } from "../lib/domain-nav";
import { STOCK_HISTORY_WINDOWS, StockHistoryTables, StockHistoryView, groupStockCounts } from "./stock-history-view";

const mocks = vi.hoisted(() => ({ vendingStockCounts: vi.fn() }));
// В одном файле с таблицами живёт серверный `StockHistoryView`, а он тянет
// клиент Core — тот первой строкой импортирует пакет `server-only`, которого
// вне RSC не существует.
vi.mock("../lib/core", () => ({
  core: { vendingStockCounts: mocks.vendingStockCounts },
  CoreUnavailable: class CoreUnavailable extends Error {
    constructor(readonly detail: string) {
      super("Core недоступен");
    }
  },
}));

/** Боевая форма: импорт донора (три локации) плюс свой пересчёт владельца. */
const ИСТОРИЯ: StockCountsReport = {
  days: 90,
  since: "2026-05-28",
  product: null,
  rows: [
    { dt: "2026-08-25", product: "Sprite 250ml", qty: 19, source: "own", countedAt: "2026-08-25T09:40:00+05:00", note: "Рустам" },
    { dt: "2026-08-25", product: "TUC Sour cream", qty: 6, source: "own", countedAt: "2026-08-25T09:40:00+05:00", note: "Рустам" },
    { dt: "2026-06-01", product: "Montella Вода минеральная 330ml", qty: 3, source: "stock-import", countedAt: "2026-06-01T07:00:00+05:00", note: "2 Холодильник" },
    { dt: "2026-06-01", product: "Snickers", qty: 41, source: "stock-import", countedAt: "2026-06-01T07:00:00+05:00", note: "1 Склад (основной)" },
  ],
  warnings: [],
};

describe("Лист «История склада» (R-H-2)", () => {
  it("сутки идут свежими сверху, внутри суток — группы по пометке", () => {
    const дни = groupStockCounts(ИСТОРИЯ.rows);
    expect(дни.map((d) => d.dt)).toEqual(["2026-08-25", "2026-06-01"]);
    expect(дни[1]!.groups.map((g) => g.note)).toEqual(["2 Холодильник", "1 Склад (основной)"]);
    expect(дни[0]!.groups).toHaveLength(1);
    expect(дни[0]!.groups[0]!.rows.map((r) => r.product)).toEqual(["Sprite 250ml", "TUC Sour cream"]);
  });

  it("сутки сортируются ЯВНО: строка, введённая сегодня за июнь, июньскую группу не разрывает", () => {
    // Core сортирует по `counted_at desc`, а не по `dt`: поздний ввод за старый
    // день приезжает первым, и группировка «как пришло» дала бы три группы
    // вместо двух и июнь дважды.
    const поздняяЗаИюнь = { ...ИСТОРИЯ.rows[2]!, countedAt: "2026-08-25T18:00:00+05:00" };
    const дни = groupStockCounts([поздняяЗаИюнь, ...ИСТОРИЯ.rows.filter((_, i) => i !== 2)]);
    expect(дни.map((d) => d.dt)).toEqual(["2026-08-25", "2026-06-01"]);
    expect(дни[1]!.groups).toHaveLength(2);
  });

  it("пометка импортированной строки подписана «место», своей — «кто считал»", () => {
    render(<StockHistoryTables report={ИСТОРИЯ} />);
    expect(within(screen.getByText("Рустам").closest("div")!).getByText("кто считал")).toBeVisible();
    expect(within(screen.getByText("2 Холодильник").closest("div")!).getByText("место")).toBeVisible();
  });

  it("подпись окна берёт `since` из ответа, а не пересчитывает его", () => {
    render(<StockHistoryTables report={ИСТОРИЯ} />);
    expect(screen.getByText(/Пересчёты склада за 90 дн\. · с 28\.05\.2026 · 4 строк/)).toBeVisible();
  });

  it("пустая история без фильтра — третье состояние «пересчёты копятся сами», а не зелёная галка", () => {
    render(<StockHistoryTables report={{ ...ИСТОРИЯ, rows: [] }} />);
    expect(screen.getByText("Инвентаризаций за окно нет")).toBeVisible();
    expect(screen.getByText(/Пересчёты копятся сами/)).toBeVisible();
  });

  it("`history_capped` показывается хвостом «Посчитано не всё», `stock_missing` — нет: лист его покрыл", () => {
    render(
      <StockHistoryTables
        report={{
          ...ИСТОРИЯ,
          rows: [],
          product: "Загадка",
          warnings: [
            { code: "history_capped", message: "Показаны первые 2000 строк истории — сузь окно или задай товар" },
            { code: "stock_missing", message: "Истории пересчётов по «Загадка» за окно нет" },
          ],
        }}
      />,
    );
    expect(screen.getByText(/Показаны первые 2000 строк/)).toBeVisible();
    expect(screen.queryByText(/Истории пересчётов по «Загадка»/)).toBeNull();
  });

  it("Core не ответил — лист говорит это, а не рисует пустую историю", async () => {
    const { CoreUnavailable } = await import("../lib/core");
    mocks.vendingStockCounts.mockRejectedValueOnce(new CoreUnavailable("ECONNREFUSED"));
    render(await StockHistoryView({ domain: "vendhub", days: 90, q: "" }));
    expect(screen.getByText(/ECONNREFUSED/)).toBeVisible();
  });

  it("окна листа — те, что сервер отдаёт целиком: 730 — его потолок", () => {
    expect(STOCK_HISTORY_WINDOWS).toEqual([30, 90, 365, 730]);
  });
});

describe("навигация: лист «История склада»", () => {
  it("стоит в «Отчётах» сразу за «Приходом» и не гасится счётчиком реестра", () => {
    const reports = VENDHUB_GROUPS.find((g) => g.key === "reports");
    const i = reports!.leaves.findIndex((l) => l.type === "purchase");
    expect(reports!.leaves[i + 1]).toEqual({ label: "История склада", type: "stock_history" });
    // Считается на чтении (`/vending/stock-counts`), своих карточек реестра не
    // заводит — счёт по `byType` всегда 0, и чип бы погас.
    expect(isTableBackedLeaf("stock_history")).toBe(true);
  });
});
