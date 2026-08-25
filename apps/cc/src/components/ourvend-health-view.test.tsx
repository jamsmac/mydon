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
  // Сбор стоит больше суток (R-P8a-6) — та же прод-картина 25.08.
  staleHours: 27,
  staleThresholdH: 6,
  slotsLagMin: null,
  salesLagH: 10.7,
  productSaleLagH: 36.8,
  parity: { days: 14, ok: true, mismatches: 0, stockOk: true, checked: 14, stockChecked: 14, note: null },
};

const ЗДОРОВ: OurvendHealth = {
  runs: [прогон("success", "2026-08-25T06:00:00.000Z")],
  failedStreak: 0,
  lastSuccessAt: "2026-08-25T06:00:00.000Z",
  staleHours: 1.2,
  staleThresholdH: 6,
  slotsLagMin: 48,
  salesLagH: 1.2,
  productSaleLagH: 2.4,
  parity: { days: 14, ok: true, mismatches: 0, stockOk: true, checked: 14, stockChecked: 14, note: null },
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
        health={{ ...ЗДОРОВ, parity: { days: 14, ok: false, mismatches: 3, stockOk: false, checked: 14, stockChecked: 14, note: "снапшот моложе окна" } }}
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

describe("Здоровье сбора: застой сбора (R-P8a-6)", () => {
  it("застой поднимает общую тревогу секции и пишется отдельной строкой", () => {
    render(<OurvendHealthCard health={{ ...ЗДОРОВЬЕ, staleHours: 9, staleThresholdH: 6, failedStreak: 0 }} />);
    expect(screen.getByText("тревога")).toBeInTheDocument();
    expect(screen.getByText(/сбор стоит 9 ч/)).toBeInTheDocument();
  });

  it("сбор свежий — бейджа застоя нет", () => {
    render(<OurvendHealthCard health={{ ...ЗДОРОВЬЕ, staleHours: 1.2, staleThresholdH: 6 }} />);
    expect(screen.queryByText(/сбор стоит/)).toBeNull();
  });

  it("успешных прогонов не было ни разу — тоже застой, своим текстом", () => {
    render(<OurvendHealthCard health={{ ...ЗДОРОВ, staleHours: null, staleThresholdH: 6 }} />);
    expect(screen.getByText("тревога")).toBeInTheDocument();
    expect(screen.getByText("успехов не было")).toBeInTheDocument();
  });

  it("прогонов нет вовсе — застой не поднимает тревогу и бейджа нет (нейтральное «не оценить»)", () => {
    render(
      <OurvendHealthCard
        health={{ ...ЗДОРОВ, runs: [], failedStreak: 0, lastSuccessAt: null, staleHours: null, staleThresholdH: 6 }}
      />,
    );
    expect(screen.getByText("не оценить")).toBeVisible();
    expect(screen.queryByText("тревога")).toBeNull();
    expect(screen.queryByText(/сбор стоит|успехов не было/)).toBeNull();
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
      <OurvendHealthCard health={{ ...ЗДОРОВ, parity: { days: 14, ok: false, mismatches: 1, stockOk: true, checked: 14, stockChecked: 14, note: null } }} />,
    );
    expect(screen.getByText("1 расхождение")).toBeVisible();
    unmount();
    render(
      <OurvendHealthCard health={{ ...ЗДОРОВ, parity: { days: 14, ok: false, mismatches: 5, stockOk: true, checked: 14, stockChecked: 14, note: null } }} />,
    );
    expect(screen.getByText("5 расхождений")).toBeVisible();
  });
});

/**
 * Вердикт паритета читается ПО СВОИМ счётчикам сравненных пар — `checked` для
 * продаж, `stockChecked` для остатков (N1), а не по общему `ok` и не разбором
 * текста `note`. Ниже — все комбинации «сходится/сверять нечего/расходится»
 * по каждой половине; та же логика, что у бота (`паритетСтрока`).
 */
