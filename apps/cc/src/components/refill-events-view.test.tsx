import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { VendingRefillEvent } from "../lib/core";
import { VENDHUB_GROUPS, isTableBackedLeaf } from "../lib/domain-nav";
import { REFILL_EVENT_WINDOWS, RefillEventsTable, RefillEventsView, лидЖурнала } from "./refill-events-view";

const mocks = vi.hoisted(() => ({ vendingRefillEvents: vi.fn() }));
vi.mock("../lib/core", () => ({
  core: { vendingRefillEvents: mocks.vendingRefillEvents },
  CoreUnavailable: class CoreUnavailable extends Error {
    constructor(readonly detail: string) {
      super("Core недоступен");
    }
  },
}));

/** Боевая форма: 6 событий / 430 ед. за 14 дней на живых данных (П4). */
const СОБЫТИЯ: VendingRefillEvent[] = [
  {
    id: "ev-1",
    serial: "2508160376",
    name: "Olma Администрация",
    windowFrom: "2026-08-24T22:00:00+05:00",
    windowTo: "2026-08-25T01:00:00+05:00",
    units: 42,
    slots: [
      { coilId: "11", product: "TUC Sour cream", before: 2, after: 20, delta: 18 },
      { coilId: "12", product: "Snickers", before: 0, after: 24, delta: 24 },
    ],
    matchedRefillId: null,
  },
  {
    id: "ev-2",
    serial: "2508160359",
    // Карточки автомата нет — `list()` кладёт в `name` сам серийник.
    name: "2508160359",
    windowFrom: "2026-08-20T04:00:00+05:00",
    windowTo: "2026-08-20T07:00:00+05:00",
    units: 12,
    slots: [],
    matchedRefillId: "r-77",
  },
];

describe("Лист «Журнал заливок» (R-H-5)", () => {
  it("событие без записи оператора подписано «только снимки», с записью — «снимки + запись оператора»", () => {
    render(<RefillEventsTable rows={СОБЫТИЯ} />);
    // «Только снимки» — НЕ ошибка: заливка = факт снимка (R-P4-2), а запись
    // оператора лишь уточняет. Красить её тревогой значило бы будить владельца
    // о нормальном ходе дел.
    expect(screen.getByText("только снимки")).toBeVisible();
    expect(screen.getByText("снимки + запись оператора")).toBeVisible();
  });

  it("автомат без карточки подписан «карточки автомата нет» — тем же текстом, что маржа", () => {
    render(<RefillEventsTable rows={СОБЫТИЯ} />);
    expect(screen.getByText(/карточки автомата нет/)).toBeVisible();
  });

  it("слоты события печатаются строками, пустой список назван словами", () => {
    render(<RefillEventsTable rows={СОБЫТИЯ} />);
    expect(screen.getByText(/TUC Sour cream/)).toBeVisible();
    expect(screen.getByText("слоты не записаны")).toBeVisible();
  });

  it("пустой журнал — «не привозили», а не «не считали»", () => {
    render(<RefillEventsTable rows={[]} />);
    expect(screen.getByText(/не привозили/)).toBeVisible();
  });

  it("порог детектора назван ЧЕЛОВЕЧЕСКИМ именем настройки, а не ключом из `.env`", () => {
    // `REFILL_DETECT_MIN_UNITS` заглавными посреди русской фразы — то же
    // «идентификатор вместо ответа», что лист истории склада уже убрал.
    const { container } = render(<RefillEventsTable rows={[]} />);
    expect(screen.getByText(/«Вендинг: порог детектора заливки»/)).toBeVisible();
    expect(container.textContent ?? "").not.toContain("REFILL_DETECT_MIN_UNITS");
  });

  it("ни одна подпись листа не печатает техническую строку", () => {
    const { container } = render(<RefillEventsTable rows={СОБЫТИЯ} />);
    const текст = container.textContent ?? "";
    for (const техническое of ["REFILL_DETECT_MIN_UNITS", "mydon-stock", "owner", "matched_refill_id", "LIST_LIMIT"]) {
      expect(текст).not.toContain(техническое);
    }
  });

  it("лид не повторяет имя вкладки и называет охват", async () => {
    // Название «Журнал заливок» уже стоит во вкладках сверху; шесть соседних
    // листов своё имя в лиде не повторяют — этот был единственным исключением.
    mocks.vendingRefillEvents.mockResolvedValueOnce({ rows: СОБЫТИЯ, capped: false });
    render(await RefillEventsView({ domain: "vendhub", days: 90 }));
    const лид = screen.getByText(/Приход по снимкам за 90 дн\./);
    expect(лид.textContent).toContain("2 события");
    expect(лид.textContent).not.toContain("Журнал заливок");
  });

  it("журнал упёрся в потолок строк — лид говорит это, а не печатает 500 как посчитанный итог", async () => {
    // Молчаливая обрезка: «500 событий» читается как полный счёт за окно.
    // Сосед (история склада) ровно этот случай называет словами.
    mocks.vendingRefillEvents.mockResolvedValueOnce({ rows: СОБЫТИЯ, capped: true });
    render(await RefillEventsView({ domain: "vendhub", days: 90 }));
    const лид = screen.getByText(/Приход по снимкам за 90 дн\./);
    expect(лид.textContent).toContain("показаны последние 2 события — сузьте окно");
  });

  it("боевая обрезка пришпилена ЧИСЛОМ ПОТОЛКА: 500 событий, а не «сколько дала фикстура»", () => {
    // Правило писано ради `LIST_LIMIT = 500` (`refill-events.service.ts`):
    // именно это число лист печатал как посчитанный за окно итог. Утверждение
    // на двух событиях проверяло бы форму, но не тот случай, ради которого
    // правило и появилось.
    const пятьсот = Array.from({ length: 500 }, (_, i) => ({ ...СОБЫТИЯ[0]!, id: `ev-${i}` }));
    expect(лидЖурнала(90, пятьсот, true)).toBe(
      "Приход по снимкам за 90 дн. · показаны последние 500 событий — сузьте окно",
    );
    // Ровно те же 500 без обрезки — это посчитанный итог, и говорится он иначе.
    expect(лидЖурнала(90, пятьсот, false)).toBe("Приход по снимкам за 90 дн. · 500 событий");
  });

  it("окна листа — те, что сервер отдаёт целиком после поднятия потолка", () => {
    expect(REFILL_EVENT_WINDOWS).toEqual([14, 30, 90]);
  });

  it("Core не ответил — лист говорит это, а не рисует пустой журнал", async () => {
    const { CoreUnavailable } = await import("../lib/core");
    mocks.vendingRefillEvents.mockRejectedValueOnce(new CoreUnavailable("ECONNREFUSED"));
    render(await RefillEventsView({ domain: "vendhub", days: 14 }));
    expect(screen.getByText(/ECONNREFUSED/)).toBeVisible();
  });
});

describe("навигация: лист «Журнал заливок»", () => {
  it("стоит в «Отчётах» сразу за «Усушкой» и не гасится счётчиком реестра", () => {
    const reports = VENDHUB_GROUPS.find((g) => g.key === "reports");
    const i = reports!.leaves.findIndex((l) => l.type === "shrinkage");
    expect(reports!.leaves[i + 1]).toEqual({ label: "Журнал заливок", type: "refill_events" });
    expect(isTableBackedLeaf("refill_events")).toBe(true);
  });
});
