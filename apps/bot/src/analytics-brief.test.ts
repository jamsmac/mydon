import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  DeadRow,
  DeadStockReport,
  MarginMachine,
  MarginProduct,
  MarginReport,
  PriceChangesReport,
  PriceGapReport,
} from "@mydon/shared";
import type { BootstrapSalePriceResult, OurvendHealth } from "./core-client";
import {
  SALE_PRICE_HINT,
  formatDeadStock,
  formatMargin,
  formatOurvendHealth,
  formatPriceChanges,
  formatPriceGap,
  formatSalePriceBootstrap,
  formatSalePriceResult,
  isDeadStockQuery,
  isMarginQuery,
  isOurvendCheckQuery,
  isPriceChangesQuery,
  isPriceGapQuery,
  isSalePriceBootstrapCommand,
  isSalePriceCommand,
  parseDays,
  parseSalePriceCommand,
} from "./analytics-brief";
import { isPriceCommand } from "./purchase-brief";
import { MAX_PARTS, TG_BUDGET } from "./purchase-plan";

// ── Фикстуры прода (25.08.2026): числа взяты из инвентаризации, а не выдуманы ──

const товар = (product: string, qty: number, revenue: number, cogs: number, unknownUnits = 0): MarginProduct => ({
  product,
  qty,
  revenue,
  cogs,
  margin: revenue - cogs,
  pct: revenue === 0 ? null : Math.round(((revenue - cogs) / revenue) * 1000) / 10,
  unknownUnits,
  low: false,
});

const ТОВАРЫ_OLMA: MarginProduct[] = [
  товар("Fanta", 421, 4_382_000, 3_260_615),
  товар("Kinder Bueno", 120, 1_440_000, 1_000_000),
  // Товар без себестоимости: выручка есть, cogs нет — маржа завышена ровно на
  // эти 60 000, и витрина обязана назвать штуки (R-P5b-2).
  товар("TUC Sour cream", 4, 60_000, 0, 4),
];

const OLMA: MarginMachine = {
  serial: "2508160376",
  name: "Olma Администрация",
  products: ТОВАРЫ_OLMA,
  qty: 545,
  revenue: 5_882_000,
  cogs: 4_260_615,
  margin: 1_621_385,
  pct: 27.6,
  unknownUnits: 4,
  low: false,
};

const МАРЖА_ПРОД: MarginReport = {
  days: 30,
  from: "2026-07-26",
  to: "2026-08-24",
  lowPct: 15,
  machines: [OLMA],
  products: ТОВАРЫ_OLMA,
  totals: { qty: 545, revenue: 5_882_000, cogs: 4_260_615, margin: 1_621_385, pct: 27.6, unknownUnits: 4 },
  unknownUnits: 4,
  unknownProducts: ["TUC Sour cream"],
  // Склад-заглушка «продал» 1 шт: строка выброшена из денег, но названа.
  excluded: [{ serial: "SKLAD4S", qty: 1, amount: 12_000 }],
};

const ПУСТАЯ_МАРЖА: MarginReport = {
  days: 30,
  from: "2026-07-26",
  to: "2026-08-24",
  lowPct: 15,
  machines: [],
  products: [],
  totals: { qty: 0, revenue: 0, cogs: 0, margin: 0, pct: null, unknownUnits: 0 },
  unknownUnits: 0,
  unknownProducts: [],
  excluded: [],
};

const мёртвая = (product: string, qty: number, value: number, extra: Partial<DeadRow> = {}): DeadRow => ({
  product,
  qty,
  value,
  noPrice: false,
  ...extra,
});

const МЁРТВЫЙ_ПРОД: DeadStockReport = {
  days: 21,
  since: "2026-08-04",
  warehouse: [мёртвая("Moxito", 24, 168_496), мёртвая("Fanta", 12, 62_004), мёртвая("Flint", 10, 40_000)],
  machines: [
    мёртвая("Snickers", 5, 20_000, { serial: "2508160376", machineName: "Olma Администрация" }),
    мёртвая("TUC Sour cream", 4, 0, { serial: "2508160376", machineName: "Olma Администрация", noPrice: true }),
  ],
  totalValue: 290_500,
  noPriceCount: 1,
};

/** Мёртвый сток размером с реальный склад: одно сообщение его не вмещает. */
const ОГРОМНЫЙ: DeadStockReport = {
  days: 21,
  since: "2026-08-04",
  warehouse: Array.from({ length: 1500 }, (_, i) => мёртвая(`Товар с длинным именем номер ${i}`, i + 1, (i + 1) * 1000)),
  machines: Array.from({ length: 500 }, (_, i) =>
    мёртвая(`Автоматный товар ${i}`, i + 1, (i + 1) * 500, { serial: "2508160376", machineName: "Olma Администрация" }),
  ),
  totalValue: 123_456_789,
  noPriceCount: 0,
};

