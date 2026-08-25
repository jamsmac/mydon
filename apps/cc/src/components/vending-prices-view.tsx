import {
  core,
  CoreUnavailable,
  type MonthlyPrice,
  type PriceChange,
  type PriceChangesReport,
  type PriceGapReport,
} from "../lib/core";
import { CoreDown } from "./core-down";
import { ReportWindow } from "./report-window";
import { amount, count, day, month, percent, plural } from "../lib/format";

/** Окна ленты изменений. Ядро зажимает своё (1..180). */
export const PRICE_WINDOWS = [30, 90, 180] as const;

/**
 * Окно факта витрины для сравнения с эталоном — СВОЁ и короткое (R-P5b-6).
 *
 * Оно не следует за переключателем листа нарочно: эталон отвечает на вопрос
 * «почём продаём сейчас», и средняя за полгода на него не похожа.
 */
export const PRICE_GAP_DAYS = 14;

const TAB = "reports:prices";

/** Отчёт листа: лента изменений плюс донорская динамика по месяцам (R-P5b-5). */
export type PricesReport = PriceChangesReport & { monthly: MonthlyPrice[] };

/** Строка перехода цены: откуда, куда, когда и на сколько процентов. */
function ChangeRow({ c }: { c: PriceChange }) {
  return (
    <div className="row">
      <div className="t">
        <b>{c.product}</b>
        <small>{`${day(c.at)} · ${count(c.from)} → ${count(c.to)} сум`}</small>
      </div>
      <span className="pill">{`${c.pct > 0 ? "+" : ""}${percent(c.pct)}`}</span>
    </div>
  );
}

function Changes({ rows, empty }: { rows: readonly PriceChange[]; empty: string }) {
  if (rows.length === 0) return <p className="muted">{empty}</p>;
  return (
    <div className="rows">
      {rows.map((c) => (
        <ChangeRow key={`${c.product}|${c.at}|${c.from}`} c={c} />
      ))}
    </div>
  );
}

/**
 * Лист «Цены» (П5b, R-P5b-5, R-P5b-6): три блока одним экраном.
 *
 * 1. Изменения — две ленты: закупочные (события бота и приёмки) и витринные
 *    (переходы цены дня `amount/qty` день-к-дню).
 * 2. Витрина против эталона — факт против слова владельца
 *    (`vending_product.sale_price`). Товары без эталона идут отдельным
 *    списком, а НЕ нулевой строкой: `эталон 0` дал бы разрыв в 100 %.
 * 3. Динамика по месяцам — донорский срез, живёт только в панели: в боте
 *    такая таблица не читается.
 *
 * `gap === null` — «не спросили/не ответили», и это НЕ «разрывов нет»:
 * пропавшая секция читалась бы как сошедшийся отчёт.
 */
export function PricesTables({ report, gap }: { report: PricesReport; gap: PriceGapReport | null }) {
  return (
    <>
      <p className="lead">
        {`Снек-автоматы (OurVend) · изменения за ${count(report.days)} дн. · порог ${percent(report.pct)}`}
      </p>

      <div className="section-title">Изменения закупочных цен</div>
      <Changes rows={report.purchase} empty={`закупочные цены за ${count(report.days)} дн. не менялись`} />

      <div className="section-title">Изменения витринных цен</div>
      <Changes rows={report.retail} empty={`витринные цены за ${count(report.days)} дн. не менялись`} />

      <div className="section-title">Витрина против эталона</div>
      {gap === null ? (
        <p className="muted">Не проверили — Core не ответил</p>
      ) : (
        <>
          <p className="hint">
            {`Факт витрины за ${count(gap.days)} дн. против эталона владельца · порог ${percent(gap.pct)}`}
          </p>
          {gap.rows.length === 0 ? (
            <p className="muted">Разрывов за порогом нет — витрина держится эталона</p>
          ) : (
            <>
              <div className="rows">
                {gap.rows.map((g) => (
                  <div className="row" key={g.product}>
                    <div className="t">
                      <b>{g.product}</b>
                      <small>{`факт ${count(g.fact)} · эталон ${count(g.reference)} · ${count(g.qty)} шт · ${percent(g.gapPct)}`}</small>
                    </div>
                    {/* Недобор — деньги, которых не собрали. «Продали дороже
                        эталона» деньгами не считаем и против недобора не
                        зачитываем: это повод перепроверить эталон. */}
                    {g.action === "raise" ? (
                      <span className="pill bad">{`недобор ${amount(g.lost)}`}</span>
                    ) : (
                      <span className="pill">дороже эталона — проверить эталон</span>
                    )}
                  </div>
                ))}
              </div>
              <p className="muted">{`Итого недобор ≈ ${amount(gap.lostTotal)}`}</p>
            </>
          )}
          {gap.noReference.length > 0 && (
            <p className="muted">
              {`У ${count(gap.noReference.length)} ${plural(gap.noReference.length, "товара", "товаров", "товаров")} эталон не задан — сравнивать не с чем: ${gap.noReference.join(", ")}`}
            </p>
          )}
        </>
      )}

      <div className="section-title">Динамика по месяцам</div>
      {report.monthly.length === 0 ? (
        <p className="muted">Помесячной истории пока нет</p>
      ) : (
        <div className="rows">
          {report.monthly.map((m) => (
            <div className="row" key={`${m.product}|${m.month}`}>
              <div className="t">
                <b>{m.product}</b>
                {/* «—» вместо нуля: месяц без продаж или без приходов — это
                    «не считали», а не «цена упала до нуля». */}
                <small>
                  {`${month(m.month)} · витрина ${m.retail === null ? "—" : count(m.retail)} · закуп ${m.purchase === null ? "—" : count(m.purchase)}`}
                </small>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Лист «Цены»: два похода в ядро.
 *
 * Разрыв с эталоном уходит ОТДЕЛЬНЫМ запросом и ВМЕСТЕ с лентой изменений —
 * тем же приёмом, что усушка на вкладке «Снек»: у него своё окно и свои
 * причины упасть, а лента изменений обязана открыться без него.
 */
export async function VendingPricesView({ domain, days }: { domain: string; days: number }) {
  const разрыв: Promise<PriceGapReport | null> = core.vendingPriceGap(PRICE_GAP_DAYS).catch(() => null);
  let report: PricesReport;
  try {
    report = await core.vendingPriceChanges(days);
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }
  return (
    <>
      <ReportWindow domain={domain} tab={TAB} days={days} windows={PRICE_WINDOWS} />
      <PricesTables report={report} gap={await разрыв} />
    </>
  );
}
