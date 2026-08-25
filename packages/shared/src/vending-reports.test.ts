import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deadStock, isoWeekTashkent, isoWeekFromKey, marginByMachine, previousIsoWeek,
  priceChanges, priceGap, retailDaily, weekCompare, weightedCost,
  type SaleRow, type StockPosition,
} from "./vending-reports";

const OLMA = "2508160376", AH = "2508160359", SKLAD = "2508160360";
const парк = new Map([[OLMA, "Olma Администрация"], [AH, "American Hospital"]]);
const цены = new Map([["Lays Сметана-лук 50gr", 13000], ["Moxito Lime 330ml", 9800], ["Kinder Bueno 43gr", 8000]]);
const cost = (p: string) => цены.get(p) ?? null;
const s = (serial: string, product: string, qty: number, amount: number, dt = "2026-08-20"): SaleRow => ({ dt, serial, product, qty, amount });

describe("Маржа по проданному (R-P5b-1, R-P5b-3)", () => {
  const r = marginByMachine([
    s(OLMA, "Lays Сметана-лук 50gr", 3, 45_000), s(OLMA, "Moxito Lime 330ml", 2, 24_000),
    s(AH, "Kinder Bueno 43gr", 1, 11_000), s(AH, "Новинка без цены", 4, 40_000),
    s(SKLAD, "Moxito Lime 330ml", 1, 12_000, "2026-07-09"), // склад «продал» — прод §7.4
  ], cost, { days: 30, from: "2026-07-27", to: "2026-08-25", inService: парк });

  it("автомат не в строю выброшен из денег и назван отдельно", () => {
    assert.deepEqual(r.excluded, [{ serial: SKLAD, qty: 1, amount: 12_000 }]);
    assert.equal(r.machines.length, 2);
  });
  it("маржа автомата = выручка − Σ(qty×cost), процент до 0.1", () => {
    const olma = r.machines.find((m) => m.serial === OLMA)!;
    assert.equal(olma.name, "Olma Администрация");
    assert.deepEqual([olma.qty, olma.revenue, olma.cogs, olma.margin, olma.pct], [5, 69_000, 58_600, 10_400, 15.1]);
  });
  it("без себестоимости: выручка есть, cogs нет, штуки и имя названы", () => {
    const ah = r.machines.find((m) => m.serial === AH)!;
    assert.deepEqual([ah.unknownUnits, ah.cogs], [4, 8_000]);
    assert.deepEqual([r.unknownProducts, r.totals.unknownUnits], [["Новинка без цены"], 4]);
    // Главное в R-P5b-2: 40 000 без цены закупа ОСТАЮТСЯ выручкой. Выброси их —
    // и сюита без этих двух строк осталась бы зелёной, а деньги бы пропали.
    assert.equal(ah.revenue, 51_000);
    assert.equal(r.totals.revenue, 120_000);
  });
  it("низкая и отрицательная маржа помечены; нет продаж — не выдуманный процент", () => {
    const lays = r.products.find((p) => p.product === "Lays Сметана-лук 50gr")!;
    assert.deepEqual([lays.pct, lays.low], [13.3, true]);                                    // 13.3 < 15
    assert.equal(r.products.find((p) => p.product === "Moxito Lime 330ml")!.low, false);      // 18.3
    assert.equal(marginByMachine([s(OLMA, "Lays Сметана-лук 50gr", 1, 12_000)], cost, { days: 1, from: "a", to: "b", inService: парк }).products[0]!.low, true);
    const пусто = marginByMachine([], cost, { days: 30, from: "a", to: "b", inService: парк });
    assert.deepEqual([пусто.machines.length, пусто.totals.pct, пусто.totals.revenue], [0, null, 0]);
  });
});

