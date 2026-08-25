import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatShrinkage, isShrinkageQuery, parseShrinkageDays } from "./shrinkage-brief";
import { TG_BUDGET, MAX_PARTS } from "./purchase-plan";
import type { ShrinkMachine, ShrinkReport } from "./core-client";

const машина = (over: Partial<ShrinkMachine> = {}): ShrinkMachine => ({
  serial: "2508160376",
  name: "Olma",
  summary: {
    items: [
      { product: "Kinder Bueno", lossUnits: 9, lossValue: 99_000, surplusUnits: 0, daysCounted: 9, noPrice: false, alert: true },
      { product: "Qurt", lossUnits: 6, lossValue: 40_800, surplusUnits: 0, daysCounted: 9, noPrice: false, alert: true },
    ],
    lossValue: 164_600,
    daysCounted: 9,
    daysSkipped: 5,
    threshold: 30_000,
  },
  refillDays: [
    { date: "2026-08-18", detectedUnits: 96, recordedUnits: 0 },
    { date: "2026-08-21", detectedUnits: 87, recordedUnits: 0 },
  ],
  ...over,
});

const отчёт = (over: Partial<ShrinkReport> = {}): ShrinkReport => ({
  from: "2026-08-11",
  to: "2026-08-24",
  threshold: 30_000,
  machines: [машина()],
  warnings: [],
  ...over,
});

describe("Усушка: команда владельца", () => {
  it("ловит «усушку» и «потери в автоматах»", () => {
    for (const t of ["усушка", "Усушка за 30 дней", "усушки", "потери в автоматах", "потеря автомат"]) {
      assert.ok(isShrinkageQuery(t), t);
    }
  });

  it("не перехватывает соседние вопросы", () => {
    for (const t of ["план закупа", "продажи", "что заказать", "потерял ключи"]) {
      assert.ok(!isShrinkageQuery(t), t);
    }
  });

  it("окно берётся из фразы и держится в границах Core (1–60)", () => {
    assert.equal(parseShrinkageDays("усушка"), 14, "по умолчанию — две недели");
    assert.equal(parseShrinkageDays("усушка за 30 дней"), 30);
    assert.equal(parseShrinkageDays("усушка за 7 дн"), 7);
    // Core отвечает 400 на окно вне 1..60 — владелец получил бы «попробуй
    // позже» вместо отчёта, хотя чинить надо фразу.
    assert.equal(parseShrinkageDays("усушка за 900 дней"), 60);
    assert.equal(parseShrinkageDays("усушка за 0 дней"), 14);
  });
});

