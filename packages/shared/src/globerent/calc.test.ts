import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateCosts,
  calculateScenario,
  computeBreakevenSalePrice,
  computeBrokerCostUzs,
  computeCashFees,
  computeSalePriceForTargetNetProfit,
  generateAutoExpenseLines,
  round2,
  round4,
  roundSalePriceToNoVatStep,
  type EstimationInputs,
  type ExpenseCategory,
  type ExpenseLine,
} from "./calc";

/**
 * Golden-тесты движка калькулятора GLOBERENT.
 *
 * Контрольный пример донора PROMACH — Excel-лист владельца
 * «Седельный тягач (пневмо) SX4258NT384T»:
 *   COST_DDP_OFFICIAL = 1 064 342 780 UZS (Excel C8),
 *   NET_PROFIT_OFFICIAL = 36 564 637, NET_PROFIT_TOTAL = −6 946 117 → бонус 0.
 *
 * Движок держит копейки, Excel показывает целые UZS — поэтому фиксируем
 * ОБА уровня: точные копейки движка И целые «как в отчёте» (Math.round).
 * Второй кейс — фронтальный погрузчик HELI (ТН ВЭД 8429519900), посчитан
 * руками по тем же формулам и заморожен.
 */

/** P&L-ставки контрольных примеров (Блок 5 донора, дефолты). */
const PNL = {
  vat_sale_rate: 0.12,
  corporate_tax_rate: 0.15,
  admin_expenses_rate: 0.014,
  salesperson_bonus_rate: 0.08,
};

function inputs(over: Partial<EstimationInputs>): EstimationInputs {
  return {
    factory_price_usd: 0,
    transport_price_usd: 0,
    invoice_price_usd: 0,
    customs_base_usd: 0,
    rate_im40: 0,
    rate_im70: 0,
    rate_im74: 0,
    rate_conversion: 0,
    bank_conversion_markup: 1.003,
    brv_value_uzs: 412_000,
    duty_rate: 0,
    customs_fee_rate: 0.002,
    excise_rate: 0,
    vat_customs_rate: 0.12,
    util_brv_count: 0,
    engine_volume_cc: null,
    engine_duty_per_cc_usd: 0,
    ...PNL,
    premium_markup_pct: 0.1,
    certification_cost_uzs: 0,
    broker_cost_uzs: 0,
    customs_storage_cost_uzs: 0,
    certification_cash_uzs: 0,
    customs_cash_uzs: 0,
    broker_cash_uzs: 0,
    qty: 1,
    ...over,
  };
}

/** Ручная строка затрат — как её вводит ВЭД-менеджер в Блоке 5 донора. */
function manualLine(
  category: ExpenseCategory,
  circuit: "official" | "cash",
  amountUzs: number,
  over: Partial<ExpenseLine> = {},
): ExpenseLine {
  return {
    category,
    circuit,
    source: "manual_uzs",
    amount_uzs: amountUzs,
    applied_rate_type: "NONE",
    is_included_in_cost: true,
    is_creditable_vat: false,
    is_locked: false,
    scaling: "per_unit",
    ...over,
  };
}

/** Единственная строка категории — или падаем с внятным сообщением. */
function one(lines: ExpenseLine[], category: ExpenseCategory): ExpenseLine {
  const found = lines.filter((l) => l.category === category);
  assert.equal(found.length, 1, `ожидалась одна строка ${category}, найдено ${found.length}`);
  const line = found[0];
  assert.ok(line);
  return line;
}

// ════════════════════════════════════════════════════════════════════════════
// Контрольный пример: тягач SX4258NT384T (Excel «Седельный тягач (пневмо)»)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Входы из эталона (01-excel-ground-truth.md §2-3, 04-final-synthesis-spec §11):
 * завод $58 000, транспорт $1 500, инвойс $59 500 (= 1+2), база ГТД $59 500,
 * курсы ИМ40 = ИМ70 = ИМ74 = 12 074.28 (F1=F2=F3 во всех листах),
 * конвертация = ИМ74 × 1.003 (Excel F4), БРВ 412 000, пошлина 5%, НДС 12%,
 * сбор 0.2%, утиль 670 БРВ, доп.пошлины нет (тягач).
 *
 * Блок 4 — суммами Excel-листа: сертификация ОФИЦ 7 700 000 (C31 за вычетом
 * утиля: 283 740 000 − 276 040 000), хранение 123 459 (C26), сертификация НАЛ
 * 24 045 000 (строка 32), НАЛ-фиксы 650 000 + 650 000 (строки 34/36 — в Excel
 * хардкоды; авто-формула 50$ × конвертация появилась позже, Phase 15.24,
 * и тестируется отдельно). Брокер ОФИЦ в Excel-листе отсутствует → 0.
 */
