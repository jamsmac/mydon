import { core, CoreUnavailable, type StockCountRow, type StockCountsReport } from "../lib/core";
import { CoreDown } from "./core-down";
import { ReportWindow } from "./report-window";
import { COVERED_BY_STOCK_HISTORY, ReportWarnings } from "./report-warnings";
import { count, day, plural, when } from "../lib/format";

/**
 * Окна листа — ровно те, которые сервер отдаёт ЦЕЛИКОМ: 730 — его потолок
 * (`STOCK_COUNTS_DAYS_MAX`), 90 — его дефолт. Кнопка над окном, которое ядро
 * молча зажмёт, — это подпись, не совпадающая с числами (R-H-5).
 */
export const STOCK_HISTORY_WINDOWS = [30, 90, 365, 730] as const;

const TAB = "reports:stock_history";

export interface StockHistoryGroup {
  source: string;
  note: string | null;
  rows: StockCountRow[];
}
export interface StockHistoryDay {
  dt: string;
  groups: StockHistoryGroup[];
}

/**
 * Сутки вниз, внутри суток — по паре (источник, пометка).
 *
 * Сортировка суток ЯВНАЯ, а не «в порядке прихода»: Core отдаёт строки по
 * `counted_at desc` (`vending.service.ts`), и пересчёт, введённый сегодня за
 * июнь, приехал бы первым — июньская группа разорвалась бы на две.
 */
export function groupStockCounts(rows: readonly StockCountRow[]): StockHistoryDay[] {
  const поДням = new Map<string, Map<string, StockHistoryGroup>>();
  for (const r of rows) {
    const сутки = поДням.get(r.dt) ?? new Map<string, StockHistoryGroup>();
    поДням.set(r.dt, сутки);
    const ключ = `${r.source}|${r.note ?? ""}`;
    const группа = сутки.get(ключ) ?? { source: r.source, note: r.note, rows: [] };
    группа.rows.push(r);
    сутки.set(ключ, группа);
  }
  return [...поДням.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([dt, сутки]) => ({ dt, groups: [...сутки.values()] }));
}

/**
 * Что значит пометка — ЗАВИСИТ ОТ ИСТОЧНИКА (R-H-2). У `own` это ЧЕЛОВЕК
 * (`ingestStock` пишет в `note` актора), у `stock-import` — МЕСТО донора
 * («2 Холодильник»). Общий заголовок «место» поставил бы имя оператора в
 * колонку склада, и владелец завёл бы «Рустам» в справочник локаций.
 */
function видПометки(source: string): string {
  return source === "stock-import" ? "место" : "кто считал";
}

export function StockHistoryTables({ report }: { report: StockCountsReport }) {
  const дни = groupStockCounts(report.rows);
  const пусто = report.rows.length === 0;
  const фильтр = report.product;

  return (
    <>
      <p className="lead">
        {`Пересчёты склада за ${count(report.days)} дн. · с ${day(report.since)} · ${count(report.rows.length)} ${plural(report.rows.length, "строка", "строки", "строк")}`}
        {фильтр ? ` · товар «${фильтр}»` : ""}
      </p>

      {пусто ? (
        фильтр ? (
          // По ЗАДАННОМУ товару Core уже сказал словами (`stock_missing`), и
          // лист его не дублирует: одну причину владелец читает один раз.
          <div className="empty">
            <b>По этому товару истории нет</b>
            {"Причина — ниже, в «Посчитано не всё»: чаще всего дело в имени, а не в складе."}
          </div>
        ) : (
          <div className="empty">
            <b>Инвентаризаций за окно нет</b>
            {"Пересчёты копятся сами: их пишет бот («склад …») и панель — история появится после первого счёта."}
          </div>
        )
      ) : (
        дни.map((d) => (
          <div key={d.dt}>
            <div className="section-title">{day(d.dt)}</div>
            {d.groups.map((g) => (
              <div key={`${g.source}|${g.note ?? ""}`}>
                <div className="t">
                  <b>{g.note ?? "без пометки"}</b>
                  <small>{видПометки(g.source)}</small>
                </div>
                <div className="rows">
                  {g.rows.map((r) => (
                    <div className="row" key={`${r.countedAt}|${r.product}`}>
                      <div className="t">
                        <b>{r.product}</b>
                        <small>{when(r.countedAt)}</small>
                      </div>
                      <span className="pill">{`${count(r.qty)} шт`}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))
      )}

      <ReportWarnings warnings={report.warnings} covered={COVERED_BY_STOCK_HISTORY} />
    </>
  );
}

/**
 * Лист «История склада»: один поход в ядро, окно — из адреса (`?days=`),
 * фильтр по товару — из общего поля поиска страницы (`?q=`).
 *
 * Смена окна СБРАСЫВАЕТ фильтр: `ReportWindow` строит ссылки только с `?days=`,
 * как на всех трёх листах П5b. Расширять общий переключатель ради одного листа
 * — вне охвата среза (R-H-1); поведение одинаково у всех отчётов, и именно
 * поэтому оно не сюрприз.
 */
export async function StockHistoryView({ domain, days, q }: { domain: string; days: number; q: string }) {
  const товар = q.trim();
  let report: StockCountsReport;
  try {
    report = await core.vendingStockCounts(days, товар === "" ? undefined : товар);
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }
  return (
    <>
      <ReportWindow domain={domain} tab={TAB} days={days} windows={STOCK_HISTORY_WINDOWS} />
      <StockHistoryTables report={report} />
    </>
  );
}
