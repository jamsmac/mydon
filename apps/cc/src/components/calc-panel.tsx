"use client";

import { useMemo, useState } from "react";
import {
  aggregateCosts,
  calculateScenario,
  computeBreakevenSalePrice,
  computeBrokerCostUzs,
  computeCashFees,
  computeSalePriceForTargetNetProfit,
  generateAutoExpenseLines,
  roundSalePriceToNoVatStep,
  type EstimationInputs,
} from "@mydon/shared";
import type { BrvValue, FxCurrent, TnvedRate } from "../lib/core";

/**
 * Калькулятор цены HELI — замена Excel владельца (перенос calculator v3 PROMACH).
 * Движок — чистые функции packages/shared (golden-тесты сверены с Excel до
 * копейки), поэтому расчёт живёт прямо в браузере, без похода в Core.
 */

const nfmt = (n: number): string => Math.round(n).toLocaleString("ru-RU");

/**
 * Шаги округления целевой цены — те же 1/10/100 млн, что закреплены
 * golden-тестами roundSalePriceToNoVatStep. 0 — «не округлять»: движок сам
 * сводится к округлению до копейки (round2), без искажения сырой цены.
 */
const ROUND_STEPS = [
  { value: 0, label: "не округлять" },
  { value: 1_000_000, label: "до 1 млн" },
  { value: 10_000_000, label: "до 10 млн" },
  { value: 100_000_000, label: "до 100 млн" },
] as const;