const TRACTOR = inputs({
  factory_price_usd: 58_000,
  transport_price_usd: 1_500,
  invoice_price_usd: 59_500,
  customs_base_usd: 59_500,
  rate_im40: 12_074.28,
  rate_im70: 12_074.28,
  rate_im74: 12_074.28,
  rate_conversion: 12_074.28 * 1.003, // Excel F4 = F2 × 1.003
  duty_rate: 0.05,
  util_brv_count: 670,
  certification_cost_uzs: 7_700_000,
  customs_storage_cost_uzs: 123_459,
  certification_cash_uzs: 24_045_000,
  customs_cash_uzs: 650_000,
  broker_cash_uzs: 650_000,
});

/**
 * Ручные строки Excel-листа, которые движок не генерирует сам:
 * ЖД/ГАИ (C27), заполнение ГТД ИМ70 (C28) и ИМ40 (C30) — и доводка
 * таможенного сбора до Excel-хардкода C23 = 5 625 000.
 *
 * РАСХОЖДЕНИЕ донор-кода с Excel-листом: движок считает сбор формулой
 * 0.2% × две ГТД = 1 436 839.32 × 2 = 2 873 678.64, а в листе тягача сбор
 * вбит рукой (5 625 000 — «хардкод-загадка» из ground-truth §4). Разницу
 * 2 751 321.36 в рабочем потоке ВЭД-менеджер добавил бы manual-строкой —
 * так и делаем; код донора переносим без правок.
 */
const TRACTOR_MANUAL: ExpenseLine[] = [
  manualLine("gai_railway", "official", 650_363, { label: "Тамож. ЖД услуги (ГАИ)" }),
  manualLine("gtd_fill_im70", "official", 222_959, { label: "За заполнение ГТД ИМ70" }),
  manualLine("gtd_fill_im40", "official", 1_474_602, { label: "За заполнение ГТД ИМ40" }),
  manualLine("customs_fee", "official", 2_751_321.36, {
    label: "Тамож. сбор — доводка до Excel-хардкода C23 (5 625 000)",
  }),
];

describe("generateAutoExpenseLines — контрольный пример: тягач SX4258NT384T", () => {
  const lines = generateAutoExpenseLines(TRACTOR);

  it("покупка в Китае: инвойс × ИМ74 = 718 419 660 (ОФИЦ, в себестоимости)", () => {
    const l = one(lines, "purchase_china");
    assert.equal(l.amount_uzs, 718_419_660);
    assert.equal(l.circuit, "official");
    assert.equal(l.applied_rate_type, "IM74");
    assert.equal(l.is_included_in_cost, true);
    assert.equal(l.is_locked, true);
  });

  it("НАЛ-корректировка: factory × конв − invoice × ИМ74 = −16 010 495.28 (возврат)", () => {
    // 58 000 × 12 110.50284 − 59 500 × 12 074.28: ФАКТ дешевле ОФИЦ → доход налом.
    const l = one(lines, "factory_refund_cash");
    assert.equal(l.amount_uzs, -16_010_495.28);
    assert.equal(l.circuit, "cash");
    assert.equal(l.is_included_in_cost, true, "отрицательная сумма уменьшает НАЛ-себестоимость");
    assert.equal(l.amount_usd, -1_500);
  });

  it("транспорт: $1 500 × конвертация = 18 165 754.26 — контур ОФИЦ, как Excel C20", () => {
    const l = one(lines, "transport");
    assert.equal(l.amount_uzs, 18_165_754.26);
    assert.equal(l.circuit, "official");
    assert.equal(l.applied_rate_type, "CONVERSION");
  });

  it("база ГТД виртуальная: 718 419 660 НЕ входит в себестоимость (Excel C21)", () => {
    const l = one(lines, "customs_base");
    assert.equal(l.amount_uzs, 718_419_660);
    assert.equal(l.is_included_in_cost, false);
  });

  it("сбор за оформление по ДВУМ ГТД: 0.2% ИМ74 + 0.2% ИМ40 = 1 436 839.32 каждый", () => {
    const fees = lines.filter((l) => l.category === "customs_fee");
    assert.equal(fees.length, 2, "две декларации — ИМ74 (СВХ) и ИМ40 (выпуск)");
    assert.equal(fees[0]?.applied_rate_type, "IM74");
    assert.equal(fees[0]?.amount_uzs, 1_436_839.32);
    assert.equal(fees[1]?.applied_rate_type, "IM40");
    assert.equal(fees[1]?.amount_uzs, 1_436_839.32);
  });

  it("пошлина 5% от базы: 35 920 983", () => {
    assert.equal(one(lines, "duty").amount_uzs, 35_920_983);
  });

  it("НДС таможни 12% от (база + пошлина): 90 520 877.16 — зачётный, НЕ в себестоимости", () => {
    const l = one(lines, "vat_customs");
    assert.equal(l.amount_uzs, 90_520_877.16);
    assert.equal(l.is_included_in_cost, false);
    assert.equal(l.is_creditable_vat, true);
  });

  it("утиль-сбор: 670 БРВ × 412 000 = 276 040 000", () => {
    assert.equal(one(lines, "util_fee").amount_uzs, 276_040_000);
  });

  it("акциз 0% и доп.пошлина без объёма двигателя — строки не создаются", () => {
    assert.equal(
      lines.some((l) => l.category === "excise"),
      false,
    );
    assert.equal(
      lines.some((l) => l.category === "extra_duty"),
      false,
    );
  });

  it("Блок 4: сертификация/хранение ОФИЦ и НАЛ-строки по введённым суммам", () => {
    const certs = lines.filter((l) => l.category === "certification");
    assert.equal(certs.length, 2);
    assert.equal(certs.find((l) => l.circuit === "official")?.amount_uzs, 7_700_000);
    assert.equal(certs.find((l) => l.circuit === "cash")?.amount_uzs, 24_045_000);
    assert.equal(one(lines, "storage").amount_uzs, 123_459);
    // НАЛ-фиксы: таможенные (категория other) и брокер налом.
    assert.equal(one(lines, "other").amount_uzs, 650_000);
    const brokerCash = one(lines, "broker");
    assert.equal(brokerCash.circuit, "cash");
    assert.equal(brokerCash.amount_uzs, 650_000);
  });
});

