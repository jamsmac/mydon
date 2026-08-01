import Link from "next/link";
import {
  core,
  CoreUnavailable,
  type RawSourceState,
} from "../lib/core";
import { CoreDown } from "./core-down";
import { when } from "../lib/format";

/** Крупная сумма человеку: «18.4 млн», «232 тыс», «540». */
function compactSum(n: number): { v: string; u: string } {
  if (!Number.isFinite(n)) return { v: "—", u: "" };
  if (n >= 1_000_000) return { v: (n / 1_000_000).toFixed(1).replace(/\.0$/, ""), u: "млн" };
  if (n >= 1_000) return { v: String(Math.round(n / 1_000)), u: "тыс" };
  return { v: String(Math.round(n)), u: "" };
}

/** Цвет метки свежести отчёта. */
const FRESH: Record<string, { chip: string; label: string }> = {
  fresh: { chip: "g", label: "свежо" },
  stale: { chip: "h", label: "устарело" },
  never: { chip: "", label: "не снимали" },
};

/**
 * Экран «Отчёты» — витрина по источникам (расположение из обложки VendHub).
 *
 * Вместо «сразу сырая таблица» — дашборд: у каждого источника свои отчёты
 * карточками, у карточки главное число, свежесть и ссылки в срезы. Клик по
 * срезу открывает существующий детальный вид (журнал/цены/товары/оплата) —
 * механика та же, меняется только вход.
 *
 * Оформление текущее (тёмное) — взята структура, не палитра.
 */
