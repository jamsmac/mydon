import { core, CoreUnavailable, type DeadRow, type DeadStockReport } from "../lib/core";
import { CoreDown } from "./core-down";
import { ReportWindow } from "./report-window";
import { amount, count, day, plural } from "../lib/format";

/** Окна «без движения». Ядро зажимает своё; умолчание — настройка DEAD_STOCK_DAYS. */
export const DEAD_STOCK_WINDOWS = [14, 21, 30] as const;

const TAB = "reports:dead_stock";

/**
 * Строка мёртвой позиции.
 *
 * Без цены закупки показываем ШТУКИ, а не «0 сум»: ноль читался бы как
 * «лежит на ноль денег», хотя товар лежит и место занимает (R-P5b-4).
 */
function DeadRowView({ r }: { r: DeadRow }) {
  const место = r.machineName ?? r.serial;
  const подпись = [место, `${count(r.qty)} шт`, r.noPrice ? "цена закупки неизвестна" : null]
    .filter((v): v is string => v !== null && v !== undefined)
    .join(" · ");
  return (
    <div className="row">
      <div className="t">
        <b>{r.product}</b>
        <small>{подпись}</small>
      </div>
      {r.noPrice && <span className="pill bad">нет цены</span>}
      <span className="pill">{r.noPrice ? `${count(r.qty)} шт` : `≈ ${amount(r.value)}`}</span>
    </div>
  );
}

/**
 * Лист «Мёртвый сток» (П5b, R-P5b-4): что лежит с остатком и не двигалось —
 * ни продажи, ни заливки, ни приёмки — за окно.
 *
 * Склад и автоматы разделены не для красоты: флаг движения у склада глобален
 * по товару, а у автоматов — по паре (автомат, товар). Один и тот же товар
 * бойко продаётся в одном автомате и месяцами стоит в другом; общий флаг
 * спрятал бы вторую позицию.
 */
export function DeadStockTables({ report }: { report: DeadStockReport }) {
  const строк = report.warehouse.length + report.machines.length;
  const пусто = строк === 0;

  return (
    <>
      <p className="lead">
        {`Снек-автоматы (OurVend) и склад · без движения (продажи, заливки, приёмки) с ${day(report.since)}, окно ${count(report.days)} дн.`}
        {/* «Оценка 0 сум» — не оценка: так выглядит отчёт, где ни у одной
            позиции нет цены закупки. Тогда говорим прямо, что оценки нет. */}
        {!пусто && report.totalValue > 0 && " · оценка "}
        {!пусто && report.totalValue > 0 && <b>{amount(report.totalValue)}</b>}
        {!пусто && report.totalValue === 0 && " · оценки нет: цены закупки неизвестны"}
      </p>

      {report.noPriceCount > 0 && (
        <p className="muted">
          {`⚠️ ${count(report.noPriceCount)} ${plural(report.noPriceCount, "позиция", "позиции", "позиций")} без цены закупки — в оценку не вошли, считаем их в штуках`}
        </p>
      )}

      {пусто ? (
        <div className="empty">
          <b>Мёртвых позиций нет</b>
          {`За ${count(report.days)} дн. по каждой позиции с остатком было движение — продажа, заливка или приёмка.`}
        </div>
      ) : (
        <>
          <div className="section-title">На складе</div>
          {report.warehouse.length === 0 ? (
            <p className="muted">На складе мёртвых позиций нет</p>
          ) : (
            <div className="rows">
              {report.warehouse.map((r) => (
                <DeadRowView key={r.product} r={r} />
              ))}
            </div>
          )}

          <div className="section-title">В автоматах</div>
          {report.machines.length === 0 ? (
            <p className="muted">В автоматах мёртвых позиций нет</p>
          ) : (
            <div className="rows">
              {report.machines.map((r) => (
                <DeadRowView key={`${r.serial ?? ""}|${r.product}`} r={r} />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

/** Лист «Мёртвый сток»: один поход в ядро, окно — из адреса (`?days=`). */
export async function DeadStockView({ domain, days }: { domain: string; days: number }) {
  let report: DeadStockReport;
  try {
    report = await core.vendingDeadStock(days);
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }
  return (
    <>
      <ReportWindow domain={domain} tab={TAB} days={days} windows={DEAD_STOCK_WINDOWS} />
      <DeadStockTables report={report} />
    </>
  );
}
