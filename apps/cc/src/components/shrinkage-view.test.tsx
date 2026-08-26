import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CoreUnavailable, type VendingShrinkageReport } from "../lib/core";
import { VENDHUB_GROUPS, isTableBackedLeaf } from "../lib/domain-nav";
import { ShrinkageAlerts, ShrinkageAlertsFailed, ShrinkageTables, ShrinkageView } from "./shrinkage-view";
import { stockFreshnessNote } from "./supply-views";

const mocks = vi.hoisted(() => ({ vendingShrinkage: vi.fn() }));
// В одном файле с таблицами живёт серверный `ShrinkageView`, а он тянет клиент
// Core — тот первой строкой импортирует пакет `server-only`, которого вне RSC
// не существует. Сами таблицы Core не трогают: им отдают готовый отчёт пропом.
vi.mock("../lib/core", () => ({
  core: { vendingShrinkage: mocks.vendingShrinkage },
  CoreUnavailable: class CoreUnavailable extends Error {
    constructor(readonly detail: string) {
      super("Core недоступен");
    }
  },
}));

const report: VendingShrinkageReport = {
  from: "2026-08-11",
  to: "2026-08-24",
  threshold: 30_000,
  machines: [
    {
      serial: "2508160376",
      name: "Olma",
      summary: {
        items: [
          { product: "Kinder Bueno", lossUnits: 9, lossValue: 99_000, surplusUnits: 0, daysCounted: 9, noPrice: false, alert: true },
          { product: "Qurt", lossUnits: 6, lossValue: 40_800, surplusUnits: 2, daysCounted: 8, noPrice: false, alert: true },
          { product: "TUC", lossUnits: 2, lossValue: 0, surplusUnits: 0, daysCounted: 7, noPrice: true, alert: false },
        ],
        lossValue: 139_800,
        daysCounted: 9,
        daysSkipped: 5,
        threshold: 30_000,
      },
      refillDays: [
        { date: "2026-08-18", detectedUnits: 96, recordedUnits: 0 },
        { date: "2026-08-21", detectedUnits: 87, recordedUnits: 80 },
      ],
    },
    {
      serial: "2508160359",
      name: "American Hospital",
      summary: { items: [], lossValue: 0, daysCounted: 14, daysSkipped: 0, threshold: 30_000 },
      refillDays: [],
    },
  ],
  warnings: [
    { code: "no_sales_day", message: "Olma: нет продаж за 2026-08-12 — дни не считались" },
    // Дубль намеренно: ядро складывает предупреждения по автоматам, и один и
    // тот же текст приходит дважды, когда причина общая.
    { code: "no_sales_day", message: "Olma: нет продаж за 2026-08-12 — дни не считались" },
    { code: "machine_dead", message: "SKLAD 4S: источник отдаёт мусор вместо остатков — усушка не считается" },
  ],
};

const пустой: VendingShrinkageReport = { from: "2026-08-11", to: "2026-08-24", threshold: 30_000, machines: [], warnings: [] };

/** Автоматы есть, у обоих посчитан весь период, расхождений нет ни у одного. */
const посчитанныйБезПотерь: VendingShrinkageReport = {
  from: "2026-08-11",
  to: "2026-08-24",
  threshold: 30_000,
  machines: [
    { serial: "s1", name: "M1", summary: { items: [], lossValue: 0, daysCounted: 14, daysSkipped: 0, threshold: 30_000 }, refillDays: [] },
  ],
  warnings: [],
};

