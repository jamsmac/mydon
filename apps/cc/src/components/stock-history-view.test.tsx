import { readFileSync } from "node:fs";
import { join } from "node:path";
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

/**
 * Боевая форма — та, которую КОД РЕАЛЬНО ПРОИЗВОДИТ, а не удобная глазу.
 *
 * · `own`: `note` = актор `ingestStock`, а контроллер зовёт её без аргумента
 *   (`vending.controller.ts`), то есть сегодня на всех своих строках стоит
 *   ровно `"owner"`. Красивое «Рустам» здесь было бы фикстурой, прячущей вход.
 * · `stock-import`: `note` = ВСЯ пометка целиком, с 30-символьным техническим
 *   префиксом (`importNote` в `packages/shared/src/stock-history.ts`). Именно
 *   этот вид приезжает на всех ~460 донорских строках.
 */
const ИСТОРИЯ: StockCountsReport = {
  days: 90,
  since: "2026-05-28",
  product: null,
  rows: [
    { dt: "2026-08-25", product: "Sprite 250ml", qty: 19, source: "own", countedAt: "2026-08-25T09:40:00+05:00", note: "owner" },
    { dt: "2026-08-25", product: "TUC Sour cream", qty: 6, source: "own", countedAt: "2026-08-25T09:40:00+05:00", note: "owner" },
    {
      dt: "2026-06-01",
      product: "Montella Вода минеральная 330ml",
      qty: 3,
      source: "stock-import",
      countedAt: "2026-06-01T07:00:00+05:00",
      note: "импорт истории mydon-stock · место: Холодильник",
    },
    {
      dt: "2026-06-01",
      product: "Snickers",
      qty: 41,
      source: "stock-import",
      countedAt: "2026-06-01T07:00:00+05:00",
      note: "импорт истории mydon-stock · место: Склад (основной)",
    },
  ],
  warnings: [],
};

describe("Лист «История склада» (R-H-2)", () => {
  it("сутки идут свежими сверху, внутри суток — группы по пометке", () => {
    const дни = groupStockCounts(ИСТОРИЯ.rows);
    expect(дни.map((d) => d.dt)).toEqual(["2026-08-25", "2026-06-01"]);
    expect(дни[1]!.groups.map((g) => g.note)).toEqual([
      "импорт истории mydon-stock · место: Холодильник",
      "импорт истории mydon-stock · место: Склад (основной)",
    ]);
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
    expect(within(screen.getByText("owner").closest("div")!).getByText("кто считал")).toBeVisible();
    expect(within(screen.getByText("Холодильник").closest("div")!).getByText("место")).toBeVisible();
  });

  it("в заголовке импортированной группы стоит МЕСТО, а не технический префикс пометки", () => {
    // `note` в API остаётся сырым (честные данные), а префикс снимает обратная
    // к `importNote` — `placeFromImportNote` из `@mydon/shared`. Своей копии
    // строки «импорт истории mydon-stock» витрина не заводит: разъехавшись,
    // копия молча перестала бы сокращать заголовки.
    render(<StockHistoryTables report={ИСТОРИЯ} />);
    expect(screen.getByText("Холодильник")).toBeVisible();
    expect(screen.getByText("Склад (основной)")).toBeVisible();
    expect(screen.queryByText(/импорт истории mydon-stock/)).toBeNull();
  });

  it("импорт БЕЗ места печатается как есть: выдумывать «Основной склад» нельзя", () => {
    render(
      <StockHistoryTables
        report={{
          ...ИСТОРИЯ,
          rows: [{ ...ИСТОРИЯ.rows[2]!, note: "импорт истории mydon-stock" }],
        }}
      />,
    );
    expect(screen.getByText("импорт истории mydon-stock")).toBeVisible();
  });

  it("заголовок группы носит класс, который globals.css стилизует ВНЕ `.row`", () => {
    // Голый `.t` объявлен только как `.row .t`: заголовок, стоящий НАД
    // карточкой `.rows`, получил бы от него ровно ничего — «owner» и «кто
    // считал» слиплись бы в строку неоформленного текста. jsdom CSS не
    // применяет, поэтому сторож утверждает про класс и про сам файл стилей.
    render(<StockHistoryTables report={ИСТОРИЯ} />);
    const подпись = screen.getByText("Холодильник").closest("div")!;
    expect(подпись.className).toBe("rcard-h");

    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    expect(css).toMatch(/^\.rcard-h\s*\{/m);
    expect(css).toMatch(/^\.rcard-h \.t\s*\{/m);
    expect(css).toMatch(/^\.rcard-h \.ts\s*\{/m);
    // Тот самый дефект, ради которого сторож и написан: правила для голого
    // `.t` в файле нет вовсе — значит выносить `.t` за пределы `.row` нельзя.
    expect(css).not.toMatch(/^\.t\s*\{/m);
  });

  it("подпись окна берёт `since` из ответа, а не пересчитывает его", () => {
    render(<StockHistoryTables report={ИСТОРИЯ} />);
    expect(screen.getByText(/Пересчёты склада за 90 дн\. · с 28\.05\.2026 · 4 строки/)).toBeVisible();
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

  it("фильтр по товару достижим с листа: своя GET-форма, окно она сохраняет", async () => {
    // Без формы ветка «По этому товару истории нет» и весь смысл
    // `COVERED_BY_STOCK_HISTORY` включались бы только руками собранным адресом:
    // общего поля поиска у страницы отчётов нет — его рисуют книги.
    mocks.vendingStockCounts.mockResolvedValueOnce({ ...ИСТОРИЯ, days: 365, product: "Snickers" });
    render(await StockHistoryView({ domain: "vendhub", days: 365, q: "Snickers" }));
    const поле = screen.getByLabelText("Фильтр истории по товару");
    expect(поле).toHaveValue("Snickers");
    const форма = поле.closest("form")!;
    expect(форма.getAttribute("method")).toBe("get");
    expect(форма.getAttribute("action")).toBe("/domain/vendhub");
    expect(форма.querySelector<HTMLInputElement>('input[name="days"]')!.value).toBe("365");
    expect(форма.querySelector<HTMLInputElement>('input[name="tab"]')!.value).toBe("reports:stock_history");
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