describe("Канон имени товара (R-P5b-2)", () => {
  it("два написания одного товара — одна строка, одна себестоимость, ноль «без цены»", () => {
    const r = marginByMachine([
      s(OLMA, "Moxito Lime 330ml", 2, 24_000),
      s(AH, "MOXITO LIME 330ML", 3, 36_000), // тот же товар, другое написание
    ], cost, { days: 30, from: "a", to: "b", inService: парк });
    assert.equal(r.products.length, 1);
    assert.deepEqual([r.products[0]!.product, r.products[0]!.qty, r.products[0]!.cogs], ["Moxito Lime 330ml", 5, 49_000]);
    assert.deepEqual([r.totals.unknownUnits, r.unknownProducts], [0, []]);
    // и в самом автомате написание тоже одно — витрина не двоится
    assert.equal(r.machines.find((m) => m.serial === AH)!.products[0]!.product, "Moxito Lime 330ml");
  });
});

describe("Боевые числа прода (inventory-prod.md §1, §9)", () => {
  // Агрегат по автомату прямо из таблицы §1: штуки и выручка — как в проде,
  // себестоимость единицы = закуп автомата / его штуки.
  const закуп = new Map([
    ["Olma · 31 SKU (агрегат §1)", 4_260_615 / 668],
    ["American Hospital · 34 SKU (агрегат §1)", 2_240_264 / 379],
  ]);
  const r = marginByMachine([
    s(OLMA, "Olma · 31 SKU (агрегат §1)", 668, 5_882_000),
    s(AH, "American Hospital · 34 SKU (агрегат §1)", 379, 3_092_000),
  ], (p) => закуп.get(p) ?? null, { days: 30, from: "2026-07-27", to: "2026-08-25", inService: парк });

  it("маржа 2 473 121 (27.6 %) — то же число, что владелец увидит первым прогоном", () => {
    assert.deepEqual([r.totals.qty, r.totals.revenue, r.totals.cogs, r.totals.margin, r.totals.pct],
      [1047, 8_974_000, 6_500_879, 2_473_121, 27.6]);
    assert.deepEqual([r.totals.unknownUnits, r.machines.some((m) => m.low)], [0, false]);
  });
  it("порядок: автоматы и товары по марже убыв. — Olma 1 621 385 (27.6 %), AH 851 736 (27.5 %)", () => {
    assert.deepEqual(r.machines.map((m) => [m.serial, m.margin, m.pct]), [
      [OLMA, 1_621_385, 27.6], [AH, 851_736, 27.5],
    ]);
    assert.deepEqual(r.products.map((x) => x.margin), [1_621_385, 851_736]);
  });
});

describe("Мёртвый сток 21 день (R-P5b-4)", () => {
  const цена = new Map([["Kinder Bueno 43gr", 11_000], ["Cheers Сметана-зелень 70gr", 8_000], ["TUC Sour cream", 13_500]]);
  const c = (p: string) => цена.get(p) ?? null;
  const поз = (product: string, qty: number, serial: string) => ({ product, qty, serial, machineName: парк.get(serial)! });
  const автоматы = [
    поз("Kinder Bueno 43gr", 11, AH), поз("Kinder Bueno 43gr", 2, OLMA),
    поз("Cheers Сметана-зелень 70gr", 5, AH), поз("Cheers Сметана-зелень 70gr", 5, OLMA),
    поз("TUC Sour cream", 5, OLMA), поз("Moxito Lime 330ml", 9, OLMA),
  ];
  const r = deadStock([{ product: "Montella 330ml", qty: 24 }, { product: "Без цены", qty: 3 }], автоматы,
    new Set([`${OLMA}|moxito lime 330ml`, "montella 330ml"]), c, 21, "2026-08-04");

  it("боевые числа: 5 строк, 28 шт, 290 500 сум", () => {
    assert.equal(r.machines.length, 5);
    assert.equal(r.machines.reduce((a, x) => a + x.qty, 0), 28);
    assert.equal(r.totalValue, 290_500);
  });
  it("флаг по паре (автомат, товар): продаётся в одном — мёртв в другом", () => {
    const r2 = deadStock([], автоматы, new Set([`${AH}|kinder bueno 43gr`]), c, 21, "2026-08-04");
    assert.deepEqual(r2.machines.filter((x) => x.product === "Kinder Bueno 43gr").map((x) => x.serial), [OLMA]);
  });
  it("склад: движение глобально по товару; без цены — не «ноль сум»", () => {
    assert.deepEqual(r.warehouse.map((x) => [x.product, x.value, x.noPrice]), [["Без цены", 0, true]]);
    assert.equal(r.noPriceCount, 1);
  });
  it("порядок: по оценке убыв. — сводка берёт «топ-5» первыми строками", () => {
    assert.deepEqual(r.machines.map((x) => x.value), [121_000, 67_500, 40_000, 40_000, 22_000]);
  });
  it("поля выборки БД в отчёт не утекают: строка собирается явно", () => {
    const изБД = {
      product: "TUC Sour cream", qty: 5, serial: OLMA, machineName: "Olma Администрация",
      productId: 7, countedAt: "2026-08-01T03:00:00Z",
    } as StockPosition;
    const r3 = deadStock([], [изБД], new Set<string>(), c, 21, "2026-08-04");
    assert.deepEqual(Object.keys(r3.machines[0]!).sort(),
      ["machineName", "noPrice", "product", "qty", "serial", "value"]);
  });
});