describe("лист «Усушка»", () => {
  it("по автомату: заголовок с днями, позиции, деньги и итог", () => {
    render(<ShrinkageTables report={report} />);
    expect(screen.getByText(/Olma · дней посчитано 9, не в счёт из-за заливки 5/)).toBeVisible();
    expect(screen.getByText("Kinder Bueno")).toBeVisible();
    expect(screen.getByText(/потеря 9 шт/)).toBeVisible();
    // Излишек виден, но в деньги не входит (R-P4-3) — поэтому он в подписи.
    expect(screen.getByText(/излишек 2 шт/)).toBeVisible();
    expect(screen.getByText(/Итого ≈ 139 800 сум/)).toBeVisible();
    // Автомат без потерь не выкидывается: «посчитано, потерь нет» — это ответ.
    expect(screen.getByText(/American Hospital · дней посчитано 14, не в счёт из-за заливки 0/)).toBeVisible();
  });

  it("пилюли: «⚠️ порог» у позиции за порогом, «нет цены» — у позиции без прайса", () => {
    render(<ShrinkageTables report={report} />);
    expect(screen.getAllByText("⚠️ порог")).toHaveLength(2);
    expect(screen.getByText("нет цены")).toBeVisible();
    // У позиции без цены сумма 0 — «0 сум» читалось бы как «потерь на ноль».
    const tuc = screen.getByText("TUC").closest(".row");
    expect(within(tuc as HTMLElement).queryByText(/0 сум/)).toBeNull();
  });

  it("дни заливок: «записано 0» приглушено, записанная заливка — нет", () => {
    render(<ShrinkageTables report={report} />);
    expect(screen.getByText(/18\.08 · \+96 ед/)).toBeVisible();
    const ноль = screen.getByText("записано 0");
    expect(ноль).toBeVisible();
    expect(ноль.className).toMatch(/muted/);
    expect(screen.getByText("записано 80").className).not.toMatch(/muted/);
  });

  it("предупреждения показываются один раз, даже если ядро прислало дубль", () => {
    render(<ShrinkageTables report={report} />);
    expect(screen.getAllByText(/нет продаж за 2026-08-12/)).toHaveLength(1);
    expect(screen.getByText(/SKLAD 4S/)).toBeVisible();
  });

  it("автоматов в отчёте нет — «Данных нет», а не «Потерь за период нет» (R-FW-7)", () => {
    render(<ShrinkageTables report={пустой} />);
    expect(screen.getByText("Данных нет")).toBeVisible();
    expect(screen.getByText(/Ни одного автомата в отчёте/)).toBeVisible();
    expect(screen.queryByText("Потерь за период нет")).toBeNull();
  });

  it("автоматы есть, все посчитаны полностью, потерь нет — «Потерь за период нет»", () => {
    render(<ShrinkageTables report={посчитанныйБезПотерь} />);
    expect(screen.getByText("Потерь за период нет")).toBeVisible();
  });

  it("автоматы есть, потерь не насчитано, но данные неполные — про «потерь нет» молчим", () => {
    render(<ShrinkageTables report={{ ...посчитанныйБезПотерь, warnings: report.warnings }} />);
    expect(screen.queryByText("Потерь за период нет")).toBeNull();
    expect(screen.getByText("Потерь не насчитано")).toBeVisible();
    expect(screen.getByText(/SKLAD 4S/)).toBeVisible();
  });

  it("daysCounted=0 у автомата — «не считали», а не «Расхождений нет», и «Потерь нет» не говорим", () => {
    const недосчитан: VendingShrinkageReport = {
      ...пустой,
      machines: [
        {
          serial: "s2",
          name: "M2",
          // daysSkipped=0 нарочно: период `пустой` (from/to) — ровно 14 дней,
          // и текст обязан взять длину периода, а не daysSkipped (N3) — со
          // старым кодом (`n(m.summary.daysSkipped)`) здесь было бы «все 0».
          summary: { items: [], lossValue: 0, daysCounted: 0, daysSkipped: 0, threshold: 30_000 },
          refillDays: [],
        },
      ],
    };
    render(<ShrinkageTables report={недосчитан} />);
    expect(screen.getByText(/Не считали — все 14 дн\. периода были заливкой\/пропущены/)).toBeVisible();
    expect(screen.queryByText("Расхождений нет")).toBeNull();
    expect(screen.queryByText("Потерь за период нет")).toBeNull();
    expect(screen.getByText("Потерь не насчитано")).toBeVisible();
  });

  it("суммы без неразрывного пробела (U+00A0) — копипаста и поиск не ломаются", () => {
    const крупный: VendingShrinkageReport = {
      ...пустой,
      machines: [
        {
          serial: "s3",
          name: "M3",
          summary: {
            items: [{ product: "Y", lossUnits: 12_345, lossValue: 0, surplusUnits: 0, daysCounted: 9, noPrice: true, alert: false }],
            lossValue: 0,
            daysCounted: 9,
            daysSkipped: 0,
            threshold: 30_000,
          },
          refillDays: [],
        },
      ],
    };
    render(<ShrinkageTables report={крупный} />);
    // Только узлы, которые проходят через n() — money() («порог», «Итого»)
    // U+00A0 не чинит, это вне области этого пункта.
    for (const el of screen.getAllByText(/12 345 шт/)) {
      expect(el.textContent).not.toMatch(/\u00a0/);
    }
  });
});