describe("Усушка: форматирование", () => {
  it("по автомату: период, посчитанные дни, позиции и итог", () => {
    const [первое] = formatShrinkage(отчёт());
    assert.match(первое, /📉 Olma за 14 дн \(дней посчитано 9, с заливкой 5\)/);
    assert.match(первое, /Kinder Bueno −9 шт ≈ 99\s000 сум ⚠️/);
    assert.match(первое, /Qurt −6 шт ≈ 40\s800 сум ⚠️/);
    assert.match(первое, /Итого ≈ 164\s600 сум/);
  });

  it("заголовок называет окно и порог — иначе числа не с чем сравнить", () => {
    const [первое] = formatShrinkage(отчёт());
    assert.match(первое, /Усушка за 14 дн \(11\.08 — 24\.08\)/);
    assert.match(первое, /порог 30\s000 сум/);
  });

  it("заливки по снимкам показаны отдельной строкой", () => {
    const [первое] = formatShrinkage(отчёт());
    assert.match(первое, /Заливки по снимкам: 18\.08 \+96 \(записано 0\), 21\.08 \+87 \(записано 0\)/);
  });

  it("автомат без позиций и без заливок — одна строка «без потерь»", () => {
    const тихий = машина({
      name: "American Hospital",
      summary: { items: [], lossValue: 0, daysCounted: 12, daysSkipped: 2, threshold: 30_000 },
      refillDays: [],
    });
    const [первое] = formatShrinkage(отчёт({ machines: [тихий] }));
    assert.match(первое, /American Hospital — без потерь/);
    assert.ok(!/дней посчитано/.test(первое), "тихому автомату разбор не нужен");
  });

  it("позиция без цены не притворяется нулём", () => {
    const без = машина({
      summary: {
        items: [{ product: "Qurt", lossUnits: 6, lossValue: 0, surplusUnits: 0, daysCounted: 9, noPrice: true, alert: false }],
        lossValue: 0,
        daysCounted: 9,
        daysSkipped: 0,
        threshold: 30_000,
      },
      refillDays: [],
    });
    const [первое] = formatShrinkage(отчёт({ machines: [без] }));
    assert.match(первое, /Qurt −6 шт \(цены нет\)/);
    assert.ok(!/Итого/.test(первое), "итога в деньгах нет — считать нечего");
  });

  it("излишки видны, но в сумму не входят (R-P4-3)", () => {
    const излишек = машина({
      summary: {
        items: [
          { product: "Kinder Bueno", lossUnits: 9, lossValue: 99_000, surplusUnits: 0, daysCounted: 9, noPrice: false, alert: true },
          { product: "Fanta", lossUnits: 0, lossValue: 0, surplusUnits: 3, daysCounted: 9, noPrice: false, alert: false },
        ],
        lossValue: 99_000,
        daysCounted: 9,
        daysSkipped: 0,
        threshold: 30_000,
      },
      refillDays: [],
    });
    const [первое] = formatShrinkage(отчёт({ machines: [излишек] }));
    assert.match(первое, /излишки: Fanta \+3/);
    assert.match(первое, /Итого ≈ 99\s000 сум/, "излишек сумму не уменьшает");
  });

  it("предупреждения — в конце и без повторов", () => {
    const parts = formatShrinkage(
      отчёт({
        warnings: [
          { code: "snapshots_stale", message: "Olma: снимков нет больше 6 ч" },
          { code: "snapshots_stale", message: "Olma: снимков нет больше 6 ч" },
          { code: "no_sales_day", message: "13.08: продаж нет" },
        ],
      }),
    );
    const хвост = parts[parts.length - 1];
    assert.match(хвост, /Olma: снимков нет больше 6 ч/);
    assert.match(хвост, /13\.08: продаж нет/);
    assert.equal(хвост.match(/снимков нет больше 6 ч/g)?.length, 1, "одно и то же — один раз");
  });

  it("пустой отчёт говорит об этом словами, а не пустым сообщением", () => {
    const parts = formatShrinkage(отчёт({ machines: [] }));
    assert.equal(parts.length, 1);
    assert.match(parts[0], /ни одного автомата/i);
  });

  /** Парк из `n` автоматов по 8 позиций с длинными именами. */
  const парк = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      машина({
        name: `Автомат ${i} с очень длинным названием торгового центра`,
        summary: {
          items: Array.from({ length: 8 }, (_, k) => ({
            product: `Товар с длинным именем ${i}-${k}`,
            lossUnits: 9,
            lossValue: 99_000,
            surplusUnits: 0,
            daysCounted: 9,
            noPrice: false,
            alert: true,
          })),
          lossValue: 164_600,
          daysCounted: 9,
          daysSkipped: 5,
          threshold: 30_000,
        },
      }),
    );

  it("парк целиком не пробивает лимит одного сообщения", () => {
    // Вход, на котором Telegram отвечал бы 400 на каждое сообщение, а владелец
    // не получил бы отчёт вовсе.
    const parts = formatShrinkage(отчёт({ machines: парк(40) }));
    assert.ok(parts.length <= MAX_PARTS, `частей ${parts.length}`);
    for (const p of parts) assert.ok(p.length <= TG_BUDGET, `часть длиной ${p.length}`);
  });

  it("отчёт длиннее лимита частей обрезается вслух, а не молча", () => {
    const parts = formatShrinkage(отчёт({ machines: парк(150) }));
    assert.equal(parts.length, MAX_PARTS);
    for (const p of parts) assert.ok(p.length <= TG_BUDGET, `часть длиной ${p.length}`);
    assert.match(parts[parts.length - 1], /панели/, "обрезка названа вслух");
  });
});