describe("Изменения цен >5 % (R-P5b-5)", () => {
  const продажи: SaleRow[] = [
    s(OLMA, "LaimonFresh Lime 330ml", 2, 30_000, "2026-07-07"), s(AH, "LaimonFresh Lime 330ml", 1, 15_000, "2026-07-07"),
    s(OLMA, "LaimonFresh Lime 330ml", 3, 36_000, "2026-07-08"),
    s(OLMA, "Moxito Lime 330ml", 2, 24_000, "2026-07-07"), s(OLMA, "Moxito Lime 330ml", 2, 24_400, "2026-07-08"), // +1.7 %
  ];
  it("цена дня = round(Σamount/Σqty) по обоим автоматам", () => {
    assert.deepEqual(retailDaily(продажи).filter((x) => x.product === "LaimonFresh Lime 330ml"), [
      { product: "LaimonFresh Lime 330ml", dt: "2026-07-07", price: 15_000 },
      { product: "LaimonFresh Lime 330ml", dt: "2026-07-08", price: 12_000 },
    ]);
  });
  it("ровно одна находка витрины: LaimonFresh 15000→12000 (−20.0 %)", () => {
    assert.deepEqual(priceChanges([], retailDaily(продажи), 5, 30).retail,
      [{ product: "LaimonFresh Lime 330ml", from: 15_000, to: 12_000, pct: -20, at: "2026-07-08" }]);
  });
  it("дробное деление: 3 шт на 25 000 → 8 333 (спека §5)", () => {
    assert.deepEqual(retailDaily([s(OLMA, "Cheers Сметана-зелень 70gr", 3, 25_000, "2026-07-07")]),
      [{ product: "Cheers Сметана-зелень 70gr", dt: "2026-07-07", price: 8_333 }]);
  });
  it("порядок: свежие изменения сверху", () => {
    const r = priceChanges([
      { product: "Раньше", oldPrice: 10_000, newPrice: 12_000, at: "2026-08-10" },
      { product: "Позже", oldPrice: 10_000, newPrice: 12_000, at: "2026-08-12" },
    ], [], 5, 30);
    assert.deepEqual(r.purchase.map((x) => x.product), ["Позже", "Раньше"]);
  });
  it("закупочные — из событий; нулевая прошлая цена не даёт +1269 %", () => {
    const r = priceChanges([
      { product: "Montella 330ml", oldPrice: 20_000, newPrice: 22_000, at: "2026-08-10" },
      { product: "Недостача (Рустам)", oldPrice: 0, newPrice: 81_080, at: "2026-08-11" },
      { product: "Velona", oldPrice: 13_000, newPrice: 12_900, at: "2026-08-12" }, // −0.8 %
    ], [], 5, 30);
    assert.deepEqual(r.purchase.map((x) => [x.product, x.pct]), [["Montella 330ml", 10]]);
  });
});

