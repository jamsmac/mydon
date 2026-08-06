/**
 * Калькулятор цены GLOBERENT — расчётный движок импорта техники (чистые функции).
 *
 * Дословный перенос из донора PROMACH (перенос кода, не переписывание):
 *   • apps/api/src/calculator-engine.ts — ядро (Phase 15.18–15.24);
 *   • apps/api/src/calculator.ts — computeBrokerCostUzs / computeCashFees
 *     (Phase 15.23/15.24, авто-формулы брокера и НАЛ-фиксов).
 *
 * Эталон — Excel владельца (донор: docs/calculator-excel-analysis/01, 04).
 * Контрольный пример «Седельный тягач (пневмо) SX4258NT384T»:
 *   COST_DDP_OFFICIAL = 1 064 342 780 UZS (Excel C8),
 *   NET_PROFIT_OFFICIAL = 36 564 637 UZS — golden-тесты в calc.test.ts.
 *
 * ВАЖНО про арифметику: формулы, константы и округления (round2/round4 через
 * Math.round) перенесены дословно — паритет с Excel достигнут именно на этой
 * арифметике; переход на decimal-библиотеку ломает эталонные цифры.
 *
 * Никаких побочных эффектов и обращений к БД: все входы (ставки ТН ВЭД, БРВ,
 * курсы, цены) — параметры функций. Snapshot ставок и подтяжку из справочников
 * делает вызывающий слой.
 *
 * Известные расхождения донор-кода с Excel-доком (переносим КОД донора,
 * расхождения зафиксированы тестами):
 *   1) сбор за оформление: движок считает 0.2% по ДВУМ ГТД (ИМ74 + ИМ40),
 *      в Excel-листе тягача сбор вбит хардкодом 5 625 000 (загадка ячейки C23);
 *   2) транспорт: движок кладёт в ОФИЦ (как Excel C20 = C2×F4), а пример §11
 *      синтез-ТЗ донора считал его в НАЛ — контрольная цифра
 *      NET_PROFIT_TOTAL = −6 946 117 несёт именно ту разноску;
 *   3) движок держит копейки, Excel показывает целые UZS
 *      (1 064 342 780.26 ↔ 1 064 342 780).
 */

// ════════════════════════════════════════════════════════════════════════════
// ТИПЫ
// ════════════════════════════════════════════════════════════════════════════

/** Контур учёта строки затрат: официальный (банк, ГТД) или наличный. */
export type Circuit = "official" | "cash";

/** Категория статьи затрат (соответствует CHECK в БД донора, миграция 052). */
export type ExpenseCategory =
  | "purchase_china"
  | "factory_overpay_cash"
  | "factory_refund_cash"
  | "transport"
  | "customs_base"
  | "customs_fee"
  | "duty"
  | "extra_duty"
  | "excise"
  | "vat_customs"
  | "util_fee"
  | "storage"
  | "broker"
  | "gai_railway"
  | "gtd_fill_im40"
  | "gtd_fill_im70"
  | "gtd_fill_im74"
  | "certification"
  | "bank_commission"
  | "other";

/** Сценарий продажи. */
export type ScenarioType = "min" | "target" | "premium" | "custom";

/** Применённый курс. */
export type AppliedRateType = "IM40" | "IM70" | "IM74" | "CONVERSION" | "NONE";

/** Источник суммы. */
export type AmountSource = "auto" | "manual_uzs" | "manual_usd";

/** Входные данные для расчёта (snapshot полей calculator_estimations донора). */
export interface EstimationInputs {
  // 4 USD-цены
  factory_price_usd: number;
  transport_price_usd: number;
  invoice_price_usd: number;
  customs_base_usd: number;

  // 4 курса + банк-наценка
  rate_im40: number;
  rate_im70: number;
  rate_im74: number;
  rate_conversion: number;
  bank_conversion_markup: number; // 1.003 default

  // БРВ
  brv_value_uzs: number;

  // Таможенные ставки
  duty_rate: number;
  customs_fee_rate: number; // 0.002
  excise_rate: number; // 0 для авто/спецтехники
  vat_customs_rate: number; // 0.12 или 0 (льгота)
  util_brv_count: number; // 0 если нет утиля
  engine_volume_cc: number | null;
  engine_duty_per_cc_usd: number; // 3.36 или 0

  // P&L параметры
  vat_sale_rate: number; // 0.12
  corporate_tax_rate: number; // 0.15
  admin_expenses_rate: number; // 0.014
  salesperson_bonus_rate: number; // 0.08
  premium_markup_pct: number; // 0.10 (для авто-генерации premium-сценария)

  // Phase 15.18: сертификация — UZS, ручной ввод в Блок 4
  certification_cost_uzs: number; // если > 0, авто-создаётся expense_line