const ВИТРИНА: PriceGapReport = {
  days: 14,
  pct: 5,
  rows: [
    { product: "TUC", fact: 12_000, reference: 15_000, gap: 3_000, gapPct: 20, qty: 20, lost: 60_000, action: "raise" },
    { product: "Fanta", fact: 16_000, reference: 15_000, gap: -1_000, gapPct: -6.7, qty: 5, lost: -5_000, action: "check" },
  ],
  noReference: ["TUC Sour cream"],
  lostTotal: 60_000,
};

const ЦЕНЫ: PriceChangesReport = {
  days: 30,
  pct: 5,
  purchase: [{ product: "TUC", from: 10_000, to: 12_000, pct: 20, at: "2026-08-18" }],
  retail: [{ product: "LaimonFresh", from: 15_000, to: 12_000, pct: -20, at: "2026-08-20" }],
};

const ЗДОРОВЬЕ: OurvendHealth = {
  runs: [
    {
      id: "r3",
      startedAt: "2026-08-25T03:00:00Z",
      finishedAt: "2026-08-25T03:00:10Z",
      status: "failed",
      machinesTotal: 2,
      machinesOk: 0,
      durationMs: 10_000,
      error: "приём слотов прерван по таймауту 10 с",
    },
    {
      id: "r2",
      startedAt: "2026-08-24T03:00:00Z",
      finishedAt: "2026-08-24T03:00:10Z",
      status: "failed",
      machinesTotal: 2,
      machinesOk: 0,
      durationMs: 10_000,
      error: "приём слотов прерван по таймауту 10 с",
    },
    {
      id: "r1",
      startedAt: "2026-08-23T03:00:00Z",
      finishedAt: "2026-08-23T03:02:00Z",
      status: "success",
      machinesTotal: 2,
      machinesOk: 2,
      durationMs: 120_000,
      error: null,
    },
  ],
  failedStreak: 12,
  lastSuccessAt: "2026-08-23T03:02:00Z",
  // Снимков слотов нет вовсе — это НЕ «свежо», и текст обязан отличать одно от другого.
  slotsLagMin: null,
  salesLagH: 5,
  productSaleLagH: 5,
  parity: { days: 7, ok: false, mismatches: 3, stockOk: false, note: "снимков остатков OurVend за период нет" },
};

const БУТСТРАП: BootstrapSalePriceResult = {
  days: 14,
  set: [
    { product: "TUC Sour cream", price: 15_000, qty: 42 },
    { product: "Fanta", price: 12_000, qty: 130 },
  ],
  skipped: [
    { product: "Moxito", reason: "already_set" },
    { product: "Flint", reason: "no_sales" },
  ],
};

describe("Разбор команд аналитики", () => {
  it("«цена продажи» не перехватывается закупочной «цена»", () => {
    assert.equal(isSalePriceCommand("цена продажи TUC Sour cream 15000"), true);
    assert.equal(isSalePriceCommand("цена TUC 12000"), false);
    assert.deepEqual(parseSalePriceCommand("цена продажи TUC Sour cream 15 000 точно"), {
      product: "TUC Sour cream",
      price: 15_000,
      confirmed: true,
    });
    assert.equal(parseSalePriceCommand("цена продажи TUC"), null);
    // Ловушка реальна: существующая закупочная «цена …» ловит и «цена продажи
    // …». Проверку эталона витрины обязано стоять СТРОГО раньше, иначе правка
    // уходит в закупочную цену — молча и в другую колонку.
    assert.equal(isPriceCommand("цена продажи TUC Sour cream 15000"), true);
  });

  it("«витрина как факт» не читается как отчёт «витрина»", () => {
    assert.equal(isSalePriceBootstrapCommand("витрина как факт"), true);
    assert.equal(isPriceGapQuery("витрина как факт"), false);
    assert.equal(isPriceGapQuery("витрина"), true);
  });

  it("остальные фразы узнаются и не пересекаются", () => {
    assert.equal(isMarginQuery("маржа за 7 дней"), true);
    assert.equal(isDeadStockQuery("мёртвый сток"), true);
    assert.equal(isDeadStockQuery("мертвый сток"), true);
    assert.equal(isPriceChangesQuery("цены"), true);
    // «цены» — отчёт, «цена X N» — правка: одна буква решает, читаем мы или пишем.
    assert.equal(isPriceChangesQuery("цена TUC 12000"), false);
    assert.equal(isPriceCommand("цены"), false);
    assert.equal(isOurvendCheckQuery("сверка"), true);
    assert.equal(isMarginQuery("маржинальность автоматов"), true);
    assert.equal(isMarginQuery("что там с маржой"), false);
  });

  it("окно из фразы зажимается ботом, а не отказом Core", () => {
    assert.equal(parseDays("маржа за 7 дней", 30, 90), 7);
    assert.equal(parseDays("маржа за 900 дней", 30, 90), 90);
    assert.equal(parseDays("маржа", 30, 90), 30);
    assert.equal(parseDays("маржа 7", 30, 90), 7);
    assert.equal(parseDays("маржа за 0 дней", 30, 90), 30);
  });

  it("подсказка формата называет и команду, и слово подтверждения", () => {
    assert.match(SALE_PRICE_HINT, /цена продажи/);
    assert.match(SALE_PRICE_HINT, /точно/);
  });
});

