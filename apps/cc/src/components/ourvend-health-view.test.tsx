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
  parity: { days: 14, ok: true, mismatches: 0, stockOk: true, stockChecked: 14, note: null },
};

const ЗДОРОВ: OurvendHealth = {
  runs: [прогон("success", "2026-08-25T06:00:00.000Z")],
  failedStreak: 0,
  lastSuccessAt: "2026-08-25T06:00:00.000Z",
  slotsLagMin: 48,
  salesLagH: 1.2,
  productSaleLagH: 2.4,
  parity: { days: 14, ok: true, mismatches: 0, stockOk: true, stockChecked: 14, note: null },
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
        health={{ ...ЗДОРОВ, parity: { days: 14, ok: false, mismatches: 3, stockOk: false, stockChecked: 14, note: "снапшот моложе окна" } }}
      />,
    );
    expect(screen.getByText("3 расхождения")).toBeVisible();
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

describe("Здоровье сбора: три состояния журнала прогонов", () => {
  it("прогонов нет — «не оценить», а не зелёное «сбоев подряд нет»", () => {
    render(<OurvendHealthCard health={{ ...ЗДОРОВ, runs: [], failedStreak: 0, lastSuccessAt: null }} />);
    // Ноль отказов на пустом журнале — это НЕ «сбор здоров»: сбор просто ни
    // разу не запускался (та же ❓-развилка, что у бота в состоянииСбора).
    expect(screen.queryByText("сбоев подряд нет")).toBeNull();
    expect(screen.getByText("прогонов нет — не оценить")).toBeVisible();
    expect(screen.getByText("не оценить")).toBeVisible();
    expect(screen.queryByText("тревога")).toBeNull();
  });

  it("сбой на границе: 3 отказа — тревога, 2 — ещё нет", () => {
    const { unmount } = render(<OurvendHealthCard health={{ ...ЗДОРОВ, failedStreak: 3 }} />);
    expect(screen.getByText("3 отказа подряд").className).toMatch(/bad/);
    expect(screen.getByText("тревога")).toBeVisible();
    unmount();
    render(<OurvendHealthCard health={{ ...ЗДОРОВ, failedStreak: 2 }} />);
    expect(screen.getByText("2 отказа подряд").className).not.toMatch(/bad/);
    expect(screen.queryByText("тревога")).toBeNull();
  });

  it("лаг на границе: 6,0 ч — ещё не тревога, 6,1 ч — уже тревога", () => {
    const { unmount } = render(<OurvendHealthCard health={{ ...ЗДОРОВ, salesLagH: 6 }} />);
    expect(screen.getByText("6,0 ч").className).not.toMatch(/bad/);
    expect(screen.queryByText("тревога")).toBeNull();
    unmount();
    render(<OurvendHealthCard health={{ ...ЗДОРОВ, salesLagH: 6.1 }} />);
    expect(screen.getByText("6,1 ч").className).toMatch(/bad/);
    expect(screen.getByText("тревога")).toBeVisible();
  });
});

describe("Здоровье сбора: тексты для владельца", () => {
  it("витрина названа по-человечески, имя таблицы не показывается", () => {
    render(<OurvendHealthCard health={ЗДОРОВ} />);
    expect(screen.getByText(/Снимки продаж по товарам \(кабинет\)/)).toBeVisible();
    expect(screen.queryByText(/product_sale/)).toBeNull();
  });

  it("расхождения склоняются числом", () => {
    const { unmount } = render(
      <OurvendHealthCard health={{ ...ЗДОРОВ, parity: { days: 14, ok: false, mismatches: 1, stockOk: true, stockChecked: 14, note: null } }} />,
    );
    expect(screen.getByText("1 расхождение")).toBeVisible();
    unmount();
    render(
      <OurvendHealthCard health={{ ...ЗДОРОВ, parity: { days: 14, ok: false, mismatches: 5, stockOk: true, stockChecked: 14, note: null } }} />,
    );
    expect(screen.getByText("5 расхождений")).toBeVisible();
  });
});

/**
 * Боевой первый прогон (adversarial-prod-data.md §3): снимки остатков OurVend
 * есть только за СЕГОДНЯ, окно паритета их отбрасывает — сверять остатки не по
 * чему. Продажи при этом сошлись идеально (14 пар, 0 расхождений), а общий
 * `ok` уже `false` из-за складской половины.
 */
describe("Здоровье сбора: паритет, когда сверять нечем", () => {
  const НЕЧЕМ = {
    ...ЗДОРОВ,
    parity: {
      days: 7,
      ok: false,
      mismatches: 0,
      stockOk: false,
      // Ноль сравненных пар — «сверять нечем», а не «сошлось»/«разошлось».
      stockChecked: 0,
      note: "остатки: снимков остатков OurVend за период нет — сверять не по чему",
    },
  };

  it("остатки — нейтральное «снимков за период нет», а не красное «расходятся»", () => {
    render(<OurvendHealthCard health={НЕЧЕМ} />);
    const остатки = screen.getByText("остатки: снимков за период нет");
    expect(остатки).toBeVisible();
    expect(остатки.className).not.toMatch(/bad/);
    expect(screen.queryByText("остатки расходятся")).toBeNull();
  });

  it("продажи остаются сошедшимися — «0 расхождений» красным не печатаем", () => {
    render(<OurvendHealthCard health={НЕЧЕМ} />);
    expect(screen.getByText("продажи сходятся")).toBeVisible();
    expect(screen.queryByText(/0 расхожден/)).toBeNull();
    expect(document.querySelectorAll(".pill.bad")).toHaveLength(0);
  });

  it("причина сказана словами в самой строке", () => {
    render(<OurvendHealthCard health={НЕЧЕМ} />);
    expect(screen.getByText(/снимков остатков OurVend за период нет/)).toBeVisible();
  });

  it("половины независимы: продажи разошлись, остатки не сверяли", () => {
    render(<OurvendHealthCard health={{ ...НЕЧЕМ, parity: { ...НЕЧЕМ.parity, mismatches: 4 } }} />);
    expect(screen.getByText("4 расхождения").className).toMatch(/bad/);
    expect(screen.getByText("остатки: снимков за период нет").className).not.toMatch(/bad/);
  });
});