  // Phase 15.18: брокерские услуги — UZS (авто-формула computeBrokerCostUzs)
  broker_cost_uzs: number; // если > 0, авто-создаётся expense_line (broker)

  // Phase 15.18: таможенное хранение / СВХ — UZS, ручной ввод в Блок 4
  customs_storage_cost_uzs: number; // если > 0, авто-создаётся expense_line (storage)

  // Phase 15.18: НАЛ-расходы из Блока 4
  // certification_cash_uzs — manual (цены меняются каждый раз, формула невозможна)
  certification_cash_uzs: number; // сертификация налом (cash circuit) — manual
  // Phase 15.24: customs_cash и broker_cash стали авто (50$ × rate_conversion)
  customs_cash_uzs: number; // таможенные расходы налом (cash circuit) — auto
  broker_cash_uzs: number; // брокерские услуги налом (cash circuit) — auto

  qty: number;
}

/** Строка затрат — структура для расчётов. */
export interface ExpenseLine {
  id?: number;
  category: ExpenseCategory;
  label?: string;
  circuit: Circuit;
  source: AmountSource;
  amount_uzs: number;
  amount_usd?: number | null;
  applied_rate_type: AppliedRateType;
  applied_rate?: number | null;
  is_included_in_cost: boolean;
  is_creditable_vat: boolean;
  is_locked: boolean;
  scaling: "per_unit" | "per_batch";
  order_index?: number;
}

/** Результат расчёта по сценарию продажи. */
export interface ScenarioResult {
  // Цена
  sale_price_with_vat_uzs: number;
  sale_price_no_vat_uzs: number;
  // НДС
  vat_output_uzs: number;
  vat_extra_payment_uzs: number; // ст. 248 ч.5
  vat_to_pay_gni_uzs: number;
  // Прибыль ОФИЦ
  gross_profit_official_uzs: number;
  admin_expenses_uzs: number;
  profit_before_tax_uzs: number;
  corporate_tax_uzs: number;
  net_profit_official_uzs: number;
  // Прибыль ФАКТ
  net_profit_total_uzs: number;
  // Бонус и владелец
  salesperson_bonus_uzs: number;
  owner_take_home_uzs: number;
  // Маржа
  markup_pct: number;
  // Флаги UX
  is_profitable_official: boolean;
  is_profitable_total: boolean;
}

/** Агрегаты себестоимости по контурам (вход calculateScenario). */
export interface CostAggregates {
  cost_official_uzs: number;
  cost_cash_uzs: number;
  cost_ddp_official_uzs: number; // = cost_official (НДС-таможни НЕ включена)
  cost_ddp_total_uzs: number; // = cost_official + cost_cash
  vat_customs_uzs: number; // НДС таможни (для зачёта)
  import_vat_base_uzs: number; // база + пошлина + акциз + доп.пошлина
}

// ════════════════════════════════════════════════════════════════════════════
// АВТО-СТРОКИ ЗАТРАТ — генерация по входным данным
// ════════════════════════════════════════════════════════════════════════════

/**
 * Генерирует auto-строки затрат на основе входных данных.
 * Возвращает массив строк, которые ВСЕГДА автоматически создаются/обновляются
 * при изменении формы расчёта. Manual-строки (ЖД/ГАИ, заполнение ГТД и прочее)
 * добавляются менеджером отдельно.
 *
 * Все auto-строки помечаются `is_locked=TRUE` — менеджер не может их удалить
 * вручную (только косвенно, изменив входные данные).
 */