describe("aggregateCosts + calculateScenario — сквозной контрольный пример тягача", () => {
  const allLines = [...generateAutoExpenseLines(TRACTOR), ...TRACTOR_MANUAL];
  const costs = aggregateCosts(allLines, TRACTOR.qty);

  it("себестоимость ОФИЦ = Excel C8: 1 064 342 780.26 (в отчёте — 1 064 342 780)", () => {
    assert.equal(costs.cost_ddp_official_uzs, 1_064_342_780.26);
    assert.equal(Math.round(costs.cost_ddp_official_uzs), 1_064_342_780);
    assert.equal(costs.cost_official_uzs, costs.cost_ddp_official_uzs);
  });

  it("НАЛ-контур: 9 334 504.72 (возврат −16 010 495.28 + 24 045 000 + 650 000 + 650 000)", () => {
    assert.equal(costs.cost_cash_uzs, 9_334_504.72);
  });

  it("себестоимость DDP ФАКТ = Excel J10: 1 073 677 284.98 — refund-модель движка воспроизводит factory × конв Excel к копейке", () => {
    // Excel: J-контур = C8 − invoice×ИМ74 + factory×конв + НАЛ-строки — та же сумма.
    assert.equal(costs.cost_ddp_total_uzs, 1_073_677_284.98);
  });

  it("зачётный НДС и импортная НДС-база выделены: 90 520 877.16 и 754 340 643", () => {
    assert.equal(costs.vat_customs_uzs, 90_520_877.16);
    assert.equal(costs.import_vat_base_uzs, 754_340_643); // база 718 419 660 + пошлина 35 920 983
  });

  it("сценарий target 1 260 000 000: P&L движка в копейках (Excel показывает целые)", () => {
    const r = calculateScenario(1_260_000_000, costs, TRACTOR);
    assert.equal(r.sale_price_no_vat_uzs, 1_125_000_000);
    assert.equal(r.vat_output_uzs, 135_000_000);
    assert.equal(r.gross_profit_official_uzs, 60_657_219.74); // Excel: 60 657 220
    assert.equal(r.markup_pct, 0.057); // 5.7% — как в сайдбаре донора
    assert.equal(r.vat_extra_payment_uzs, 0, "выручка выше базы+пошлины — ст.248 молчит");
    assert.equal(r.vat_to_pay_gni_uzs, 44_479_122.84); // Excel C18: 44 479 123
    assert.equal(r.admin_expenses_uzs, 17_640_000);
    assert.equal(r.profit_before_tax_uzs, 43_017_219.74);
    assert.equal(r.corporate_tax_uzs, 6_452_582.96);
    assert.equal(r.net_profit_official_uzs, 36_564_636.78); // Excel: 36 564 637
    assert.equal(Math.round(r.net_profit_official_uzs), 36_564_637);
    // ФАКТ на разноске движка (транспорт ОФИЦ + refund в НАЛ):
    assert.equal(r.net_profit_total_uzs, 27_230_132.06);
    assert.equal(r.salesperson_bonus_uzs, 2_178_410.56);
    assert.equal(r.owner_take_home_uzs, 25_051_721.5);
    assert.equal(r.is_profitable_official, true);
  });

  it("контрольные цифры синтез-ТЗ §11: NET_PROFIT_OFFICIAL = 36 564 637, NET_PROFIT_TOTAL = −6 946 117, бонус 0", () => {
    // РАСХОЖДЕНИЕ внутри донора: пример §11 взял себестоимость ОФИЦ из Excel
    // (1 064 342 780, транспорт в ОФИЦ), а НАЛ-итог 43 510 754 посчитал с
    // транспортом в НАЛ и без refund-корректировки. Движок так строки не
    // разнесёт (транспорт всегда ОФИЦ, Phase 15.18) — поэтому агрегаты §11
    // подаём в calculateScenario как есть: это дословные контрольные цифры
    // донора для P&L-слоя.
    const r = calculateScenario(
      1_260_000_000,
      {
        cost_ddp_official_uzs: 1_064_342_780,
        cost_cash_uzs: 43_510_754,
        vat_customs_uzs: 90_520_877.16,
        import_vat_base_uzs: 754_340_643,
      },
      PNL,
    );
    assert.equal(r.gross_profit_official_uzs, 60_657_220);
    assert.equal(r.profit_before_tax_uzs, 43_017_220);
    assert.equal(r.corporate_tax_uzs, 6_452_583);
    assert.equal(r.net_profit_official_uzs, 36_564_637);
    assert.equal(r.net_profit_total_uzs, -6_946_117);
    assert.equal(r.salesperson_bonus_uzs, 0, "бонус не начисляется на убыток");
    assert.equal(r.owner_take_home_uzs, -6_946_117);
    assert.equal(r.markup_pct, 0.057);
    assert.equal(r.is_profitable_official, true);
    assert.equal(r.is_profitable_total, false, "красная зона: по факту владелец теряет ~7M");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Второй кейс: фронтальный погрузчик HELI, ТН ВЭД 8429519900
// ════════════════════════════════════════════════════════════════════════════

/**
 * Справочник пошлин 2026 (ground-truth §1, спецтехника): фронтальный
 * погрузчик 8429519900 — пошлина 5%, НДС 12%, сбор 0.2%, утиль 0 БРВ,
 * доп.пошлина 0 $/см³. Цены и курсы — модельные, все цифры посчитаны
 * руками по формулам движка и заморожены.
 */
const HELI_RATE = 12_600;
const HELI_CONV = HELI_RATE * 1.003; // 12 637.80
const HELI = inputs({
  factory_price_usd: 26_000,
  transport_price_usd: 1_800,
  invoice_price_usd: 27_800, // = завод + транспорт
  customs_base_usd: 27_800,
  rate_im40: HELI_RATE,
  rate_im70: HELI_RATE,
  rate_im74: HELI_RATE,
  rate_conversion: HELI_CONV,
  duty_rate: 0.05,
  util_brv_count: 0, // спецтехника — утиля нет
  engine_duty_per_cc_usd: 0, // и доп.пошлины нет
  certification_cost_uzs: 3_500_000,
  // Блок 4 — авто-формулами донора (проверены в своих describe ниже):
  broker_cost_uzs: computeBrokerCostUzs({
    invoice_price_usd: 27_800,
    customs_base_usd: 27_800,
    rate_im40: HELI_RATE,
    rate_im74: HELI_RATE,
    brv_value_uzs: 412_000,
  }),
  customs_storage_cost_uzs: 400_000,
  customs_cash_uzs: computeCashFees(HELI_CONV).customs_cash_uzs,
  broker_cash_uzs: computeCashFees(HELI_CONV).broker_cash_uzs,
});

describe("второй кейс — фронтальный погрузчик HELI (ТН ВЭД 8429519900)", () => {
  const lines = generateAutoExpenseLines(HELI);
  const costs = aggregateCosts(lines, HELI.qty);

  it("авто-строки: покупка 350 280 000, транспорт 22 748 040, сборы 700 560 × 2, пошлина 17 514 000", () => {
    assert.equal(one(lines, "purchase_china").amount_uzs, 350_280_000); // 27 800 × 12 600
    assert.equal(one(lines, "transport").amount_uzs, 22_748_040); // 1 800 × 12 637.80
    const fees = lines.filter((l) => l.category === "customs_fee");
    assert.equal(fees[0]?.amount_uzs, 700_560); // 350 280 000 × 0.2%
    assert.equal(fees[1]?.amount_uzs, 700_560);
    assert.equal(one(lines, "duty").amount_uzs, 17_514_000); // × 5%
    assert.equal(one(lines, "vat_customs").amount_uzs, 44_135_280); // (база+пошлина) × 12%
  });

  it("утиль и доп.пошлина не начисляются (0 БРВ, 0 $/см³)", () => {
    assert.equal(
      lines.some((l) => l.category === "util_fee"),
      false,
    );
    assert.equal(
      lines.some((l) => l.category === "extra_duty"),
      false,
    );
  });

  it("возврат от завода: 26 000 × 12 637.80 − 27 800 × 12 600 = −21 697 200", () => {
    assert.equal(one(lines, "factory_refund_cash").amount_uzs, -21_697_200);
  });

  it("брокер ОФИЦ по авто-формуле: 2 × 2БРВ = 1 648 000 (0.1% от $27 800 меньше минимума)", () => {
    const broker = lines.find((l) => l.category === "broker" && l.circuit === "official");
    assert.equal(broker?.amount_uzs, 1_648_000);
  });

  it("агрегаты: ОФИЦ 397 491 160, НАЛ −20 433 420 (возврат перекрывает нал-фиксы), DDP ФАКТ 377 057 740", () => {
    assert.equal(costs.cost_ddp_official_uzs, 397_491_160);
    assert.equal(costs.cost_cash_uzs, -20_433_420); // −21 697 200 + 631 890 + 631 890
    assert.equal(costs.cost_ddp_total_uzs, 377_057_740);
    assert.equal(costs.import_vat_base_uzs, 367_794_000);
  });

  it("сценарий 460 000 000: прибыльный, ФАКТ выше ОФИЦ за счёт возврата", () => {
    const r = calculateScenario(460_000_000, costs, HELI);
    assert.equal(r.sale_price_no_vat_uzs, 410_714_285.71);
    assert.equal(r.vat_output_uzs, 49_285_714.29);
    assert.equal(r.gross_profit_official_uzs, 13_223_125.71);
    assert.equal(r.markup_pct, 0.0333);
    assert.equal(r.vat_extra_payment_uzs, 0);
    assert.equal(r.vat_to_pay_gni_uzs, 5_150_434.29);
    assert.equal(r.admin_expenses_uzs, 6_440_000);
    assert.equal(r.profit_before_tax_uzs, 6_783_125.71);
    assert.equal(r.corporate_tax_uzs, 1_017_468.86);
    assert.equal(r.net_profit_official_uzs, 5_765_656.85);
    assert.equal(r.net_profit_total_uzs, 26_199_076.85, "минус отрицательный НАЛ = плюс");
    assert.equal(r.salesperson_bonus_uzs, 2_095_926.15);
    assert.equal(r.owner_take_home_uzs, 24_103_150.7);
    assert.equal(r.is_profitable_official, true);
    assert.equal(r.is_profitable_total, true);
  });

  it("сценарий 400 000 000: срабатывает ст. 248 ч.5 НК — доплата 12% с разницы до импортной базы", () => {
    const r = calculateScenario(400_000_000, costs, HELI);
    assert.equal(r.sale_price_no_vat_uzs, 357_142_857.14);
    // MAX(0, 367 794 000 − 357 142 857.14) × 0.12:
    assert.equal(r.vat_extra_payment_uzs, 1_278_137.14);
    // Выходной НДС + доплата ровно компенсируют зачёт (та же база, та же ставка):
    assert.equal(r.vat_to_pay_gni_uzs, 0);
    assert.equal(r.gross_profit_official_uzs, -40_348_302.86);
    assert.equal(r.markup_pct, -0.1015);
    assert.equal(r.corporate_tax_uzs, 0, "налог только с положительной прибыли");
    assert.equal(r.net_profit_official_uzs, -45_948_302.86);
    assert.equal(r.net_profit_total_uzs, -25_514_882.86);
    assert.equal(r.salesperson_bonus_uzs, 0);
    assert.equal(r.is_profitable_official, false);
    assert.equal(r.is_profitable_total, false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Авто-формулы Блока 4
// ════════════════════════════════════════════════════════════════════════════

describe("computeBrokerCostUzs — брокерские ОФИЦ (Phase 15.23)", () => {
  it("каждая половина не меньше 2 БРВ: тягач $59 500 → 824 000 + 824 000 = 1 648 000", () => {
    // 0.1% от 59 500 × 12 074.28 = 718 419.66 < 2 × 412 000 → минимум.
    assert.equal(
      computeBrokerCostUzs({
        invoice_price_usd: 59_500,
        customs_base_usd: 59_500,
        rate_im40: 12_074.28,
        rate_im74: 12_074.28,
        brv_value_uzs: 412_000,
      }),
      1_648_000,
    );
  });

  it("выше минимума — 0.1% от суммы: $150 000 → 1 811 142 × 2 = 3 622 284", () => {
    assert.equal(
      computeBrokerCostUzs({
        invoice_price_usd: 150_000,
        customs_base_usd: 150_000,
        rate_im40: 12_074.28,
        rate_im74: 12_074.28,
        brv_value_uzs: 412_000,
      }),
      3_622_284,
    );
  });

  it("нулевая цена или курс обнуляют свою половину, а не тянут минимум", () => {
    assert.equal(
      computeBrokerCostUzs({
        invoice_price_usd: 0,
        customs_base_usd: 59_500,
        rate_im40: 12_074.28,
        rate_im74: 12_074.28,
        brv_value_uzs: 412_000,
      }),
      824_000,
    );
    assert.equal(
      computeBrokerCostUzs({
        invoice_price_usd: 0,
        customs_base_usd: 0,
        rate_im40: 0,
        rate_im74: 0,
        brv_value_uzs: 412_000,
      }),
      0,
    );
  });
});

describe("computeCashFees — НАЛ-фиксы 50$ × конвертация (Phase 15.24)", () => {
  it("тягач: 50 × 12 110.50284 = 605 525.14 на таможню и столько же брокеру", () => {
    const fees = computeCashFees(12_074.28 * 1.003);
    assert.equal(fees.customs_cash_uzs, 605_525.14);
    assert.equal(fees.broker_cash_uzs, 605_525.14);
  });

  it("HELI: 50 × 12 637.80 = 631 890", () => {
    assert.equal(computeCashFees(HELI_CONV).customs_cash_uzs, 631_890);
  });

  it("нулевой или отрицательный курс — нули, а не мусор", () => {
    assert.deepEqual(computeCashFees(0), { customs_cash_uzs: 0, broker_cash_uzs: 0 });
    assert.deepEqual(computeCashFees(-1), { customs_cash_uzs: 0, broker_cash_uzs: 0 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Доп.пошлина $/см³ и порог НАЛ-корректировки
// ════════════════════════════════════════════════════════════════════════════

describe("extra_duty и порог корректировки |Δ| > 1 UZS", () => {
  it("доп.пошлина: объём × 3.36$ × ИМ40, и она входит в базу НДС таможни", () => {
    const lines = generateAutoExpenseLines(
      inputs({
        factory_price_usd: 10_000,
        invoice_price_usd: 10_000,
        customs_base_usd: 10_000,
        rate_im40: 12_000,
        rate_im74: 12_000,
        rate_conversion: 12_000,
        duty_rate: 0.05,
        engine_volume_cc: 10_000,
        engine_duty_per_cc_usd: 3.36,
      }),
    );
    assert.equal(one(lines, "extra_duty").amount_uzs, 403_200_000); // 10 000 × 3.36 × 12 000
    // НДС таможни = (база 120 000 000 + пошлина 6 000 000 + доп. 403 200 000) × 12%
    assert.equal(one(lines, "vat_customs").amount_uzs, 63_504_000);
    // и агрегатная импортная НДС-база тоже с доп.пошлиной:
    assert.equal(aggregateCosts(lines, 1).import_vat_base_uzs, 529_200_000);
  });

  it("реальный кейс самосвала: 9 726 см³ × 3.36 × 12 074.28 = 394 579 742.86", () => {
    const lines = generateAutoExpenseLines(
      inputs({
        factory_price_usd: 23_560,
        invoice_price_usd: 23_560,
        customs_base_usd: 25_600, // база выше инвойса — норма (ground-truth §4)
        rate_im40: 12_074.28,
        rate_im74: 12_074.28,
        rate_conversion: 12_074.28,
        duty_rate: 0.7,
        engine_volume_cc: 9_726,
        engine_duty_per_cc_usd: 3.36,
      }),
    );
    assert.equal(one(lines, "extra_duty").amount_uzs, 394_579_742.86);
  });

  it("ФАКТ = ОФИЦ (инвойс = завод, конвертация = ИМ74) — корректировка не создаётся", () => {
    const lines = generateAutoExpenseLines(
      inputs({
        factory_price_usd: 10_000,
        invoice_price_usd: 10_000,
        customs_base_usd: 10_000,
        rate_im40: 12_000,
        rate_im74: 12_000,
        rate_conversion: 12_000, // markup = 1 → Δ = 0
      }),
    );
    assert.equal(
      lines.some((l) => l.category === "factory_refund_cash"),
      false,
    );
    assert.equal(
      lines.some((l) => l.category === "factory_overpay_cash"),
      false,
    );
  });

  it("|Δ| ≤ 1 UZS — float-шум не рождает строку", () => {
    const lines = generateAutoExpenseLines(
      inputs({
        factory_price_usd: 10_000,
        invoice_price_usd: 10_000,
        customs_base_usd: 10_000,
        rate_im40: 12_000,
        rate_im74: 12_000,
        rate_conversion: 12_000.00005, // Δ = 0.5 UZS
      }),
    );
    assert.equal(
      lines.some((l) => l.category === "factory_refund_cash"),
      false,
    );
    assert.equal(
      lines.some((l) => l.category === "factory_overpay_cash"),
      false,
    );
  });

  it("банковский markup при инвойс = завод даёт overpay: 58 000 × ИМ74 × 0.003 = 2 100 924.72", () => {
    const lines = generateAutoExpenseLines(
      inputs({
        factory_price_usd: 58_000,
        invoice_price_usd: 58_000,
        customs_base_usd: 58_000,
        rate_im40: 12_074.28,
        rate_im74: 12_074.28,
        rate_conversion: 12_074.28 * 1.003,
      }),
    );
    const l = one(lines, "factory_overpay_cash");
    assert.equal(l.amount_uzs, 2_100_924.72);
    assert.equal(l.circuit, "cash");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Агрегация: qty и масштабирование
// ════════════════════════════════════════════════════════════════════════════

describe("aggregateCosts — qty и per_unit/per_batch", () => {
  const lines: ExpenseLine[] = [
    manualLine("purchase_china", "official", 100), // per_unit → × qty
    manualLine("storage", "official", 500, { scaling: "per_batch" }), // за партию
    manualLine("certification", "cash", 10), // per_unit НАЛ
    manualLine("customs_base", "official", 200, { is_included_in_cost: false }),
    manualLine("duty", "official", 50),
    manualLine("vat_customs", "official", 90, {
      is_included_in_cost: false,
      is_creditable_vat: true,
    }),
  ];
  const costs = aggregateCosts(lines, 3);

  it("per_unit умножается на qty, per_batch — нет", () => {
    assert.equal(costs.cost_official_uzs, 100 * 3 + 500 + 50 * 3); // 950
    assert.equal(costs.cost_cash_uzs, 30);
    assert.equal(costs.cost_ddp_total_uzs, 980);
  });

  it("виртуальная база и зачётный НДС не в себестоимости, но видны в агрегатах", () => {
    assert.equal(costs.vat_customs_uzs, 270); // 90 × 3
    assert.equal(costs.import_vat_base_uzs, (200 + 50) * 3); // база + пошлина
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Подбор цены: breakeven и целевые 3/6/10%
// ════════════════════════════════════════════════════════════════════════════

describe("подбор цены — breakeven и целевая чистая прибыль", () => {
  it("breakeven для себестоимости §11: 1 211 053 228.22, чистая ОФИЦ = 0", () => {
    const price = computeBreakevenSalePrice(1_064_342_780, 0.12, 0.014);
    assert.equal(price, 1_211_053_228.22);
    const r = calculateScenario(
      price,
      {
        cost_ddp_official_uzs: 1_064_342_780,
        cost_cash_uzs: 0,
        vat_customs_uzs: 0,
        import_vat_base_uzs: 0,
      },
      PNL,
    );
    assert.ok(
      Math.abs(r.net_profit_official_uzs) < 1,
      `на границе безубыточности |чистая| < 1 UZS, получено ${r.net_profit_official_uzs}`,
    );
  });

  it("breakeven для HELI: 452 281 879.06, чистая ОФИЦ в пределах копеек округления", () => {
    const price = computeBreakevenSalePrice(397_491_160, 0.12, 0.014);
    assert.equal(price, 452_281_879.06);
    const r = calculateScenario(
      price,
      {
        cost_ddp_official_uzs: 397_491_160,
        cost_cash_uzs: 0,
        vat_customs_uzs: 0,
        import_vat_base_uzs: 0,
      },
      PNL,
    );
    assert.ok(Math.abs(r.net_profit_official_uzs) < 1);
  });

  it("целевые 3/6/10% от себестоимости HELI: обратный подбор сходится с прямым расчётом", () => {
    const cost = 397_491_160;
    const cases = [
      // [цель, цена с НДС, чистая ОФИЦ прямым расчётом]
      [0.03, 468_244_768.91, 11_924_734.8],
      [0.06, 484_207_658.76, 23_849_469.6],
      // 10%: дрейф округления 1 тийин против цели 39 749 116 — допустимо (< 1 UZS).
      [0.1, 505_491_511.89, 39_749_115.99],
    ] as const;
    for (const [pct, expectedPrice, expectedNet] of cases) {
      const price = computeSalePriceForTargetNetProfit(cost, pct, 0.12, 0.014, 0.15);
      assert.equal(price, expectedPrice, `цена для цели ${pct * 100}%`);
      const r = calculateScenario(
        price,
        {
          cost_ddp_official_uzs: cost,
          cost_cash_uzs: 0,
          vat_customs_uzs: 0,
          import_vat_base_uzs: 0,
        },
        PNL,
      );
      assert.equal(r.net_profit_official_uzs, expectedNet);
      assert.ok(
        Math.abs(r.net_profit_official_uzs - round2(pct * cost)) < 1,
        `чистая ОФИЦ ≈ ${pct * 100}% от себестоимости`,
      );
    }
  });

  it("вырожденные ставки (admin ≥ 1/(1+НДС)) — цена 0, а не бесконечность", () => {
    assert.equal(computeBreakevenSalePrice(1_000, 0.12, 0.9), 0);
    assert.equal(computeSalePriceForTargetNetProfit(1_000, 0.1, 0.12, 0.9, 0.15), 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Округления
// ════════════════════════════════════════════════════════════════════════════

describe("round2/round4 — арифметика донора (Math.round, не decimal)", () => {
  it("обычные случаи: до копеек и до 4 знаков", () => {
    assert.equal(round2(1_234.5678), 1_234.57);
    assert.equal(round2(605_525.142), 605_525.14); // НАЛ-фикс тягача
    assert.equal(round4(0.0332665), 0.0333); // маржа HELI
    assert.equal(round4(-0.1015074), -0.1015);
  });

  it("float-артефакты фиксируются как есть — паритет с Excel достигнут на них", () => {
    // 1.005 × 100 = 100.49999999999999 → Math.round → 100. Decimal дал бы 1.01 —
    // и сломал бы эталонные копейки контрольного примера. Переносим дословно.
    assert.equal(round2(1.005), 1);
    assert.equal(round2(1.015), 1.01);
    assert.equal(round2(2.675), 2.68); // а тут 267.50000000000003 — вверх
  });

  it("отрицательные: Math.round тянет половину к +∞ (−0.025 → −0.02)", () => {
    assert.equal(round2(-0.025), -0.02);
  });
});

describe("ровная цена без НДС — сторона, которая остаётся у нас", () => {
  const VAT = 0.12;
  const COST = 1_064_342_780; // тягач из эталона Excel

  it("сырая цена подбора садится на круглые миллионы без НДС", () => {
    // 1 296 539 338,45 с НДС → 1 157 624 409,33 без НДС → 1 158 000 000.
    const raw = computeSalePriceForTargetNetProfit(COST, 0.06, VAT, 0.014, 0.15);
    const r = roundSalePriceToNoVatStep(raw, VAT);
    assert.equal(r.sale_price_no_vat_uzs, 1_158_000_000);
    assert.equal(r.sale_price_with_vat_uzs, 1_296_960_000);
  });

  it("calculateScenario обратным делением возвращает ТО ЖЕ круглое число", () => {
    // Главный инвариант. Цена с НДС считается из ровной цены без НДС, а
    // сценарий делит обратно — если бы делили в другом порядке, здесь вышло
    // бы 1 157 999 999,99, и в КП поехала бы цена с копейками.
    const raw = computeSalePriceForTargetNetProfit(COST, 0.06, VAT, 0.014, 0.15);
    const r = roundSalePriceToNoVatStep(raw, VAT);
    const s = calculateScenario(
      r.sale_price_with_vat_uzs,
      {
        cost_ddp_official_uzs: COST,
        cost_cash_uzs: 0,
        vat_customs_uzs: 0,
        import_vat_base_uzs: 0,
      },
      {
        vat_sale_rate: VAT,
        corporate_tax_rate: 0.15,
        admin_expenses_rate: 0.014,
        salesperson_bonus_rate: 0.08,
      },
    );
    assert.equal(s.sale_price_no_vat_uzs, 1_158_000_000);
    assert.equal(s.vat_output_uzs, 138_960_000);
  });

  it("вверх по умолчанию: цену под целевую прибыль вниз не роняем", () => {
    // Ровно на шаге остаётся на месте, чуть выше — уходит на следующий.
    assert.equal(
      roundSalePriceToNoVatStep(1_120_000_000 * 1.12, VAT).sale_price_no_vat_uzs,
      1_120_000_000,
    );
    assert.equal(
      roundSalePriceToNoVatStep(1_120_000_001 * 1.12, VAT).sale_price_no_vat_uzs,
      1_121_000_000,
    );
  });

  it("nearest — когда важнее не отходить от цели, а не только вверх", () => {
    const near = (withVat: number) =>
      roundSalePriceToNoVatStep(withVat * 1.12, VAT, 1_000_000, "nearest").sale_price_no_vat_uzs;
    assert.equal(near(1_120_400_000), 1_120_000_000);
    assert.equal(near(1_120_600_000), 1_121_000_000);
  });

  it("шаг крупнее: десятки и сотни миллионов", () => {
    assert.equal(
      roundSalePriceToNoVatStep(1_157_624_409.33 * 1.12, VAT, 10_000_000).sale_price_no_vat_uzs,
      1_160_000_000,
    );
    assert.equal(
      roundSalePriceToNoVatStep(1_157_624_409.33 * 1.12, VAT, 100_000_000).sale_price_no_vat_uzs,
      1_200_000_000,
    );
  });

  it("бессмысленный шаг не портит цену — возвращаем как есть", () => {
    const r = roundSalePriceToNoVatStep(1_296_539_338.45, VAT, 0);
    assert.equal(r.sale_price_with_vat_uzs, 1_296_539_338.45);
    assert.equal(r.sale_price_no_vat_uzs, round2(1_296_539_338.45 / 1.12));
  });
});