describe("Тексты отчётов", () => {
  it("маржа: автоматы по деньгам, штуки без себестоимости названы", () => {
    const [первое] = formatMargin(МАРЖА_ПРОД);
    assert.match(первое!, /Маржа снек-автоматов \(OurVend\) за 30 дн/);
    assert.match(первое!, /Olma Администрация: выручка 5 882 000, маржа 1 621 385 \(27\.6 %\)/);
    assert.match(первое!, /4 шт без себестоимости/);
    // Кофе в этом отчёте нет вовсе — ни данными, ни «нет данных» (R-P5b-9).
    assert.ok(!первое!.includes("кофе"));
  });

  it("маржа: строки не в строю названы, а не потеряны", () => {
    assert.match(formatMargin(МАРЖА_ПРОД).join("\n"), /SKLAD4S/);
  });

  it("нет продаж — так и сказано, а не нули как «всё хорошо»", () => {
    assert.match(formatMargin(ПУСТАЯ_МАРЖА)[0]!, /продаж за 30 дн\. нет/);
  });

  it("мёртвый сток: боевые 5 строк и 290 500 сум, без цены — подпись", () => {
    const t = formatDeadStock(МЁРТВЫЙ_ПРОД).join("\n");
    assert.match(t, /нет движения 21 дн\., 5 поз\., оценка ≈ 290 500/);
    assert.match(t, /цена закупки неизвестна/);
  });

  it("цены: две ленты и знак изменения", () => {
    const t = formatPriceChanges(ЦЕНЫ).join("\n");
    assert.match(t, /Цены снек-автоматов \(OurVend\) за 30 дн/);
    assert.match(t, /TUC: 10 000 → 12 000 \(\+20 %\)/);
    assert.match(t, /LaimonFresh: 15 000 → 12 000 \(−20 %\)/);
  });

  it("витрина: без эталона — отдельный список, недобор только положительный", () => {
    const t = formatPriceGap(ВИТРИНА).join("\n");
    assert.match(t, /Σ недобор.*60 000/);
    assert.match(t, /эталон не задан \(1\): TUC Sour cream/);
    // «Продаём дороже эталона» — повод перепроверить эталон, а не выручка,
    // которой можно закрыть недобор: в сумму она не входит.
    assert.match(t, /Fanta/);
    assert.ok(!/Σ недобор.*55 000/.test(t));
  });

  it("гейт цены продажи объясняет, чем отличается факт от эталона", () => {
    const t = formatSalePriceResult({
      ok: false,
      reason: "spike",
      product: "TUC",
      factPrice: 15_000,
      newPrice: 20_000,
      deviationPct: 33,
    });
    assert.match(t, /повтори со словом «точно»/);
    assert.match(t, /факт/i);
    assert.match(t, /15 000/);
  });

  it("успех записи эталона и «товар не найден» — разные ответы", () => {
    assert.match(
      formatSalePriceResult({ ok: true, product: "TUC", oldPrice: null, newPrice: 15_000 }),
      /не была задана/,
    );
    assert.match(formatSalePriceResult({ ok: false, reason: "not_found", product: "Абырвалг" }), /не найден/);
  });

  it("бутстрап витрины: что проставили и что пропустили — с причинами", () => {
    const t = formatSalePriceBootstrap(БУТСТРАП).join("\n");
    assert.match(t, /TUC Sour cream — 15 000/);
    assert.match(t, /эталон уже задан 1/);
    assert.match(t, /нет продаж 1/);
  });

  it("здоровье сбора: серия отказов кричит, лаг null — «снимков нет»", () => {
    const t = formatOurvendHealth(ЗДОРОВЬЕ).join("\n");
    assert.match(t, /12 отказов подряд/);
    assert.match(t, /снимков нет/);
    assert.match(t, /Паритет/);
  });

  it("длинный отчёт режется по бюджету и не теряет заголовок", () => {
    const parts = formatDeadStock(ОГРОМНЫЙ);
    assert.ok(parts.every((ч) => ч.length <= TG_BUDGET));
    assert.ok(parts.every((ч) => ч.length <= 3500));
    assert.ok(parts.length <= MAX_PARTS, `частей ${parts.length}`);
    assert.match(parts[0]!, /Мёртвый сток снек-автоматов \(OurVend\)/);
    // Итог посчитан по ВСЕМ позициям, а показаны дорогие: обрезанный список
    // обязан сказать, что он обрезан, и где лежит целиком. Молчаливый хвост
    // читается как «это всё», и владелец считает мёртвый сток по видимым
    // строкам.
    assert.match(parts.join("\n"), /нет движения 21 дн\., 2 000 поз\./);
    assert.match(parts[parts.length - 1]!, /…и ещё [\d ]+ поз\. — весь список на листе «Мёртвый сток» в панели\./);
  });
});