describe("Здоровье сбора: паритет по числу сверенных пар (checked/stockChecked, N1)", () => {
  /**
   * Боевой первый прогон (adversarial-prod-data.md §3): снимки остатков OurVend
   * есть только за СЕГОДНЯ, окно паритета их отбрасывает — сверять остатки не по
   * чему. Продажи при этом сошлись идеально (14 пар, 0 расхождений), а общий
   * `ok` уже `false` из-за складской половины.
   */
  const ПРОДАЖИ_ЧИСТЫ_ОСТАТКИ_НЕТ = {
    ...ЗДОРОВ,
    parity: {
      days: 7,
      ok: false,
      mismatches: 0,
      stockOk: false,
      // 14 пар продаж сравнивались и сошлись, снимков остатков за период — ноль.
      checked: 14,
      stockChecked: 0,
      note: "остатки: снимков остатков OurVend за период нет — сверять не по чему",
    },
  };

  it("продажи чисты × остатки не сверяли — «сходятся» зелёным, «снимков нет» нейтрально", () => {
    render(<OurvendHealthCard health={ПРОДАЖИ_ЧИСТЫ_ОСТАТКИ_НЕТ} />);
    expect(screen.getByText("продажи сходятся")).toBeVisible();
    expect(screen.getByText("продажи сходятся").className).not.toMatch(/bad/);
    const остатки = screen.getByText("остатки: снимков за период нет");
    expect(остатки).toBeVisible();
    expect(остатки.className).not.toMatch(/bad/);
    expect(screen.queryByText("остатки расходятся")).toBeNull();
    expect(document.querySelectorAll(".pill.bad")).toHaveLength(0);
  });

  it("причина сказана словами в самой строке", () => {
    render(<OurvendHealthCard health={ПРОДАЖИ_ЧИСТЫ_ОСТАТКИ_НЕТ} />);
    expect(screen.getByText(/снимков остатков OurVend за период нет/)).toBeVisible();
  });

  /**
   * И продажи, и остатки не сравнивались вовсе (`checked: 0, stockChecked: 0`)
   * — самый пустой снимок паритета. «Сходится» здесь так же ложно, как
   * «расходится»: сказать нечего, обе пилюли нейтральны (N2).
   */
  const НЕЧЕМ = {
    ...ЗДОРОВ,
    parity: {
      days: 7,
      ok: false,
      mismatches: 0,
      stockOk: false,
      // Ноль сравненных пар с обеих сторон — «сверять нечем», а не «сошлось»/«разошлось».
      checked: 0,
      stockChecked: 0,
      note: "остатки: снимков остатков OurVend за период нет — сверять не по чему",
    },
  };

  it("продажи не сверяли × остатки не сверяли — обе половины нейтральны", () => {
    render(<OurvendHealthCard health={НЕЧЕМ} />);
    expect(screen.getByText("продажи: сверять нечего")).toBeVisible();
    const остатки = screen.getByText("остатки: снимков за период нет");
    expect(остатки).toBeVisible();
    expect(остатки.className).not.toMatch(/bad/);
    expect(document.querySelectorAll(".pill.bad")).toHaveLength(0);
  });

  it("продажи не сверяли × остатки чисты — «сверять нечего» только у продаж", () => {
    render(
      <OurvendHealthCard health={{ ...ЗДОРОВ, parity: { ...ЗДОРОВ.parity, checked: 0, ok: false } }} />,
    );
    expect(screen.getByText("продажи: сверять нечего")).toBeVisible();
    expect(screen.getByText("остатки сходятся")).toBeVisible();
    expect(document.querySelectorAll(".pill.bad")).toHaveLength(0);
  });

  it("продажи чисты × остатки чисты — обе пилюли зелёные", () => {
    render(<OurvendHealthCard health={ЗДОРОВ} />);
    expect(screen.getByText("продажи сходятся")).toBeVisible();
    expect(screen.getByText("остатки сходятся")).toBeVisible();
    expect(document.querySelectorAll(".pill.bad")).toHaveLength(0);
  });

  /**
   * До фикса N1 панель считала вердикт продаж по общему `ok` и разбору
   * текста `note`: продажи сверены и сошлись, а остатки реально разошлись
   * (`stockChecked > 0`, `stockOk: false`) — панель гасила ПРОДАЖНУЮ пилюлю
   * вместе со складской. Бот на этом же payload даёт «продажи ✅ сходятся» —
   * панель обязана то же самое.
   */
  it("продажи чисты × остатки реально разошлись — красная пилюля только у остатков", () => {
    render(
      <OurvendHealthCard
        health={{ ...ЗДОРОВ, parity: { ...ЗДОРОВ.parity, stockOk: false, note: "снапшот моложе окна" } }}
      />,
    );
    expect(screen.getByText("продажи сходятся")).toBeVisible();
    expect(screen.getByText("продажи сходятся").className).not.toMatch(/bad/);
    expect(screen.getByText("остатки расходятся").className).toMatch(/bad/);
  });
});
