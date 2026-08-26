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
import type { AnalyticsWarning, BootstrapSalePriceResult, OurvendHealth, ParityStreak } from "./core-client";
import {
  BOOTSTRAP_DAYS_MAX,
  MARGIN_DAYS_DEFAULT,
  MARGIN_DAYS_MAX,
  PCT,
  SALE_PRICE_HINT,
  окно,
  паритетСтрока,
  состояниеСбора,
  строкаЗастоя,
  строкаКрасногоДня,
  строкаСерии,
  строкаСнапшота,
  capped,
  сущ,
  товарСтрока,
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
import { MAX_PARTS, RU, TG_BUDGET } from "./purchase-plan";

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
  // Сбор стоит уже двое суток (R-P8a-6) — независимый сигнал от свежести
  // снимков ниже: даже если бы слоты приезжали, коллектор всё равно не бежит.
  staleHours: 48,
  staleThresholdH: 6,
  // Снимков слотов нет вовсе — это НЕ «свежо», и текст обязан отличать одно от другого.
  slotsLagMin: null,
  salesLagH: 5,
  // 5 ч — не застой снапшота (порог `SNAPSHOT_STALE_HOURS` много больше):
  // авария этой фикстуры — молчащий коллектор, а не вставший учёт (R-P8b-5).
  snapshotStale: false,
  productSaleLagH: 5,
  // Расхождения есть — ни одного зелёного дня подряд (R-P8b-2).
  parityStreak: 0,
  cutoverThreshold: 7,
  // Заметка — в той же форме, что её собирает Core: половина остатков
  // подписана префиксом «остатки:» (`ourvend-parity.service.ts`).
  parity: {
    days: 7,
    ok: false,
    mismatches: 3,
    stockOk: false,
    checked: 0, stockChecked: 0,
    // До катовера сверка идёт с зеркалом донора (R-FW-P3).
    mode: "mirror",
    note: "остатки: снимков остатков OurVend за период нет — сверять не по чему",
  },
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
    assert.match(первое!, /Olma Администрация: выручка 5 882 000 сум, маржа 1 621 385 сум \(27\.6 %\)/);
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
    assert.match(t, /TUC: 10 000 → 12 000 сум \(\+20 %\)/);
    assert.match(t, /LaimonFresh: 15 000 → 12 000 сум \(−20 %\)/);
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

    // S8/S9: цена не прошла проверку Core — печатаем ЕГО причину, а не свою
    // догадку. «Товар не найден» на живой товар с кривой ценой отправил бы
    // владельца искать несуществующую проблему в прайсе.
    const кривая = formatSalePriceResult({
      ok: false,
      product: "TUC",
      reason: "invalid_price",
      message: "цена должна быть больше нуля",
    });
    assert.match(кривая, /цена должна быть больше нуля/);
    assert.doesNotMatch(кривая, /не найден/);
  });

  it("бутстрап витрины: что проставили и что пропустили — с причинами", () => {
    const t = formatSalePriceBootstrap(БУТСТРАП).join("\n");
    assert.match(t, /TUC Sour cream — 15 000/);
    assert.match(t, /эталон уже задан 1/);
    assert.match(t, /нет продаж 1/);
  });

  it("бутстрап: пропущенные сходятся по арифметике — все четыре причины (S9)", () => {
    // «Пропущено 5: эталон уже задан 1, нет продаж 1» на пяти пропущенных —
    // это потерянные три товара: владелец считает, что эталон им проставлен,
    // и разрыв витрины по ним не всплывёт никогда.
    const t = formatSalePriceBootstrap({
      days: 14,
      set: [{ product: "TUC Sour cream", price: 15_000, qty: 42 }],
      skipped: [
        { product: "Moxito", reason: "already_set" },
        { product: "Flint", reason: "no_sales" },
        { product: "Barni", reason: "no_fact" },
        { product: "Velona", reason: "inactive" },
        { product: "Oreo", reason: "inactive" },
      ],
    }).join("\n");
    assert.match(t, /Пропущено 5/);
    assert.match(t, /эталон уже задан 1/);
    assert.match(t, /нет продаж 1/);
    assert.match(t, /снят с продажи 2/);
    // Причина `no_fact` названа своими словами: «продан даром» чинится в
    // прайсе, а не в сборе продаж.
    assert.match(t, /без цены 1|цены из них нет 1/);
  });

  it("бутстрап без единой проставленной цены тоже называет все причины", () => {
    const t = formatSalePriceBootstrap({
      days: 14,
      set: [],
      skipped: [
        { product: "Moxito", reason: "already_set" },
        { product: "Velona", reason: "inactive" },
      ],
    }).join("\n");
    assert.match(t, /эталон уже задан 1/);
    assert.match(t, /снят с продажи 1/);
  });

  it("здоровье сбора: серия отказов кричит, лаг null — «снимков нет»", () => {
    const t = formatOurvendHealth(ЗДОРОВЬЕ).join("\n");
    assert.match(t, /12 отказов подряд/);
    assert.match(t, /снимков нет/);
    assert.match(t, /Паритет/);
  });

  it("деньги везде с «сум», процента нет — голое тире (U1–U3, U13)", () => {
    // Владелец читает с телефона: «маржа 250 000» без единицы — это штуки,
    // деньги или проценты? Панель для тех же чисел всегда пишет «сум».
    const маржа = formatMargin(МАРЖА_ПРОД).join("\n");
    assert.match(маржа, /Итого: выручка 5 882 000 сум, маржа 1 621 385 сум/);
    const витрина = formatPriceGap(ВИТРИНА).join("\n");
    assert.match(витрина, /факт [\d\s]+ сум · эталон [\d\s]+ сум/);
    assert.match(витрина, /недобор ≈ [\d\s]+ сум/);
    const сток = formatDeadStock(МЁРТВЫЙ_ПРОД).join("\n");
    assert.match(сток, /≈ [\d\s]+ сум/);
    // «— %» читается как «ноль процентов с опечаткой»; панель пишет «—».
    assert.equal(PCT(null), "—");
    assert.equal(PCT(27.6), "27.6 %");
  });

  it("свежесть: витрина названа по-людски и протухший снимок помечен (U5, U10)", () => {
    // «product_sale» — имя таблицы, владелец его не знает; лаг больше 6 ч
    // панель красит красным, а бот молчал — тревога зависела от того, куда
    // смотришь.
    const t = formatOurvendHealth({ ...ЗДОРОВЬЕ, salesLagH: 13 }).join("\n");
    assert.doesNotMatch(t, /product_sale/);
    assert.match(t, /продажи по товарам \(кабинет\)/);
    // 13 ч — больше двух пропущенных прогонов (сбор ходит раз в 3 ч).
    assert.match(t, /продажи — 13 ч ⚠️/);
    // 5 ч — в норме, лишней тревоги нет.
    assert.match(t, /продажи по товарам \(кабинет\) — 5 ч(?! ⚠️)/);
  });

  it("«сверка» и справка называют раздел одинаково (U15)", () => {
    assert.match(formatOurvendHealth(ЗДОРОВЬЕ)[0]!, /Здоровье сбора/);
  });

  it("отказы в окне не прячутся за зелёным заголовком (прод, п.5)", () => {
    // 25.08 на проде: 12 отказов подряд, потом один успех — `failedStreak: 0`
    // и «✅ Отказов подряд нет» над журналом, где 12 из 20 прогонов упали.
    // Сбор при этом СВЕЖИЙ (не застой) — иначе сработал бы отдельный гейт N2,
    // и это уже другой тест ниже.
    const свежийУспех: OurvendHealth = {
      ...ЗДОРОВЬЕ,
      failedStreak: 0,
      lastSuccessAt: "2026-08-25T16:00:11Z",
      staleHours: 3,
      staleThresholdH: 6,
    };
    const t = состояниеСбора(свежийУспех);
    assert.match(t, /2 отказа/);
    assert.doesNotMatch(t, /^✅ Отказов подряд нет$/);
  });

  it("паритет: «расхождений 0» при пустых снимках — это причина, а не вердикт (прод, п.3)", () => {
    // Прод 25.08: продажи сходятся 1-в-1, а снимков остатков за закрытые сутки
    // нет вовсе. Старая строка печатала «❌ расхождений 0 · остатки ❌» —
    // отчёт, противоречащий сам себе на первом же прогоне.
    const t = паритетСтрока({
      days: 7,
      ok: false,
      mismatches: 0,
      stockOk: false,
      checked: 14, stockChecked: 0,
      mode: "mirror",
      note: "остатки: снимков остатков OurVend за период нет — сверять не по чему",
    });
    assert.match(t, /продажи ✅/);
    assert.doesNotMatch(t, /расхождений 0/);
    assert.match(t, /сверять не по чему/);
    // Причина сказана ОДИН раз: хвост-заметка не повторяет её слово в слово.
    assert.equal(t.match(/сверять не по чему/g)?.length, 1);
  });

  it("паритет: настоящее расхождение остаётся красным", () => {
    const t = паритетСтрока({ days: 7, ok: false, mismatches: 3, stockOk: true, checked: 14, stockChecked: 14, mode: "mirror", note: null });
    assert.match(t, /продажи ❌ расхождений 3/);
    assert.match(t, /остатки ✅/);
  });

  it("урезанное окно объясняется, а не срабатывает молча («маржа 91»)", () => {
    assert.deepEqual(окно("маржа за 91 дней", MARGIN_DAYS_DEFAULT, MARGIN_DAYS_MAX), {
      days: 90,
      note: "Максимум 90 дн. — показываю за 90.",
    });
    assert.deepEqual(окно("маржа за 7 дней", MARGIN_DAYS_DEFAULT, MARGIN_DAYS_MAX), { days: 7, note: null });
    assert.deepEqual(окно("маржа", MARGIN_DAYS_DEFAULT, MARGIN_DAYS_MAX), { days: 30, note: null });
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

describe("«сверка»: застой сбора (R-P8a-6)", () => {
  const h = (over: Partial<OurvendHealth>): OurvendHealth => ({ ...ЗДОРОВЬЕ, ...over });

  it("за порогом — строка ⛔ с числом часов", () => {
    assert.match(строкаЗастоя(h({ staleHours: 9, staleThresholdH: 6 }))!, /⛔ сбор стоит 9 ч/);
  });

  it("ровно на пороге — уже тревога (≥, а не >)", () => {
    assert.ok(строкаЗастоя(h({ staleHours: 6, staleThresholdH: 6 })));
  });

  it("в норме — строки нет вовсе, а не «застоя нет»", () => {
    assert.equal(строкаЗастоя(h({ staleHours: 1.2, staleThresholdH: 6 })), null);
  });

  it("успехов не было — тревога, и сказано именно это", () => {
    assert.match(строкаЗастоя(h({ staleHours: null, lastSuccessAt: null }))!, /успешных прогонов не было/);
  });

  it("пустой журнал — «не измеряли», а не застой (финальное ревью, major-1)", () => {
    // `runs: []` — сбор ни разу не запускался, ИЛИ `health()` в Core упал и
    // сводка получила `ЗДОРОВЬЕ_НЕИЗВЕСТНО` со `staleHours: null` (та же
    // причина). Это «нечего мерить», а не «сто лет без успеха»: панель уже
    // гасит свой бейдж на `runs.length === 0`, бот обязан согласиться.
    assert.equal(строкаЗастоя(h({ runs: [], staleHours: null, lastSuccessAt: null })), null);
    const t = formatOurvendHealth(h({ runs: [], failedStreak: 0, staleHours: null, lastSuccessAt: null })).join("\n");
    assert.ok(!t.includes("сбор стоит"));
  });

  it("строка стоит в ответе «сверки» первой, до состояния сбора", () => {
    const [первое] = formatOurvendHealth(h({ staleHours: 9 }));
    assert.match(первое!, /⛔ сбор стоит 9 ч/);
  });

  it("F1: failedStreak 0 + застой — «✅ Отказов подряд нет» не печатается", () => {
    // Крон вообще перестал ЗАПУСКАТЬСЯ (не падает — молчит): последний
    // ЗАПИСАННЫЙ прогон был успешным, `failedStreak` навсегда 0, а
    // `staleHours` растёт. Зелёная галка рядом с «⛔ сбор стоит» — ровно та
    // «нули как всё хорошо», против которой уже есть защита для отказов в
    // окне (см. тест «отказы в окне не прячутся»), но не было для застоя.
    const успешныеПрогоны: OurvendHealth["runs"] = [
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
    ];
    const молчащийКрон = h({ runs: успешныеПрогоны, failedStreak: 0, staleHours: 9, staleThresholdH: 6 });
    assert.doesNotMatch(состояниеСбора(молчащийКрон), /^✅ Отказов подряд нет$/);
    const t = formatOurvendHealth(молчащийКрон).join("\n");
    assert.match(t, /⛔ сбор стоит 9 ч/);
    assert.ok(!t.includes("✅ Отказов подряд нет"), "рядом с ⛔ не должно быть противоречащей зелёной галки");
  });

  it("F1: failedStreak > 0 + застой — оба сигнала видны разом", () => {
    const t = formatOurvendHealth(h({ staleHours: 9, staleThresholdH: 6 })).join("\n");
    assert.match(t, /⛔ сбор стоит 9 ч/);
    assert.match(t, /❌ 12 отказов подряд/);
  });

  it("N2: failedStreak 0 + отказы в окне + застой — «✅ Сейчас собирается» не печатается (ре-ревью)", () => {
    // Та же авария 24.08, что и у F1, но с ОТКАЗАМИ В ОКНЕ, а не нулём:
    // ветка «✅ Сейчас собирается, но N отказов» раньше проверялась ВЫШЕ
    // гейта застоя и вставала рядом с «⛔ сбор стоит», хотя коллектор молчит.
    // `h()` наследует из ЗДОРОВЬЕ два отказа и один успех в `runs`.
    const молчащийКронСОтказами = h({ failedStreak: 0, staleHours: 9, staleThresholdH: 6 });
    const t = состояниеСбора(молчащийКронСОтказами);
    assert.doesNotMatch(t, /✅ Сейчас собирается/);
    assert.match(t, /сбор стоит \(см\. выше\)/);
    const строки = formatOurvendHealth(молчащийКронСОтказами).join("\n");
    assert.match(строки, /⛔ сбор стоит 9 ч/);
    assert.ok(!строки.includes("✅ Сейчас собирается"), "рядом с ⛔ не должно быть противоречащей зелёной галки");
  });

  it("N2: отказы в окне остаются видны ✅, если сбор свежий (гейт застоя не срабатывает зря)", () => {
    const t = состояниеСбора(h({ failedStreak: 0, staleHours: 3, staleThresholdH: 6 }));
    assert.match(t, /✅ Сейчас собирается, но 2 отказа/);
  });
});

describe("«сверка»: серия зелёных дней (R-P8b-2)", () => {
  const h = (over: Partial<OurvendHealth>): OurvendHealth => ({ ...ЗДОРОВЬЕ, ...over });
  it("серия печатается вместе с порогом, а не одним числом", () => {
    assert.match(строкаСерии(h({ parityStreak: 3, cutoverThreshold: 7 })), /3 зелёных дн\. подряд из 7/);
  });
  it("порог взят — сказано, что можно переключать", () => {
    assert.match(строкаСерии(h({ parityStreak: 7, cutoverThreshold: 7 })), /✅ можно переключать/);
  });
  it("один день серии — «1 зелёный дн.», а не «1 зелёных дн.»", () => {
    // День 1 КАЖДОЙ серии — самый частый момент, когда владелец читает эту
    // строку: она отвечает «сколько ещё ждать». Форма «зелёных» у 3 и 7 та
    // же, поэтому склонение видно только здесь.
    assert.match(строкаСерии(h({ parityStreak: 1, cutoverThreshold: 7 })), /1 зелёный дн\. подряд из 7/);
  });
  it("серии нет — так и написано, а не «0 зелёных»", () => {
    // Ноль в этой строке читается как «сегодня не сошлось», а на деле это
    // может быть «сверок ещё не было ни одной» — разные починки.
    assert.match(строкаСерии(h({ parityStreak: 0 })), /серии нет/);
  });
  it("строка серии стоит сразу под строкой паритета", () => {
    // `formatOurvendHealth` отдаёт ЧАСТИ телеграм-сообщения (`capped`/`chunk`),
    // а не строку на элемент массива: короткий отчёт — одна часть с
    // переносами внутри. Соседство строк проверяем по СТРОКАМ текста, а не по
    // индексам массива частей.
    const строки = formatOurvendHealth(h({ parityStreak: 3 })).join("\n").split("\n");
    const i = строки.findIndex((s) => /Паритет за/.test(s));
    assert.notEqual(i, -1);
    assert.match(строки[i + 1]!, /зелёных дн\. подряд/);
  });
});

describe("«сверка»: застой учётного снапшота (R-P8b-5)", () => {
  const h = (over: Partial<OurvendHealth>): OurvendHealth => ({ ...ЗДОРОВЬЕ, ...over });
  it("флаг поднят — строка ⛔ с давностью снимка, и давность НАЗВАНА половиной", () => {
    // Застой считается по обеим таблицам снапшота (R-FW-P2), а в ответе едет
    // возраст только продажной: без подписи «снимок продаж» свежие 0,3 ч при
    // вставших остатках читались бы как опечатка отчёта.
    const s = строкаСнапшота(h({ snapshotStale: true, salesLagH: 41 }))!;
    assert.match(s, /⛔ учётный снапшот.*41 ч/);
    assert.match(s, /снимок продаж — 41 ч/);
  });
  it("флаг снят — строки нет вовсе", () => {
    assert.equal(строкаСнапшота(h({ snapshotStale: false })), null);
  });
  it("снимков нет вовсе — так и сказано, а не «0 ч»", () => {
    // Ноль часов читается как «только что сняли», то есть ровно наоборот
    // (то же правило, что у лагов и `staleHours`).
    const s = строкаСнапшота(h({ snapshotStale: true, salesLagH: null }))!;
    assert.match(s, /⛔ учётный снапшот.*снимков продаж нет/);
    assert.ok(!s.includes("0 ч"), s);
  });
  it("строка идёт сразу за строкой застоя сбора: обе про «данные не едут»", () => {
    // См. комментарий выше: части телеграм-сообщения — не строки, сравниваем
    // соседние СТРОКИ уже собранного текста.
    const строки = formatOurvendHealth(h({ staleHours: 9, snapshotStale: true })).join("\n").split("\n");
    const i = строки.findIndex((s) => /⛔ сбор стоит 9 ч/.test(s));
    assert.notEqual(i, -1);
    assert.match(строки[i + 1]!, /⛔ учётный снапшот/);
  });
});

/** Паритет в заданном режиме сверки (R-FW-P3) поверх фикстуры здоровья. */
const сРежимом = (mode: OurvendHealth["parity"]["mode"]): OurvendHealth["parity"] => ({
  ...ЗДОРОВЬЕ.parity,
  mode,
});

const СЕРИЯ: ParityStreak = {
  greenDays: 3,
  threshold: 7,
  readyForCutover: false,
  days: [
    { date: "2026-08-26", ok: true, salesChecked: 14, stockChecked: 68, note: null },
    { date: "2026-08-25", ok: true, salesChecked: 14, stockChecked: 68, note: null },
    { date: "2026-08-24", ok: true, salesChecked: 14, stockChecked: 68, note: null },
  ],
  // Красный день ВНЕ окна показа (две недели) — ровно прод-случай: 25.08
  // держится в поле до конца октября, серия при этом идёт с 26-го.
  lastRed: "2026-08-06",
  since: "2026-08-24",
};

describe("«сверка»: последний красный день — факт, а не приговор серии (P4)", () => {
  const h = (over: Partial<OurvendHealth>): OurvendHealth => ({ ...ЗДОРОВЬЕ, ...over });

  it("красный день вне окна показа печатается датой, а не «серия сорвана»", () => {
    const s = строкаКрасногоДня(СЕРИЯ);
    assert.match(s, /последний красный день: 06\.08/);
    assert.ok(!/сорва|сброш|обнул/i.test(s), `серию рвать нечем: ${s}`);
  });

  it("красных дней не было — так и сказано, а не молчанием", () => {
    assert.equal(строкаКрасногоДня({ ...СЕРИЯ, lastRed: null }), "красных дней не было");
  });

  it("строка стоит под серией — она объясняет её длину", () => {
    const строки = formatOurvendHealth(h({ parityStreak: 3 }), СЕРИЯ).join("\n").split("\n");
    const i = строки.findIndex((s) => /зелёных дн\. подряд/.test(s));
    assert.notEqual(i, -1);
    assert.match(строки[i + 1]!, /последний красный день: 06\.08/);
  });

  it("серия не приехала (отказ роута) — отчёт печатается без строки, а не падает", () => {
    const t = formatOurvendHealth(h({ parityStreak: 3 })).join("\n");
    assert.match(t, /зелёных дн\. подряд/);
    assert.ok(!t.includes("последний красный день"), t);
  });
});

describe("«сверка»: зеркала больше нет — режим retired (R-FW-P3)", () => {
  const h = (over: Partial<OurvendHealth>): OurvendHealth => ({ ...ЗДОРОВЬЕ, ...over });

  it("сверка своего снапшота с донором (после флипа) печатается как обычная — половинами", () => {
    // `own-vs-donor` — это ЕСТЬ сверка: вторая сторона на месте, вердикт
    // осмыслен. Гасить половины можно только там, где сравнивать не с чем.
    const s = паритетСтрока(сРежимом("own-vs-donor"));
    assert.match(s, /продажи|остатки/);
    assert.ok(!s.includes("сравнивать больше не с чем"), s);
  });

  it("паритет говорит «сравнивать больше не с чем», а не «расхождений 3»", () => {
    const s = паритетСтрока(сРежимом("retired"));
    assert.match(s, /сверка с зеркалом завершена — сравнивать больше не с чем/);
    assert.ok(!/❌|✅|расхождени/.test(s), `ни красного, ни зелёного вердикта здесь быть не может: ${s}`);
  });

  it("серия не считается и переключать учёт больше не зовут", () => {
    // `parityStreak` в этом режиме приезжает нулём: серию Core не считает.
    // Прежний текст «серии нет» читался бы как «сегодня не сошлось».
    const s = строкаСерии(h({ parity: сРежимом("retired"), parityStreak: 0 }));
    assert.match(s, /зеркало погашено/);
    assert.ok(!s.includes("можно переключать"), s);
    assert.ok(!s.includes("серии нет"), s);
  });

  it("даже на взятом пороге зова к катоверу нет — катовер уже позади", () => {
    const s = строкаСерии(h({ parity: сРежимом("retired"), parityStreak: 7, cutoverThreshold: 7 }));
    assert.ok(!s.includes("можно переключать"), s);
  });

  it("старый красный день в отчёт не лезет: серии, которую он объяснял бы, нет", () => {
    const t = formatOurvendHealth(h({ parity: сРежимом("retired") }), СЕРИЯ).join("\n");
    assert.ok(!t.includes("последний красный день"), t);
  });
});

describe("Пустые состояния и предупреждения (ревью П5b, круг 1)", () => {
  it("здоровье без прогонов не рисует зелёную галку", () => {
    // `failedStreak: 0` при пустом журнале значит «сбор ни разу не
    // запускался», а не «отказов не было»: ✅ над «последний успех: не было»
    // — ровно те нули как «всё хорошо», против которых §7.
    const t = formatOurvendHealth({
      runs: [],
      failedStreak: 0,
      lastSuccessAt: null,
      // Ни одного успеха нет и в собственном поле сторожа — тот же факт, тем
      // же полем, что и `lastSuccessAt: null` выше.
      staleHours: null,
      staleThresholdH: 6,
      slotsLagMin: null,
      salesLagH: null,
      snapshotStale: false,
      productSaleLagH: null,
      parityStreak: 0,
      cutoverThreshold: 7,
      parity: { days: 7, ok: false, mismatches: 0, stockOk: false, checked: 0, stockChecked: 0, mode: "mirror", note: null },
    }).join("\n");
    assert.match(t, /Прогонов сбора за период нет — здоровье не оценить/);
    assert.ok(!t.includes("✅ Отказов подряд нет"));
    assert.ok(!t.includes("Прогоны (0)"));
    // Ревью финального прогона (major-1): пустой журнал — это «не измеряли»,
    // а не застой. Печатать «⛔ … успешных прогонов не было» о том, чего не
    // мерили, — то же враньё, что и зелёная галка на пустых нулях, только с
    // другим знаком.
    assert.ok(!t.includes("сбор стоит"));
  });

  it("лаг, которого нет в ответе Core, читается как «снимков нет»", () => {
    // Форма §6 спеки не обещает `productSaleLagH`. Строгое `=== null`
    // печатало бы «витрина (product_sale) — не число ч» — отчёт о свежести,
    // который сам себя не понял.
    const { productSaleLagH: _нет, ...без } = ЗДОРОВЬЕ;
    const t = formatOurvendHealth(без as OurvendHealth).join("\n");
    assert.match(t, /продажи по товарам \(кабинет\) — снимков нет/);
    assert.ok(!t.includes("не число"));
    assert.ok(!t.includes("undefined"));
  });

  it("склонение отказов: 1 отказ, 3 отказа, 12 отказов", () => {
    assert.equal(сущ(1, "отказ", "отказа", "отказов"), "отказ");
    assert.equal(сущ(3, "отказ", "отказа", "отказов"), "отказа");
    assert.equal(сущ(12, "отказ", "отказа", "отказов"), "отказов");
    const t = formatOurvendHealth({ ...ЗДОРОВЬЕ, failedStreak: 3 }).join("\n");
    assert.match(t, /3 отказа подряд/);
  });

  it("момент без запятой между датой и временем", () => {
    // В строке, где поля разделены «·», запятая читается как ещё один
    // разделитель.
    assert.match(formatOurvendHealth(ЗДОРОВЬЕ).join("\n"), /Последний успех: \d{2}\.\d{2} \d{2}:\d{2}\./);
  });

  it("товар без себестоимости не читается как 100 % маржи", () => {
    const строка = товарСтрока({
      product: "TUC Sour cream",
      qty: 4,
      revenue: 60_000,
      cogs: 0,
      margin: 60_000,
      pct: 100,
      unknownUnits: 4,
      low: false,
    });
    assert.match(строка, /без себестоимости 4 шт/);
    assert.match(formatMargin(МАРЖА_ПРОД).join("\n"), /TUC Sour cream:.*без себестоимости 4 шт/);
  });

  it("низкомаржинальные не печатаются дважды: топ и «ниже порога» не пересекаются", () => {
    const слабые = ТОВАРЫ_OLMA.map((p) => ({ ...p, low: true }));
    const t = formatMargin({ ...МАРЖА_ПРОД, products: слабые }).join("\n");
    // Короткий каталог (на проде в окне бывает и три позиции) давал два
    // одинаковых списка подряд под разными заголовками.
    assert.equal(t.match(/• Fanta:/g)?.length, 1);
    assert.ok(!t.includes("Ниже 15 %"), "весь список уже показан в топе");
  });

  it("отрицательные деньги — типографский минус, как «−9 шт» и «(−20 %)» рядом", () => {
    assert.equal(RU(-5_000), "−5 000");
    const убыток = ТОВАРЫ_OLMA.map((p) => ({ ...p, margin: -5_000, revenue: 10_000, cogs: 15_000, pct: -50 }));
    assert.match(formatMargin({ ...МАРЖА_ПРОД, products: убыток }).join("\n"), /маржа −5 000/);
  });

  it("«посчитано не всё» приходит хвостом и без повторов", () => {
    const warnings: AnalyticsWarning[] = [
      { code: "stock_missing", message: "Остатка на последний день окна нет: Olma (2508160376)." },
      { code: "stock_missing", message: "Остатка на последний день окна нет: Olma (2508160376)." },
      { code: "no_sales", message: "Продаж с 2026-08-04 нет — движение определять не по чему." },
    ];
    const t = formatDeadStock({ ...МЁРТВЫЙ_ПРОД, warnings }).join("\n");
    assert.match(t, /Посчитано не всё:/);
    assert.equal(t.match(/Остатка на последний день окна нет/g)?.length, 1);
    assert.match(t, /Продаж с 2026-08-04 нет/);
  });

  it("предупреждение, которое отчёт уже сказал своей строкой, не повторяется", () => {
    // Ради этого у предупреждений есть КОД, а не только текст: владелец не
    // должен читать одно и то же дважды — в теле отчёта и в хвосте.
    const t = formatDeadStock({
      ...МЁРТВЫЙ_ПРОД,
      warnings: [{ code: "unknown_cost", message: "Без закупочной цены 1 позиц." }],
    }).join("\n");
    assert.match(t, /цена закупки неизвестна/);
    assert.ok(!t.includes("Без закупочной цены 1 позиц."));
    assert.ok(!t.includes("Посчитано не всё"));
  });

  it("пустой мёртвый сток не утверждает «двигалось всё», когда продаж не было", () => {
    const t = formatDeadStock({
      days: 21,
      since: "2026-08-04",
      warehouse: [],
      machines: [],
      totalValue: 0,
      noPriceCount: 0,
      warnings: [{ code: "no_sales", message: "Продаж с 2026-08-04 нет — движение определять не по чему." }],
    }).join("\n");
    assert.match(t, /Продаж с 2026-08-04 нет/);
  });

  it("список разрыва витрины тоже имеет потолок", () => {
    const много = Array.from({ length: 80 }, (_, i) => ({
      product: `Товар ${i}`,
      fact: 12_000,
      reference: 15_000,
      gap: 3_000,
      gapPct: 20,
      qty: 20,
      lost: 60_000 - i,
      action: "raise" as const,
    }));
    const t = formatPriceGap({ ...ВИТРИНА, rows: много, lostTotal: 4_000_000 }).join("\n");
    assert.match(t, /…и ещё \d+ поз\. — весь список на листе «Цены» в панели\./);
  });

  it("сверх потолка частей отчёт говорит, сколько показал и где остальное", () => {
    // Ветка `capped` за пределом MAX_PARTS достижима только на входе, где
    // потолков разделов нет (недельная сводка, будущие отчёты): без теста она
    // тихо ломалась бы при первом же таком применении.
    const parts = capped("📋 Заголовок", Array.from({ length: 3000 }, (_, i) => `строка отчёта номер ${i}`), "Лист");
    assert.equal(parts.length, MAX_PARTS);
    assert.ok(parts.every((ч) => ч.length <= TG_BUDGET));
    assert.match(parts[parts.length - 1]!, /…показал 11 из \d+ частей — остальное на листе «Лист» в панели\./);
  });

  it("окно бутстрапа шире окна отчёта — потолок свой (DTO 180)", () => {
    assert.equal(BOOTSTRAP_DAYS_MAX, 180);
    assert.equal(parseDays("витрина как факт за 120 дней", 14, BOOTSTRAP_DAYS_MAX), 120);
  });
});