describe("Витрина против эталона (R-P5b-6)", () => {
  const r = priceGap([
    { product: "LaimonFresh Lime 330ml", qty: 20, amount: 240_000 }, // факт 12 000
    { product: "Moxito Lime 330ml", qty: 5, amount: 60_000 },        // факт 12 000
    { product: "TUC Sour cream", qty: 4, amount: 60_000 },           // эталона нет
  ], new Map([["LaimonFresh Lime 330ml", 15_000], ["Moxito Lime 330ml", 11_000]]), 5, 14);
  it("недобор — только по положительным разрывам; без эталона — отдельный список", () => {
    assert.deepEqual(r.rows.map((x) => [x.product, x.gap, x.gapPct, x.lost, x.action]), [
      ["LaimonFresh Lime 330ml", 3_000, 20, 60_000, "raise"],
      ["Moxito Lime 330ml", -1_000, -9.1, -5_000, "check"],
    ]);
    assert.deepEqual([r.lostTotal, r.noReference], [60_000, ["TUC Sour cream"]]);
  });
  it("эталон из numeric(12,2): в отчёте все деньги целые, без копеечного хвоста", () => {
    const k = priceGap([{ product: "X", qty: 2, amount: 25_000 }], new Map([["X", 15_000.55]]), 5, 14);
    assert.deepEqual([k.rows[0]!.reference, k.rows[0]!.fact, k.rows[0]!.gap, k.rows[0]!.lost, k.lostTotal],
      [15_001, 12_500, 2_501, 5_002, 5_002]);
  });
});

describe("Недели по Ташкенту и себестоимость окна (R-P5b-7, R-P5b-2)", () => {
  it("ключ IYYY-IW, границы пн–вс, ташкентская граница суток, 53-я неделя", () => {
    assert.deepEqual(isoWeekTashkent(new Date("2026-08-25T02:00:00Z")), { key: "2026-35", year: 2026, week: 35, from: "2026-08-24", to: "2026-08-30" });
    assert.equal(isoWeekTashkent(new Date("2026-08-23T19:00:00Z")).key, "2026-35"); // уже 24.08 в Ташкенте
    assert.equal(isoWeekTashkent(new Date("2026-08-23T18:00:00Z")).key, "2026-34");
    assert.equal(isoWeekTashkent(new Date("2027-01-02T20:00:00Z")).key, "2026-53");
    assert.equal(isoWeekFromKey("2026-34")!.from, "2026-08-17");
    assert.equal(previousIsoWeek(isoWeekFromKey("2026-35")!).key, "2026-34");
    assert.equal(isoWeekFromKey("мусор"), null);
  });
  it("сравнение недель по проду: 2026-34 против 2026-33", () => {
    assert.deepEqual(weekCompare({ qty: 248, revenue: 2_157_000, margin: 607_595 }, { qty: 285, revenue: 2_600_000, margin: 683_730 }),
      { qty: -37, revenue: -443_000, margin: -76_135, qtyPct: -13, revenuePct: -17, marginPct: -11.1 });
    assert.equal(weekCompare({ qty: 1, revenue: 1, margin: 1 }, { qty: 0, revenue: 0, margin: 0 }).revenuePct, null);
    // «-0 сум» в JSON отчёта — не число, а дефект округления
    assert.equal(Object.is(weekCompare({ qty: 0, revenue: 0.4, margin: 0 }, { qty: 0, revenue: 0.8, margin: 0 }).revenue, -0), false);
  });
  it("взвешенная себестоимость: Σ(price×qty)/Σqty; пусто → null (не ноль)", () => {
    assert.equal(weightedCost([{ price: 10_000, qty: 3 }, { price: 12_000, qty: 1 }]), 10_500);
    assert.equal(weightedCost([]), null);
    assert.equal(weightedCost([{ price: 0, qty: 5 }]), null);
  });
});