function numOf(raw: string): number {
  const n = Number(raw.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function Field({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <label style={{ margin: 0 }}>
      <span>{label}</span>
      <input
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={hint}
      />
    </label>
  );
}

export function CalcPanel({
  rates,
  brv,
  fx,
}: {
  rates: TnvedRate[];
  brv: BrvValue[];
  fx: FxCurrent[];
}) {
  const usdRate = fx.find((r) => r.currency === "USD")?.rate ?? "";
  const brvNow = brv[0]?.valueUzs ?? "412000";

  // Входы формы — строками (свободный ввод с пробелами/запятыми), числа — на выходе.
  const [tnvedId, setTnvedId] = useState<string>(rates[0]?.id ?? "");
  const [factory, setFactory] = useState("");
  const [transport, setTransport] = useState("");
  const [invoice, setInvoice] = useState("");
  const [customsBase, setCustomsBase] = useState("");
  const [rateIm40, setRateIm40] = useState(usdRate);
  const [rateIm74, setRateIm74] = useState(usdRate);
  const [rateConv, setRateConv] = useState(usdRate);
  const [brvStr, setBrvStr] = useState(String(Number(brvNow)));
  const [engineCc, setEngineCc] = useState("");
  const [certUzs, setCertUzs] = useState("");
  const [certCash, setCertCash] = useState("");
  const [qty, setQty] = useState("1");
  const [salePrice, setSalePrice] = useState("");
  const [roundStepUzs, setRoundStepUzs] = useState<number>(1_000_000);

  const rate = rates.find((r) => r.id === tnvedId) ?? null;

  const result = useMemo(() => {
    const f = numOf(factory);
    const inv = numOf(invoice);
    const base = numOf(customsBase);
    const im40 = numOf(rateIm40);
    const im74 = numOf(rateIm74);
    const conv = numOf(rateConv);
    const brvV = numOf(brvStr);
    const q = Math.max(1, Math.round(numOf(qty)) || 1);
    if (rate === null || f <= 0 || inv <= 0 || base <= 0 || im40 <= 0) return null;

    // Авто-формулы Блока 4 донора: брокер ОФИЦ и НАЛ-фиксы 50$ × конвертация.
    const broker = computeBrokerCostUzs({
      invoice_price_usd: inv,
      customs_base_usd: base,
      rate_im40: im40,
      rate_im74: im74,
      brv_value_uzs: brvV,
    });
    const cash = computeCashFees(conv);

    const inputs: EstimationInputs = {
      factory_price_usd: f,
      transport_price_usd: numOf(transport),
      invoice_price_usd: inv,
      customs_base_usd: base,
      rate_im40: im40,
      rate_im70: im40,
      rate_im74: im74 > 0 ? im74 : im40,
      rate_conversion: conv > 0 ? conv : im40,
      bank_conversion_markup: 1.003,
      brv_value_uzs: brvV,
      duty_rate: Number(rate.importDutyRate),
      customs_fee_rate: Number(rate.customsFeeRate),
      excise_rate: Number(rate.exciseRate),
      vat_customs_rate: Number(rate.vatRate),
      util_brv_count: rate.utilizationBrvCount,
      engine_volume_cc: numOf(engineCc) > 0 ? numOf(engineCc) : null,
      engine_duty_per_cc_usd: Number(rate.extraDutyPerCcUsd),
      vat_sale_rate: 0.12,
      corporate_tax_rate: 0.15,
      admin_expenses_rate: 0.014,
      salesperson_bonus_rate: 0.08,
      premium_markup_pct: 0.1,
      certification_cost_uzs: numOf(certUzs),
      broker_cost_uzs: broker,
      customs_storage_cost_uzs: 0,
      certification_cash_uzs: numOf(certCash),
      customs_cash_uzs: cash.customs_cash_uzs,
      broker_cash_uzs: cash.broker_cash_uzs,
      qty: q,
    };

    // Валидация ТН ВЭД (Phase 15.22 донора): без объёма двигателя при
    // ненулевой $/см³ расчёт молча занизил бы пошлину — отбиваем словами.
    if (Number(rate.extraDutyPerCcUsd) > 0 && (inputs.engine_volume_cc ?? 0) <= 0) {
      return {
        error:
          "Для этого кода ТН ВЭД обязателен объём двигателя (см³) — иначе доп. пошлина занизится до нуля.",
      };
    }

    const lines = generateAutoExpenseLines(inputs);
    const costs = aggregateCosts(lines, q);
    const breakeven = computeBreakevenSalePrice(costs.cost_ddp_official_uzs, 0.12, 0.014);
    // Сырая цена подбора почти всегда некруглая (см. roundSalePriceToNoVatStep) —
    // сажаем на шаг со стороны без НДС, это и есть наши деньги; НДС сверху
    // пересчитывается уже из ровной цены, а не наоборот (иначе обратное деление
    // в calculateScenario вернёт те же копейки, ради ухода от которых всё это).
    const targets = ([0.03, 0.06, 0.1] as const).map((pct) => {
      const raw = computeSalePriceForTargetNetProfit(
        costs.cost_ddp_official_uzs,
        pct,
        0.12,
        0.014,
        0.15,
      );
      const rounded = roundSalePriceToNoVatStep(raw, 0.12, roundStepUzs);
      return {
        pct,
        priceWithVat: rounded.sale_price_with_vat_uzs,
        priceNoVat: rounded.sale_price_no_vat_uzs,
      };
    });
    const sp = numOf(salePrice);
    const scenario =
      sp > 0
        ? calculateScenario(sp, costs, {
            vat_sale_rate: 0.12,
            corporate_tax_rate: 0.15,
            admin_expenses_rate: 0.014,
            salesperson_bonus_rate: 0.08,
          })
        : null;
    return { lines, costs, breakeven, targets, scenario };
  }, [
    rate,
    factory,
    transport,
    invoice,
    customsBase,
    rateIm40,
    rateIm74,
    rateConv,
    brvStr,
    engineCc,
    certUzs,
    certCash,
    qty,
    salePrice,
    roundStepUzs,
  ]);

  return (
    <>
      <div className="sect" style={{ marginTop: 0 }}>
        <div className="sect-h">
          <h3 className="h2">Входные данные</h3>
          {usdRate === "" && <span className="chip h">курс USD не задан — впиши курсы руками</span>}
        </div>
        {rates.length === 0 ? (
          <div className="empty">
            <b>Нет ставок ТН ВЭД</b>
            Сначала заведи код на вкладке «Справочники → Растаможка» — по нему считаются пошлина,
            сбор и НДС.
          </div>
        ) : (
          <div
            className="form"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))",
              gap: 10,
            }}
          >
            <label style={{ margin: 0, gridColumn: "1 / -1" }}>
              <span>Код ТН ВЭД</span>
              <select value={tnvedId} onChange={(e) => setTnvedId(e.target.value)}>
                {rates.map((r) => (
                  <option value={r.id} key={r.id}>
                    {r.code} · {r.nameRu} · пошлина{" "}
                    {(Number(r.importDutyRate) * 100).toLocaleString("ru-RU")}%
                  </option>
                ))}
              </select>
            </label>
            <Field label="Цена завода, USD" value={factory} onChange={setFactory} hint="28 000" />
            <Field label="Транспорт, USD" value={transport} onChange={setTransport} hint="2 500" />
            <Field label="Инвойс, USD" value={invoice} onChange={setInvoice} hint="30 500" />
            <Field
              label="Таможенная база, USD"
              value={customsBase}
              onChange={setCustomsBase}
              hint="30 500"
            />
            <Field label="Курс ИМ-40" value={rateIm40} onChange={setRateIm40} hint="12 500" />
            <Field label="Курс ИМ-74" value={rateIm74} onChange={setRateIm74} hint="12 500" />
            <Field label="Курс конвертации" value={rateConv} onChange={setRateConv} hint="12 600" />
            <Field label="БРВ, сум" value={brvStr} onChange={setBrvStr} />
            <Field
              label="Объём двигателя, см³"
              value={engineCc}
              onChange={setEngineCc}
              hint="0 — электро"
            />
            <Field label="Сертификация (безнал), сум" value={certUzs} onChange={setCertUzs} />
            <Field label="Сертификация (нал), сум" value={certCash} onChange={setCertCash} />
            <Field label="Количество, шт" value={qty} onChange={setQty} />
          </div>
        )}
        <p className="hint" style={{ marginTop: 8 }}>
          Брокер ОФИЦ и НАЛ-фиксы (50$ × конвертация) считаются сами по формулам донора.
          Двухконтурная модель: ОФИЦ — бухгалтерия, ФАКТ — с наличными расходами.
        </p>
      </div>

      {result !== null && "error" in result && (
        <div className="warn">
          <b>Не хватает данных</b>
          {result.error}
        </div>
      )}

      {result !== null && !("error" in result) && (
        <>
          <div className="tiles">
            <div className="tile">
              <div className="lab">Себестоимость ОФИЦ (DDP)</div>
              <div className="v" style={{ fontSize: 20 }}>
                {nfmt(result.costs.cost_ddp_official_uzs)}
              </div>
              <div className="foot">
                <span className="mk" />
                сум · без НДС таможни (идёт в зачёт)
              </div>
            </div>
            <div className="tile">
              <div className="lab">Себестоимость ФАКТ</div>
              <div className="v" style={{ fontSize: 20 }}>
                {nfmt(result.costs.cost_ddp_total_uzs)}
              </div>
              <div className="foot">
                <span className="mk" />с наличным контуром: {nfmt(result.costs.cost_cash_uzs)} сум
              </div>
            </div>
            <div className="tile">
              <div className="lab">Безубыточность</div>
              <div className="v" style={{ fontSize: 20 }}>
                {nfmt(result.breakeven)}
              </div>
              <div className="foot">
                <span className="mk" />
                цена с НДС, при которой прибыль ОФИЦ = 0
              </div>
            </div>
            <div className="tile">
              <div className="lab">НДС таможни (зачёт)</div>
              <div className="v" style={{ fontSize: 20 }}>
                {nfmt(result.costs.vat_customs_uzs)}
              </div>
              <div className="foot">
                <span className="mk" />
                сум
              </div>
            </div>
          </div>

          <div className="sect">
            <div className="sect-h">
              <h3 className="h2">Целевые цены (прибыль % от себестоимости)</h3>
              <span className="sp" />
              <label style={{ margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
                <span className="hint" style={{ margin: 0 }}>
                  Округление цены
                </span>
                <select
                  value={roundStepUzs}
                  onChange={(e) => setRoundStepUzs(Number(e.target.value))}
                >
                  {ROUND_STEPS.map((s) => (
                    <option value={s.value} key={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="wgrid">
              {result.targets.map((t) => (
                <button
                  type="button"
                  className="wt"
                  key={t.pct}
                  style={{ cursor: "pointer", textAlign: "left" }}
                  onClick={() => setSalePrice(String(Math.round(t.priceWithVat)))}
                >
                  <div className="wl">прибыль {t.pct * 100}%</div>
                  <div className="wv" style={{ fontSize: 18 }}>
                    {nfmt(t.priceWithVat)}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--tx-3)", marginTop: 2 }}>
                    без НДС: {nfmt(t.priceNoVat)}
                  </div>
                  <div className="wf">
                    сум с НДС · нажми — посчитаю сценарий<span className="go">→</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="sect">
            <div className="sect-h">
              <h3 className="h2">Сценарий продажи</h3>
            </div>
            <div className="form" style={{ maxWidth: 360 }}>
              <Field
                label="Цена реализации с НДС, сум"
                value={salePrice}
                onChange={setSalePrice}
                hint="460 000 000"
              />
            </div>
            {result.scenario !== null && (
              <div className="pass" style={{ marginTop: 10 }}>
                {(
                  [
                    ["Без НДС", result.scenario.sale_price_no_vat_uzs],
                    ["НДС с продажи", result.scenario.vat_output_uzs],
                    ["Доплата НДС (ст. 248 ч.5)", result.scenario.vat_extra_payment_uzs],
                    ["НДС к уплате в ГНИ", result.scenario.vat_to_pay_gni_uzs],
                    ["Валовая прибыль ОФИЦ", result.scenario.gross_profit_official_uzs],
                    ["Адм. расходы (1.4%)", result.scenario.admin_expenses_uzs],
                    ["Налог на прибыль (15%)", result.scenario.corporate_tax_uzs],
                    ["Чистая прибыль ОФИЦ", result.scenario.net_profit_official_uzs],
                    ["Чистая прибыль ФАКТ", result.scenario.net_profit_total_uzs],
                    ["Бонус продавца (8% от ФАКТ)", result.scenario.salesperson_bonus_uzs],
                    ["Владельцу", result.scenario.owner_take_home_uzs],
                  ] as const
                ).map(([k, v]) => (
                  <div className="f" key={k}>
                    <small style={{ color: "var(--tx-3)" }}>{k}</small>
                    <div
                      style={{
                        fontVariantNumeric: "tabular-nums",
                        color: typeof v === "number" && v < 0 ? "var(--hot)" : undefined,
                      }}
                    >
                      {nfmt(v)} сум
                    </div>
                  </div>
                ))}
                <div className="f">
                  <small style={{ color: "var(--tx-3)" }}>Маржа</small>
                  <div>{(result.scenario.markup_pct * 100).toLocaleString("ru-RU")}%</div>
                </div>
              </div>
            )}
          </div>

          {/* ── КП по фирменному бланку (реальные образцы владельца) ── */}
          <div className="sect">
            <div className="sect-h">
              <h3 className="h2">КП по бланку GLOBERENT</h3>
            </div>
            <form method="post" action="/kp/download" className="form">
              <input type="hidden" name="priceWithVat" value={salePrice} />
              <label>
                <span>Шапка таблицы (тип · серия · модель)</span>
                <input
                  name="tableTitle"
                  placeholder="ЭЛЕКТРИЧЕСКИЙ ВИЛОЧНЫЙ ПОГРУЗЧИК  LI-ION  ·  G3 СЕРИЯ  ·  CPD 15-GB3LI-S"
                />
              </label>
              <label>
                <span>Теглайн (по центру, как в образце)</span>
                <input
                  name="tagline"
                  placeholder="Электрический вилочный погрузчик 1 500 кг · 4 500 мм"
                />
              </label>
              <label>
                <span>Абзац о модели — можно пусто</span>
                <input name="aboutModel" placeholder="В предложении представлен …" />
              </label>
              <label>
                <span>Характеристики: по строке «Ярлык | Значение»</span>
                <textarea
                  name="rows"
                  rows={6}
                  placeholder={
                    "Модель | CPD 15-GB3Li\nГрузоподъёмность, кг | 1 500\nВысота подъёма груза, мм | 4 500"
                  }
                  style={{ width: "100%", fontFamily: "var(--fm)", fontSize: 13 }}
                />
              </label>
              <label>
                <span>Номер КП — пусто, чтобы взять КП-ГГГГ/ММДД-1</span>
                <input name="kpNo" placeholder="авто" />
              </label>
              <div className="form-actions">
                <button type="submit" className="btn primary" disabled={numOf(salePrice) <= 0}>
                  Скачать КП (DOCX)
                </button>
              </div>
              <p className="hint">
                Цена с НДС берётся из сценария выше (
                {salePrice !== "" ? `${nfmt(numOf(salePrice))} сум` : "задай цену"}). Условия
                оплаты, гарантия HELI и реквизиты футера — с образцов, меняются в документе.
              </p>
            </form>
          </div>

          <div className="sect">
            <div className="sect-h">
              <h3 className="h2">Строки затрат (авто)</h3>
            </div>
            <div className="book">
              <div className="th">
                <span>Статья</span>
                <span>Контур</span>
                <span style={{ textAlign: "right" }}>Сумма, сум</span>
              </div>
              {result.lines.map((l, i) => (
                <div className="tr" key={i}>
                  <span className="nm">{l.label ?? l.category}</span>
                  <span className="cd">
                    {l.circuit === "official" ? "ОФИЦ" : "НАЛ"}
                    {l.is_included_in_cost ? "" : " · не в себестоимости"}
                  </span>
                  <span className="pr">{nfmt(l.amount_uzs)}</span>
                </div>
              ))}
            </div>
            <p className="hint" style={{ marginTop: 8 }}>
              Формулы и округления перенесены из PROMACH дословно и сверены с Excel-эталоном
              владельца до копейки (golden-тесты в packages/shared).
            </p>
          </div>
        </>
      )}
    </>
  );
}