export function generateAutoExpenseLines(i: EstimationInputs): ExpenseLine[] {
  const lines: ExpenseLine[] = [];

  // ─── 1. Покупка в Китае (ОФИЦ, ЦЕНА ИНВОЙСА × КУРС ИМ74) ─────────────────
  // Phase 15.18 (fix #4): применяемый курс — ИМ74 (курс ЦБ РУз на дату
  // подачи ГТД ИМ74), НЕ rate_conversion. Причина:
  //   • ОФИЦ-контур = бухгалтерия / ГТД. В ГТД ИМ74 фиксируется курс ЦБ,
  //     по нему «приходуется» товар в книгах. В официальных платежах
  //     понятия «курс конвертации» НЕТ — это банковский внутренний курс
  //     для расчёта реальной суммы UZS, ушедшей со счёта.
  //   • Курс конвертации остаётся для НАЛ/ФАКТ-контура: factory_refund /
  //     factory_overpay (см. п.2) переводятся в UZS именно по нему,
  //     т.к. это реальные cash-движения через банк.
  //
  // База — invoice_price_usd (инвойс — это ОФИЦИАЛЬНЫЙ документ,
  // в книги попадает ровно эта сумма).
  lines.push({
    category: "purchase_china",
    label: "Купили в Китае (цена инвойса × курс ИМ74)",
    circuit: "official",
    source: "auto",
    amount_uzs: round2(i.invoice_price_usd * i.rate_im74),
    amount_usd: i.invoice_price_usd,
    applied_rate_type: "IM74",
    applied_rate: i.rate_im74,
    is_included_in_cost: true,
    is_creditable_vat: false,
    is_locked: true,
    scaling: "per_unit",
    order_index: 10,
  });

  // ─── 2. Корректировка ОФИЦ→ФАКТ для покупки в Китае (НАЛ-контур) ─────────
  // Phase 15.18 (fix #7): формула приведена к виду который даёт правильную
  // ФАКТ-себестоимость по Excel-эталону владельца.
  //
  // Модель:
  //   ОФИЦ purchase_china = invoice × ИМ74   (то, что в книгах / ГТД ИМ74)
  //   ФАКТ purchase_china = factory × conv   (реальная экономическая стоимость:
  //                                            цена завод нам × банковский курс)
  //
  // Разница ФАКТ − ОФИЦ = factory × conv − invoice × ИМ74.
  // Эту разницу записываем как НАЛ-корректировку:
  //   • Если ФАКТ < ОФИЦ (типично, когда invoice > factory) — отрицательная
  //     сумма → уменьшает costCash → увеличивает netProfitTotal (ДОХОД ФАКТ).
  //   • Если ФАКТ > ОФИЦ (когда invoice < factory или markup банка велик) —
  //     положительная сумма → увеличивает costCash → РАСХОД ФАКТ.
  //
  // Эта строка ВКЛЮЧАЕТ в себя и реальный возврат от завода налом, и
  // банковский markup при конвертации UZS→USD — обе вещи учтены одной
  // суммой, как в Excel-эталоне.
  const factualPurchaseUzs = i.factory_price_usd * i.rate_conversion;
  const officialPurchaseUzs = i.invoice_price_usd * i.rate_im74;
  const adjustmentUzs = factualPurchaseUzs - officialPurchaseUzs; // signed
  if (Math.abs(adjustmentUzs) > 1) {
    if (adjustmentUzs < 0) {
      // ФАКТ дешевле ОФИЦ → доход для ФАКТ
      lines.push({
        category: "factory_refund_cash",
        label: "Корректировка ФАКТ: factory × конв − invoice × ИМ74 (доход налом)",
        circuit: "cash",
        source: "auto",
        amount_uzs: round2(adjustmentUzs), // NEGATIVE = доход
        amount_usd: i.factory_price_usd - i.invoice_price_usd, // < 0 if invoice > factory
        applied_rate_type: "CONVERSION",
        applied_rate: i.rate_conversion,
        is_included_in_cost: true,
        is_creditable_vat: false,
        is_locked: true,
        scaling: "per_unit",
        order_index: 12,
      });
    } else {
      // ФАКТ дороже ОФИЦ → расход для ФАКТ
      lines.push({
        category: "factory_overpay_cash",
        label: "Корректировка ФАКТ: factory × конв − invoice × ИМ74 (расход налом)",
        circuit: "cash",
        source: "auto",
        amount_uzs: round2(adjustmentUzs), // POSITIVE = расход
        amount_usd: i.factory_price_usd - i.invoice_price_usd,
        applied_rate_type: "CONVERSION",
        applied_rate: i.rate_conversion,
        is_included_in_cost: true,
        is_creditable_vat: false,
        is_locked: true,
        scaling: "per_unit",
        order_index: 12,
      });
    }
  }

  // ─── 3. Транспорт (по курсу конвертации, контур по умолчанию ОФИЦ) ────────
  if (i.transport_price_usd > 0) {
    lines.push({
      category: "transport",
      label: "Транспорт (× курс конвертации)",
      circuit: "official",
      source: "auto",
      amount_uzs: round2(i.transport_price_usd * i.rate_conversion),
      amount_usd: i.transport_price_usd,
      applied_rate_type: "CONVERSION",
      applied_rate: i.rate_conversion,
      is_included_in_cost: true,
      is_creditable_vat: false,
      is_locked: true,
      scaling: "per_unit",
      order_index: 20,
    });
  }

  // ─── 4. База в таможне (виртуальная, НЕ в себестоимости) ─────────────────
  const customsBaseUzs = round2(i.customs_base_usd * i.rate_im40);
  lines.push({
    category: "customs_base",
    label: "База ГТД (база × ИМ40, виртуальное)",
    circuit: "official",
    source: "auto",
    amount_uzs: customsBaseUzs,
    amount_usd: i.customs_base_usd,
    applied_rate_type: "IM40",
    applied_rate: i.rate_im40,
    is_included_in_cost: false, // ВАЖНО: не в себестоимости
    is_creditable_vat: false,
    is_locked: true,
    scaling: "per_unit",
    order_index: 30,
  });

  // ─── 5. Таможенные сборы за оформление (0.2% × ДВЕ ГТД) ──────────────────
  // Phase 15.18 (fix): груз проходит ДВЕ декларации в стандартном потоке
  // импорта через СВХ (склад временного хранения):
  //   • ИМ74 — поступление на СВХ (временный ввоз).
  //   • ИМ40 — выпуск для свободного обращения.
  // На каждую ГТД платится сбор 0.2% от таможенной базы по СВОЕМУ курсу
  // (ИМ74-курс / ИМ40-курс). Раньше учитывался только ИМ40-сбор — теперь
  // оба, как в Excel-эталоне владельца.
  //
  // Пошлина / НДС таможни / акциз / доп.пошлина — по-прежнему ТОЛЬКО на ИМ40
  // (они начисляются при выпуске в свободное обращение, не при временном ввозе).

  // ─── 5а. Сбор за оформление ИМ74 (на курс ИМ74) ───────────────────────────
  const customsBaseUzsIm74 = round2(i.customs_base_usd * i.rate_im74);
  const customsFeeIm74Uzs = round2(customsBaseUzsIm74 * i.customs_fee_rate);
  lines.push({
    category: "customs_fee",
    label: `Таможенный сбор за оформление ИМ74 (${(i.customs_fee_rate * 100).toFixed(1)}%)`,
    circuit: "official",
    source: "auto",
    amount_uzs: customsFeeIm74Uzs,
    applied_rate_type: "IM74",
    applied_rate: i.rate_im74,
    is_included_in_cost: true,
    is_creditable_vat: false,
    is_locked: true,
    scaling: "per_unit",
    order_index: 38,
  });

  // ─── 5б. Сбор за оформление ИМ40 (на курс ИМ40) ───────────────────────────
  const customsFeeIm40Uzs = round2(customsBaseUzs * i.customs_fee_rate);
  lines.push({
    category: "customs_fee",
    label: `Таможенный сбор за оформление ИМ40 (${(i.customs_fee_rate * 100).toFixed(1)}%)`,
    circuit: "official",
    source: "auto",
    amount_uzs: customsFeeIm40Uzs,
    applied_rate_type: "IM40",
    applied_rate: i.rate_im40,
    is_included_in_cost: true,
    is_creditable_vat: false,
    is_locked: true,
    scaling: "per_unit",
    order_index: 40,
  });

  // ─── 6. Пошлина ───────────────────────────────────────────────────────────
  const dutyUzs = round2(customsBaseUzs * i.duty_rate);
  lines.push({
    category: "duty",
    label: `Пошлина (${(i.duty_rate * 100).toFixed(1)}%)`,
    circuit: "official",
    source: "auto",
    amount_uzs: dutyUzs,
    applied_rate_type: "IM40",
    applied_rate: i.rate_im40,
    is_included_in_cost: true,
    is_creditable_vat: false,
    is_locked: true,
    scaling: "per_unit",
    order_index: 50,
  });

  // ─── 7. Акциз (обычно 0 для авто/спецтехники, но формула общая) ───────────
  const exciseUzs = round2(customsBaseUzs * i.excise_rate);
  if (i.excise_rate > 0) {
    lines.push({
      category: "excise",
      label: `Акциз (${(i.excise_rate * 100).toFixed(1)}%)`,
      circuit: "official",
      source: "auto",
      amount_uzs: exciseUzs,
      applied_rate_type: "IM40",
      applied_rate: i.rate_im40,
      is_included_in_cost: true,
      is_creditable_vat: false,
      is_locked: true,
      scaling: "per_unit",
      order_index: 55,
    });
  }

  // ─── 8. Доп. пошлина $/см³ (только если applicable) ──────────────────────
  let extraDutyUzs = 0;
  if (i.engine_duty_per_cc_usd > 0 && i.engine_volume_cc && i.engine_volume_cc > 0) {
    extraDutyUzs = round2(i.engine_volume_cc * i.engine_duty_per_cc_usd * i.rate_im40);
    lines.push({
      category: "extra_duty",
      label: `Доп. пошлина ${i.engine_volume_cc} см³ × $${i.engine_duty_per_cc_usd}`,
      circuit: "official",
      source: "auto",
      amount_uzs: extraDutyUzs,
      applied_rate_type: "IM40",
      applied_rate: i.rate_im40,
      is_included_in_cost: true,
      is_creditable_vat: false,
      is_locked: true,
      scaling: "per_unit",
      order_index: 60,
    });
  }

  // ─── 9. НДС таможни (ЗАЧЁТНЫЙ, НЕ в себестоимости) ───────────────────────
  // База НДС таможни = IMPORT_VAT_BASE = customs_base + duty + excise + extra_duty
  const importVatBaseUzs = customsBaseUzs + dutyUzs + exciseUzs + extraDutyUzs;
  const vatCustomsUzs = round2(importVatBaseUzs * i.vat_customs_rate);
  lines.push({
    category: "vat_customs",
    label: `НДС таможни ${(i.vat_customs_rate * 100).toFixed(0)}% (зачётный)`,
    circuit: "official",
    source: "auto",
    amount_uzs: vatCustomsUzs,
    applied_rate_type: "IM40",
    applied_rate: i.rate_im40,
    is_included_in_cost: false, // ВАЖНО: зачитывается с output VAT
    is_creditable_vat: true,
    is_locked: true,
    scaling: "per_unit",
    order_index: 70,
  });

  // ─── 10. Утилизационный сбор (БРВ × значение БРВ) ────────────────────────
  if (i.util_brv_count > 0) {
    const utilFeeUzs = round2(i.util_brv_count * i.brv_value_uzs);
    lines.push({
      category: "util_fee",
      label: `Утиль-сбор (${i.util_brv_count} БРВ × ${formatUzs(i.brv_value_uzs)})`,
      circuit: "official",
      source: "auto",
      amount_uzs: utilFeeUzs,
      applied_rate_type: "NONE",
      is_included_in_cost: true,
      is_creditable_vat: false,
      is_locked: true,
      scaling: "per_unit",
      order_index: 80,
    });
  }

  // ─── 11. Сертификационные расходы (Phase 15.18) ──────────────────────────
  // Заполняется владельцем в Блоке 4 как одно поле UZS. Авто-строка ОФИЦ.
  if (i.certification_cost_uzs > 0) {
    lines.push({
      category: "certification",
      label: "Сертификация (из Блока 4)",
      circuit: "official",
      source: "auto",
      amount_uzs: round2(i.certification_cost_uzs),
      applied_rate_type: "NONE",
      is_included_in_cost: true,
      is_creditable_vat: false,
      is_locked: true,
      scaling: "per_unit",
      order_index: 90,
    });
  }

  // ─── 12. Брокерские услуги (Phase 15.18) ─────────────────────────────────
  // UZS из Блока 4 (с Phase 15.23 — авто-формула computeBrokerCostUzs).
  // Авто-строка ОФИЦ.
  if (i.broker_cost_uzs > 0) {
    lines.push({
      category: "broker",
      label: "Брокерские услуги (из Блока 4)",
      circuit: "official",
      source: "auto",
      amount_uzs: round2(i.broker_cost_uzs),
      applied_rate_type: "NONE",
      is_included_in_cost: true,
      is_creditable_vat: false,
      is_locked: true,
      scaling: "per_unit",
      order_index: 92,
    });
  }

  // ─── 13. Таможенное хранение / СВХ (Phase 15.18) ─────────────────────────
  // Ручной ввод UZS в Блоке 4. Авто-строка ОФИЦ. Категория `storage`.
  if (i.customs_storage_cost_uzs > 0) {
    lines.push({
      category: "storage",
      label: "Таможенное хранение (из Блока 4)",
      circuit: "official",
      source: "auto",
      amount_uzs: round2(i.customs_storage_cost_uzs),
      applied_rate_type: "NONE",
      is_included_in_cost: true,
      is_creditable_vat: false,
      is_locked: true,
      scaling: "per_unit",
      order_index: 94,
    });
  }

  // ─── 14. Сертификация НАЛ (Phase 15.18) ─────────────────────────────────
  // Не-официальные сертификационные расходы, оплачены налом. НАЛ-контур,
  // та же категория `certification` (контур различает ОФИЦ ↔ НАЛ).
  if (i.certification_cash_uzs > 0) {
    lines.push({
      category: "certification",
      label: "Сертификация налом (из Блока 4)",
      circuit: "cash",
      source: "auto",
      amount_uzs: round2(i.certification_cash_uzs),
      applied_rate_type: "NONE",
      is_included_in_cost: true,
      is_creditable_vat: false,
      is_locked: true,
      scaling: "per_unit",
      order_index: 96,
    });
  }

  // ─── 15. Таможенные расходы НАЛ (Phase 15.18, авто с Phase 15.24) ───────
  // Phase 15.24: формула 50$ × rate_conversion (фикс. ставка на любую технику).
  // Категория `other` (понятный label).
  if (i.customs_cash_uzs > 0) {
    lines.push({
      category: "other",
      label: "Таможенные расходы налом (50$ × курс конвертации)",
      circuit: "cash",
      source: "auto",
      amount_uzs: round2(i.customs_cash_uzs),
      applied_rate_type: "CONVERSION",
      is_included_in_cost: true,
      is_creditable_vat: false,
      is_locked: true,
      scaling: "per_unit",
      order_index: 98,
    });
  }

  // ─── 16. Брокерские услуги НАЛ (Phase 15.24) ────────────────────────────
  // Авто-формула 50$ × rate_conversion. Категория `broker` с circuit='cash'
  // (отличается от brokerage ОФИЦ — у того circuit='official').
  if (i.broker_cash_uzs > 0) {
    lines.push({
      category: "broker",
      label: "Брокерские услуги налом (50$ × курс конвертации)",
      circuit: "cash",
      source: "auto",
      amount_uzs: round2(i.broker_cash_uzs),
      applied_rate_type: "CONVERSION",
      is_included_in_cost: true,
      is_creditable_vat: false,
      is_locked: true,
      scaling: "per_unit",
      order_index: 99,
    });
  }

  return lines;
}