describe("лист «Усушка»: поход в ядро", () => {
  it("Core не ответил — честный экран «нет связи», а не пустой отчёт", async () => {
    mocks.vendingShrinkage.mockRejectedValue(new CoreUnavailable("HTTP 502"));
    render(await ShrinkageView({ domain: "vendhub", days: 14 }));
    expect(screen.getByText("Нет связи с ядром MYDON")).toBeVisible();
    expect(screen.getByText("HTTP 502")).toBeVisible();
  });

  it("окно берётся из адреса и уходит в ядро", async () => {
    mocks.vendingShrinkage.mockResolvedValue(report);
    render(await ShrinkageView({ domain: "vendhub", days: 30 }));
    expect(mocks.vendingShrinkage).toHaveBeenCalledWith(30);
    expect(screen.getByText("Kinder Bueno")).toBeVisible();
    expect(screen.getByText(/порог 30 000 сум/)).toBeVisible();
  });
});

describe("секция «Усушка за 14 дней» на вкладке «Снек»", () => {
  it("подсказка под заголовком объясняет термин (U5)", () => {
    render(<ShrinkageAlerts report={report} domain="vendhub" />);
    expect(screen.getByText("Расхождение остатков с продажами, без дней заливки.")).toBeVisible();
  });

  it("топ-5 позиций за порогом по убыванию денег и ссылка на лист", () => {
    render(<ShrinkageAlerts report={report} domain="vendhub" />);
    const rows = screen.getAllByText(/шт ≈/);
    expect(rows).toHaveLength(2);
    // Порядок — по деньгам: Kinder Bueno (99 000) впереди Qurt (40 800).
    expect(rows[0]!.textContent).toContain("Kinder Bueno");
    expect(screen.getByText(/Olma · Kinder Bueno −9 шт ≈ 99 000 сум/)).toBeVisible();
    expect(screen.getByRole("link", { name: /Усушка/ })).toHaveAttribute(
      "href",
      "/domain/vendhub?tab=reports%3Ashrinkage",
    );
  });

  it("за порогом никого, но автоматы посчитаны — одна честная строка, а не пустая секция", () => {
    render(<ShrinkageAlerts report={посчитанныйБезПотерь} domain="vendhub" />);
    expect(screen.getByText("Порог не превышен")).toBeVisible();
  });

  it("автоматов в отчёте нет — «Данных нет», а не «Порог не превышен» (R-FW-7)", () => {
    render(<ShrinkageAlerts report={пустой} domain="vendhub" />);
    expect(screen.getByText("Данных нет — ни одного автомата в отчёте")).toBeVisible();
    expect(screen.queryByText("Порог не превышен")).toBeNull();
  });
});

describe("секция «Усушка» на «Снек»: сбой подзапроса к ядру", () => {
  it("«не проверили», а не пропавшая секция (final-review (d))", () => {
    render(<ShrinkageAlertsFailed />);
    expect(screen.getByText(/Усушка за 14 дней/)).toBeVisible();
    expect(screen.getByText("Усушка: не проверили (Core не ответил)")).toBeVisible();
  });
});

describe("навигация: лист «Усушка»", () => {
  it("стоит в «Отчётах» и не гасится счётчиком реестра", () => {
    const reports = VENDHUB_GROUPS.find((g) => g.key === "reports");
    expect(reports?.leaves).toContainEqual({ label: "Усушка", type: "shrinkage" });
    // Своих карточек реестра лист не заводит — счёт по byType был бы 0.
    expect(isTableBackedLeaf("shrinkage")).toBe(true);
  });
});

describe("подпись частоты остатков", () => {
  it("свой снимок — говорим про детектор заливок, зеркало — про 10 минут", () => {
    expect(stockFreshnessNote("own")).toBe("остатки: свой снимок раз в 3 часа (детектор заливок)");
    expect(stockFreshnessNote("stock")).toBe("обновляется каждые 10 минут");
    // Ядро поля ещё не отдаёт: молчание источника не должно менять подпись.
    expect(stockFreshnessNote(undefined)).toBe("обновляется каждые 10 минут");
  });
});

describe("числа усушки копируются (R-H-3)", () => {
  it("в выводе листа нет неразрывного пробела", () => {
    const { container } = render(<ShrinkageTables report={report} />);
    expect(container.textContent ?? "").not.toContain("\u00a0");
  });
});
