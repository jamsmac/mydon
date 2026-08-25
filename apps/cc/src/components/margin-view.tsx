import { core, CoreUnavailable, type MarginProduct, type MarginReport } from "../lib/core";
import { CoreDown } from "./core-down";
import { ReportWindow } from "./report-window";
import { amount, count, day, percent } from "../lib/format";

/** Окна расчёта маржи. Ядро зажимает своё (1..90) независимо от панели. */
export const MARGIN_WINDOWS = [7, 30, 90] as const;

/** Ключ вкладки листа — он же адрес: панель и переключатель окон берут его отсюда. */
const TAB = "reports:margin";

/**
 * Строка «товар в разрезе»: и внутри автомата, и в своде по парку.
 *
 * Штуки без себестоимости показаны ОТДЕЛЬНОЙ пилюлей, а не спрятаны в марже:
 * их выручка в строке есть, а закуп по ним не начислен, поэтому маржа строки
 * завышена ровно на эту выручку (R-P5b-2). Молчать об этом — врать в плюс.
 */
function ProductRow({ p }: { p: MarginProduct }) {
  return (
    <div className="row">
      <div className="t">
        <b>{p.product}</b>
        <small>{`${count(p.qty)} шт · выручка ${amount(p.revenue)} · закуп ${amount(p.cogs)}`}</small>
      </div>
      {p.unknownUnits > 0 && <span className="pill bad">{`${count(p.unknownUnits)} шт без цены`}</span>}
      {p.low && <span className="pill bad">{p.margin < 0 ? "⚠️ убыток" : "⚠️ низкая маржа"}</span>}
      <span className="pill">{`${amount(p.margin)} · ${percent(p.pct)}`}</span>
    </div>
  );
}

/**
 * Лист «Маржа» (П5b, R-P5b-3) — витрина готового отчёта, без единой формулы.
 *
 * Считает ядро по проданному: выручка из `sale`, себестоимость из прайса или
 * накладных. Панель не пересчитывает ничего, иначе её число разъехалось бы с
 * ботом и недельной сводкой — а это одно и то же число.
 *
 * Кофе здесь нет и не будет (R-P5b-9): `coffee_sale` пуст, и отчёт честно
 * называет себя «снек-автоматы (OurVend)», а не «нет данных по кофе».
 */
export function MarginTables({ report }: { report: MarginReport }) {
  // Ноль автоматов — это НЕ «маржа ноль». Считать было не по чему: сбор мог
  // лежать весь период, или все автоматы оказались не в строю. Нули в такой
  // ситуации читаются как «всё посчитано и всё по нулям» (R-P5b-7 §7).
  const нетДанных = report.machines.length === 0;

  return (
    <>
      <p className="lead">
        {`Снек-автоматы (OurVend) · ${day(report.from)} — ${day(report.to)}`}
        {!нетДанных &&
          ` · ${count(report.totals.qty)} шт · выручка ${amount(report.totals.revenue)} · закуп ${amount(report.totals.cogs)}`}
      </p>

      {/* Подпись под заголовком объясняет термин: «маржа» без уточнения
          читается и как наценка, и как процент от закупа. Здесь это выручка
          проданного минус себестоимость проданных штук, ни заливки, ни
          остатки в неё не входят. */}
      <p className="hint">Маржа по проданному: выручка из продаж минус себестоимость проданных штук.</p>

      {нетДанных ? (
        <div className="empty">
          <b>Данных нет</b>
          {`Ни одного снек-автомата в отчёте — продаж за ${count(report.days)} дн. нет`}
        </div>
      ) : (
        <p className="lead">
          {"Маржа "}
          <b>{amount(report.totals.margin)}</b>
          {` · ${percent(report.totals.pct)} · порог низкой ${count(report.lowPct)} %`}
        </p>
      )}

      {/* Завышение маржи называется вслух и числом: сколько штук прошло без
          себестоимости и какие это товары. Иначе итог выглядит честным. */}
      {report.unknownUnits > 0 && (
        <p className="muted">
          {`⚠️ ${count(report.unknownUnits)} шт без себестоимости — выручка по ним в отчёте есть, закуп не начислен, маржа на столько завышена: ${report.unknownProducts.join(", ")}`}
        </p>
      )}

      {report.machines.map((m) => (
        <div className="sect" style={{ marginTop: 16 }} key={m.serial}>
          <h3 className="section-title">{`${m.name} · маржа ${amount(m.margin)} · ${percent(m.pct)}`}</h3>
          <p className="muted">{`${count(m.qty)} шт · выручка ${amount(m.revenue)} · закуп ${amount(m.cogs)}`}</p>
          <div className="rows">
            {m.products.map((p) => (
              <ProductRow key={p.product} p={p} />
            ))}
          </div>
        </div>
      ))}

      {report.products.length > 0 && (
        <>
          <div className="section-title">По товарам за период</div>
          <div className="rows">
            {report.products.map((p) => (
              <ProductRow key={p.product} p={p} />
            ))}
          </div>
        </>
      )}

      {/* Продажи с автоматов вне парка не растворяются в тишине: на проде
          склад-заглушка SKLAD 4S «продал» 1 шт Moxito. Без этой строки
          расхождение отчёта с кассой было бы необъяснимым (R-P5b-1). */}
      {report.excluded.length > 0 && (
        <>
          <div className="section-title">Продажи автоматов вне парка</div>
          <div className="rows">
            {report.excluded.map((e) => (
              <div className="row" key={e.serial}>
                <div className="t">
                  <b>{e.serial}</b>
                  <small>{`${count(e.qty)} шт · ${amount(e.amount)} · автомат «не в строю» — в маржу не вошёл`}</small>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/**
 * Лист «Маржа»: один поход в ядро за готовым отчётом.
 *
 * Окно берётся из адреса (`?days=`). Провал ядра показываем тем же экраном,
 * что и остальные листы: нули при упавшем Core — ложь, на которую можно
 * положиться.
 */
export async function MarginView({ domain, days }: { domain: string; days: number }) {
  let report: MarginReport;
  try {
    report = await core.vendingMargin(days);
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }
  return (
    <>
      <ReportWindow domain={domain} tab={TAB} days={days} windows={MARGIN_WINDOWS} />
      <MarginTables report={report} />
    </>
  );
}