// ════════════════════════════════════════════════════════════════════════════
// АГРЕГАЦИЯ СЕБЕСТОИМОСТИ
// ════════════════════════════════════════════════════════════════════════════

/**
 * Группирует строки по контурам и считает агрегаты.
 *
 * Применяет qty-масштабирование:
 *   per_unit строка × qty
 *   per_batch — сумма как есть
 */
export function aggregateCosts(lines: ExpenseLine[], qty: number): CostAggregates {
  let costOff = 0;
  let costCash = 0;
  let vatCustoms = 0;
  let importVatBase = 0;

  for (const l of lines) {
    const multiplier = l.scaling === "per_unit" ? qty : 1;
    const total = l.amount_uzs * multiplier;

    if (l.is_included_in_cost) {
      if (l.circuit === "official") costOff += total;
      else costCash += total;
    }

    // НДС таможни выделяем отдельно (для расчёта VAT_TO_PAY_GNI)
    if (l.category === "vat_customs") {
      vatCustoms = total;
    }

    // IMPORT_VAT_BASE = база + пошлина + акциз + доп.пошлина (без НДС-таможни)
    if (["customs_base", "duty", "excise", "extra_duty"].includes(l.category)) {
      importVatBase += total;
    }
  }

  return {
    cost_official_uzs: round2(costOff),
    cost_cash_uzs: round2(costCash),
    cost_ddp_official_uzs: round2(costOff), // НДС-таможня НЕ в себестоимости
    cost_ddp_total_uzs: round2(costOff + costCash),
    vat_customs_uzs: round2(vatCustoms),
    import_vat_base_uzs: round2(importVatBase),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// РАСЧЁТ СЦЕНАРИЯ ПРОДАЖИ
// ════════════════════════════════════════════════════════════════════════════

/**
 * Полный расчёт сценария продажи на основе цены с НДС.
 * Включает: реверс-расчёт, ст. 248 ч.5 НК, P&L (ОФИЦ + ФАКТ), бонус.
 *
 * Если в сценарии задан per-scenario bonus_rate (Phase 15.18) — используется он,
 * иначе fallback на estimation-level salesperson_bonus_rate.
 */
export function calculateScenario(
  salePriceWithVatUzs: number,
  costs: Pick<
    CostAggregates,
    "cost_ddp_official_uzs" | "cost_cash_uzs" | "vat_customs_uzs" | "import_vat_base_uzs"
  >,
  inputs: Pick<
    EstimationInputs,
    "vat_sale_rate" | "corporate_tax_rate" | "admin_expenses_rate" | "salesperson_bonus_rate"
  >,
  scenarioBonusRate?: number | null,
): ScenarioResult {
  // ─── Реверс-расчёт ────────────────────────────────────────────────────────
  const salePriceNoVat = round2(salePriceWithVatUzs / (1 + inputs.vat_sale_rate));
  const vatOutput = round2(salePriceWithVatUzs - salePriceNoVat);

  // ─── Маржа ────────────────────────────────────────────────────────────────
  const grossProfitOfficial = round2(salePriceNoVat - costs.cost_ddp_official_uzs);
  const markupPct =
    costs.cost_ddp_official_uzs > 0 ? round4(grossProfitOfficial / costs.cost_ddp_official_uzs) : 0;

  // ─── Ст. 248 ч.5 НК — доплата НДС если выручка ниже импортной НДС-базы ───
  const vatExtraBase = Math.max(0, costs.import_vat_base_uzs - salePriceNoVat);
  const vatExtraPayment = round2(vatExtraBase * inputs.vat_sale_rate);

  // ─── НДС к уплате в ГНИ ──────────────────────────────────────────────────
  const vatToPayRaw = vatOutput + vatExtraPayment - costs.vat_customs_uzs;
  const vatToPayGni = Math.max(0, round2(vatToPayRaw));

  // ─── ADM и налог на прибыль (только с офиц.) ─────────────────────────────
  const adminExpenses = round2(salePriceWithVatUzs * inputs.admin_expenses_rate);
  const profitBeforeTax = round2(grossProfitOfficial - adminExpenses);
  const corporateTax = round2(Math.max(0, profitBeforeTax) * inputs.corporate_tax_rate);
  const netProfitOfficial = round2(profitBeforeTax - corporateTax);

  // ─── Фактическая прибыль (минус НАЛ-расходы) ─────────────────────────────
  // Здесь cost_cash_uzs — наличные расходы по логистике/сертификации.
  // Бонус продавца (тоже выдаётся налом) считается ниже отдельно и вычитается
  // из owner_take_home отдельно — это пост-показатель распределения прибыли.
  const netProfitTotal = round2(netProfitOfficial - costs.cost_cash_uzs);

  // ─── Бонус продавца ───────────────────────────────────────────────────────
  // Phase 15.18 revision (2026-05-17): по уточнению владельца — база бонуса
  // = net_profit_TOTAL (ФАКТ), НЕ OFFICIAL. Раньше считали от ОФИЦ, но это
  // не отражало реальный вклад продавца: НАЛ-расходы (cert_cash, customs_cash,
  // refund/overpay при покупке) — это часть фактической прибыли, и продавец
  // получает % именно от той суммы, которая остаётся у владельца до бонуса.
  //
  // Per-scenario bonus_rate (если задана). Для авто-сценариев min/mid/std
  // bonus_rate = profit_margin (3%/6%/10% от прибыли). Для custom — fallback
  // на глобальную salesperson_bonus_rate.
  const effectiveBonusRate = scenarioBonusRate ?? inputs.salesperson_bonus_rate;
  const salespersonBonus = round2(Math.max(0, netProfitTotal) * effectiveBonusRate);

  // ─── Владелец ────────────────────────────────────────────────────────────
  const ownerTakeHome = round2(netProfitTotal - salespersonBonus);

  return {
    sale_price_with_vat_uzs: round2(salePriceWithVatUzs),
    sale_price_no_vat_uzs: salePriceNoVat,
    vat_output_uzs: vatOutput,
    vat_extra_payment_uzs: vatExtraPayment,
    vat_to_pay_gni_uzs: vatToPayGni,
    gross_profit_official_uzs: grossProfitOfficial,
    admin_expenses_uzs: adminExpenses,
    profit_before_tax_uzs: profitBeforeTax,
    corporate_tax_uzs: corporateTax,
    net_profit_official_uzs: netProfitOfficial,
    net_profit_total_uzs: netProfitTotal,
    salesperson_bonus_uzs: salespersonBonus,
    owner_take_home_uzs: ownerTakeHome,
    markup_pct: markupPct,
    is_profitable_official: netProfitOfficial >= 0,
    is_profitable_total: netProfitTotal >= 0,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// ПОДБОР ЦЕНЫ
// ════════════════════════════════════════════════════════════════════════════

/**
 * Подбирает цену реализации с НДС, при которой `net_profit_official_uzs ≈ 0`
 * (граница безубыточности по бухгалтерии).
 */
export function computeBreakevenSalePrice(
  costDdpOfficial: number,
  vatSaleRate: number,
  adminRate: number,
): number {
  const factor = 1 / (1 + vatSaleRate) - adminRate;
  if (factor <= 0) return 0;
  return round2(costDdpOfficial / factor);
}

/**
 * Phase 15.18 (revised): подбирает цену реализации с НДС, при которой
 * `net_profit_official_uzs = targetNetProfitPct × cost_ddp_official`.
 *
 * Используется для авто-генерации 3 сценариев (min/mid/std) с целевой
 * прибылью X% от себестоимости товара.
 *
 * Алгебра:
 *   Хотим: net_profit_off = X × cost
 *   net = profit_before_tax × (1 − tax_rate)
 *   ⇒ profit_before_tax = X × cost / (1 − tax_rate)
 *   profit_before_tax = gross − admin = (sale_no_vat − cost) − admin_rate × sale_with_vat
 *   sale_no_vat = sale_with_vat / (1 + vat_rate)
 *
 *   sale_with_vat × [1/(1+vat) − admin_rate] − cost = X × cost / (1 − tax_rate)
 *   sale_with_vat = cost × [X/(1 − tax_rate) + 1] / [1/(1+vat) − admin_rate]
 */
export function computeSalePriceForTargetNetProfit(
  costDdpOfficial: number,
  targetNetProfitPct: number, // 0.03 / 0.06 / 0.10
  vatSaleRate: number, // 0.12
  adminRate: number, // 0.014
  corporateTaxRate: number, // 0.15
): number {
  const factor = 1 / (1 + vatSaleRate) - adminRate;
  if (factor <= 0) return 0;
  const numerator = targetNetProfitPct / (1 - corporateTaxRate) + 1;
  return round2((costDdpOfficial * numerator) / factor);
}

/**
 * Сажает цену сценария на ровное число БЕЗ НДС.
 *
 * ЗАЧЕМ. Подбор целевой прибыли даёт сырую цену вида 1 296 539 338,45 с НДС —
 * то есть 1 157 624 409,33 без НДС. Обе цифры некруглые, и в КП такую цену
 * ставить нельзя: она выглядит как результат работы калькулятора, а не как
 * названная владельцем цена, и первым же вопросом клиента будет «откуда
 * копейки».
 *
 * Ровняем именно сторону БЕЗ НДС, потому что это и есть наши деньги: НДС
 * сверху — транзит в бюджет, он не наш ни на копейку. Владелец думает и
 * торгуется в суммах без НДС, а «сколько платить» считается из них.
 *
 * Обе цифры ровными не будут никогда: множитель 1,12 переводит круглое в
 * круглое только при шаге, кратном 25 (1 158 млн × 1,12 = 1 296,96 млн).
 * Выбор поэтому не «какую из двух округлить», а «какая из двух главная», и
 * главная — та, что остаётся у нас.
 *
 * mode="up" по умолчанию: цену подбирали под целевую прибыль, и опускать её
 * ниже цели ради красоты числа — терять маржу молча. Вверх — всегда в нашу
 * сторону. "nearest" оставлен на случай, когда важнее не отходить от цели.
 */
export function roundSalePriceToNoVatStep(
  salePriceWithVatUzs: number,
  vatSaleRate: number,
  stepUzs = 1_000_000,
  mode: "up" | "nearest" = "up",
): { sale_price_no_vat_uzs: number; sale_price_with_vat_uzs: number } {
  const noVatRaw = salePriceWithVatUzs / (1 + vatSaleRate);
  if (!(stepUzs > 0) || !Number.isFinite(noVatRaw)) {
    return {
      sale_price_no_vat_uzs: round2(noVatRaw),
      sale_price_with_vat_uzs: round2(salePriceWithVatUzs),
    };
  }
  const steps = mode === "up" ? Math.ceil(noVatRaw / stepUzs) : Math.round(noVatRaw / stepUzs);
  const noVat = steps * stepUzs;
  return {
    sale_price_no_vat_uzs: noVat,
    // Считаем «с НДС» из ровной цены без НДС, а не наоборот — иначе
    // calculateScenario обратным делением вернёт не то ровное число.
    sale_price_with_vat_uzs: round2(noVat * (1 + vatSaleRate)),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// АВТО-ФОРМУЛЫ БЛОКА 4 (донор: apps/api/src/calculator.ts)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Phase 15.24: авто-формула НАЛ-расходов (Блок 4).
 * Единая ставка для всех типов техники:
 *   customs_cash = 50 USD × rate_conversion
 *   broker_cash  = 50 USD × rate_conversion
 * Это стандартизированные неофициальные платежи (доплата за ускорение
 * оформления + доплата брокеру налом).
 */
export function computeCashFees(rate_conversion: number): {
  customs_cash_uzs: number;
  broker_cash_uzs: number;
} {
  if (!rate_conversion || rate_conversion <= 0) {
    return { customs_cash_uzs: 0, broker_cash_uzs: 0 };
  }
  const amount = Math.round(50 * rate_conversion * 100) / 100;
  return { customs_cash_uzs: amount, broker_cash_uzs: amount };
}

/**
 * Phase 15.23: авто-формула брокерских услуг (ОФИЦ).
 * Единая ставка для всех типов техники:
 *   broker = max(invoice × 0.1% × ИМ74, 2×БРВ)
 *          + max(база-ГТД × 0.1% × ИМ40, 2×БРВ)
 * Каждая половина — 0.1% от соответствующей суммы, минимум 2 БРВ.
 * Результат подаётся в `EstimationInputs.broker_cost_uzs`.
 */
export function computeBrokerCostUzs(input: {
  invoice_price_usd: number;
  customs_base_usd: number;
  rate_im40: number;
  rate_im74: number;
  brv_value_uzs: number;
}): number {
  const minFee = 2 * input.brv_value_uzs;
  const partInvoice =
    input.invoice_price_usd > 0 && input.rate_im74 > 0
      ? Math.max(input.invoice_price_usd * 0.001 * input.rate_im74, minFee)
      : 0;
  const partCustoms =
    input.customs_base_usd > 0 && input.rate_im40 > 0
      ? Math.max(input.customs_base_usd * 0.001 * input.rate_im40, minFee)
      : 0;
  return Math.round((partInvoice + partCustoms) * 100) / 100;
}

// ════════════════════════════════════════════════════════════════════════════
// ОКРУГЛЕНИЯ — дословно из донора
// ════════════════════════════════════════════════════════════════════════════

/**
 * Округление до копеек (тийин) через Math.round — ДОСЛОВНО как в доноре.
 * Паритет с Excel-эталоном достигнут на этой арифметике (включая
 * float-артефакты вида round2(1.005) = 1) — менять на decimal нельзя.
 */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Округление долей (маржа) до 4 знаков — дословно из донора. */
export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Формат суммы для label утиль-сбора (донор: Intl ru-RU). */
function formatUzs(n: number): string {
  return new Intl.NumberFormat("ru-RU").format(n) + " UZS";
}