export async function ReportsOverview({ base }: { base: string }) {
  let sources: RawSourceState[];
  try {
    ({ sources } = await core.rawSources());
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }

  // Операционные сводки — best-effort: их отсутствие не должно ронять витрину.
  const [sales, supply, coll] = await Promise.all([
    core.salesSummary().catch(() => null),
    core.supplySummary().catch(() => null),
    core.collectionsSummary(7).catch(() => null),
  ]);

  const allReports = sources.flatMap((s) => s.reports);
  const connected = sources.filter((s) => s.connected).length;

  // Ссылка в детальный срез отчёта: остаёмся на вкладке «Отчёты», выбираем
  // источник/отчёт и вид. Пустой view → строки (как раньше).
  const drill = (src: string, rep: string, view?: string): string => {
    const p = new URLSearchParams({ tab: "sources", src, rep });
    if (view) p.set("view", view);
    return `${base}?${p.toString()}`;
  };

  return (
    <>
      <div className="page-head" style={{ marginBottom: 12 }}>
        <h1 className="h1">Отчёты</h1>
        <p className="lead">
          {allReports.length} {allReports.length === 1 ? "отчёт" : "отчётов"} из {sources.length}{" "}
          {sources.length === 1 ? "источника" : "источников"} · новые появляются здесь сами, как
          только источник подключён
        </p>
      </div>

      {/* ── Операции оболочки: инкассация и приход (данные MYDON, не выгрузка) ── */}
      {(coll || supply || sales) && (
        <div className="rgroup">
          <div className="rgroup-h">
            <span className="dot" style={{ background: "var(--hot)" }} />
            <b>Операции оболочки</b>
            <small>инкассация · приход · продажи — по данным MYDON</small>
          </div>
          <div className="rgrid">
            {sales && (
              <div className="rcard">
                <div className="rcard-h">
                  <span className="t">Журнал продаж</span>
                  <span className="ts">{sales.lastSaleDt ? when(sales.lastSaleDt) : "нет данных"}</span>
                </div>
                <div className="big">
                  {compactSum(sales.today.amount).v}
                  <span className="u">{compactSum(sales.today.amount).u} сум за сутки</span>
                </div>
                <div className="sub">
                  <span>продаж <span className="n">{sales.today.qty}</span></span>
                  <span>за 30 дней <span className="n">{compactSum(sales.days30.amount).v} {compactSum(sales.days30.amount).u}</span></span>
                </div>
                <div className="rcard-f">
                  <span className={`chip ${sales.configured ? "g" : "h"}`}>
                    {sales.configured ? "источник настроен" : "не настроен"}
                  </span>
                  <span className="sp" />
                  <span className="rlinks">
                    <Link href={`${base}?tab=reports:sale`}>Все продажи</Link>
                  </span>
                </div>
              </div>
            )}

            {supply && (
              <div className="rcard">
                <div className="rcard-h">
                  <span className="t">Остатки в аппаратах</span>
                  <span className="ts">{supply.lastStockDt ? when(supply.lastStockDt) : "нет данных"}</span>
                </div>
                <div className="big">
                  {supply.lowPositions + supply.emptyPositions}
                  <span className="u">позиций ниже нормы</span>
                </div>
                <div className="sub">
                  <span>пустых <span className="n">{supply.emptyPositions}</span></span>
                  <span>приходов за 30 дней <span className="n">{supply.purchases30.count}</span></span>
                </div>
                <div className="rcard-f">
                  <span className={`chip ${supply.emptyPositions > 0 ? "h" : "g"}`}>
                    {supply.emptyPositions > 0 ? `${supply.emptyPositions} критично` : "в норме"}
                  </span>
                  <span className="sp" />
                  <span className="rlinks">
                    <Link href={`${base}?tab=catalog:machine_stock`}>Остатки</Link>
                  </span>
                </div>
              </div>
            )}

            {coll && (
              <div className="rcard">
                <div className="rcard-h">
                  <span className="t">Сдача наличных</span>
                  <span className="ts">за {coll.days} дней</span>
                </div>
                <div className="big">
                  {compactSum(coll.receivedSum).v}
                  <span className="u">{compactSum(coll.receivedSum).u} сдано</span>
                </div>
                <div className="sub">
                  <span>выемок принято <span className="n">{coll.receivedCount}</span></span>
                  {coll.pending > 0 && <span>в пути <span className="n">{coll.pending}</span></span>}
                </div>
                <div className="rcard-f">
                  <span className={`chip ${coll.pending > 0 ? "h" : "g"}`}>
                    {coll.pending > 0 ? `${coll.pending} в пути` : "всё принято"}
                  </span>
                  <span className="sp" />
                  <span className="rlinks">
                    <Link href={`${base}?tab=collect`}>Инкассация</Link>
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── По источникам: сырые отчёты, как их отдаёт чужая система ── */}
      {sources.length === 0 ? (
        <div className="empty" style={{ marginTop: 16 }}>
          <b>Источники не заведены</b>
          Справочник систем пуст — добавь их в packages/shared/src/sources.ts.
        </div>
      ) : (
        sources.map((s) => (
          <div className="rgroup" key={s.code}>
            <div className="rgroup-h">
              <span className="dot" style={{ background: s.connected ? "var(--ok)" : "var(--tx-3)" }} />
              <b>{s.title}</b>
              <small>{s.connected ? s.subtitle || "на связи" : "не подключён — выгрузок ещё не было"}</small>
            </div>
            {s.reports.length === 0 ? (
              <p className="hint" style={{ margin: 0 }}>Отчёты источника ещё не заведены.</p>
            ) : (
              <div className="rgrid">
                {s.reports.map((r) => {
                  const f = FRESH[r.freshness] ?? FRESH.never;
                  const orderLike = Object.keys(r.roles ?? {}).length > 0;
                  return (
                    <div className="rcard" key={r.reportCode}>
                      <div className="rcard-h">
                        <span className="t">{r.ru || r.title}</span>
                        <span className="ts">{r.lastFetchedAt ? when(r.lastFetchedAt) : "—"}</span>
                      </div>
                      <div className="big">
                        {r.rows.toLocaleString("ru-RU")}
                        <span className="u">строк в снимке</span>
                      </div>
                      <div className="sub">
                        {r.rowsTotal != null && r.rowsTotal !== r.rows && (
                          <span>всего <span className="n">{r.rowsTotal.toLocaleString("ru-RU")}</span></span>
                        )}
                        <span>снимков <span className="n">{r.snapshots}</span></span>
                        <span>колонок <span className="n">{r.columns}</span></span>
                      </div>
                      <div className="rcard-f">
                        <span className={`chip ${f.chip}`}>{f.label}</span>
                        <span className="sp" />
                        <span className="rlinks">
                          <Link href={drill(s.code, r.reportCode)}>Строки</Link>
                          {orderLike && (
                            <>
                              <Link href={drill(s.code, r.reportCode, "journal")}>Журнал</Link>
                              <Link href={drill(s.code, r.reportCode, "prices")}>Цены</Link>
                              <Link href={drill(s.code, r.reportCode, "pay")}>Оплата</Link>
                            </>
                          )}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))
      )}

      <p className="hint" style={{ marginTop: 18 }}>
        Систем на связи: {connected} из {sources.length}. Выгрузку кладёшь сам — открой отчёт и
        загрузи файлом, роли колонок назначаются там же.
      </p>
    </>
  );
}
