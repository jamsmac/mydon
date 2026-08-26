import { placeFromImportNote } from "@mydon/shared";
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
 * («Холодильник»). Общий заголовок «место» поставил бы имя оператора в
 * колонку склада, и владелец завёл бы «Рустам» в справочник локаций.
 */
function видПометки(source: string): string {
  return source === "stock-import" ? "место" : "кто считал";
}

/**
 * Заголовок группы — то, что владелец читает как ОТВЕТ, а не служебная строка.
 *
 * В `note` импортированной строки лежит вся пометка целиком («импорт истории
 * mydon-stock · место: Холодильник»): API отдаёт данные сырыми, и правильно
 * делает. Но заголовком тут стоит имя МЕСТА, поэтому префикс снимает
 * `placeFromImportNote` — обратная к той самой функции, что пометку и писала
 * (`packages/shared/src/stock-history.ts`). Своей копии префикса витрина не
 * заводит: разъехавшись, копия молча перестала бы сокращать заголовки.
 *
 * Не разобралось — печатаем `note` КАК ЕСТЬ. Импорт без места («импорт истории
 * mydon-stock» без хвоста) — законный случай, и подставлять вместо него
 * «Основной склад» значило бы выдумать место, которого в данных нет.
 */
function заголовокГруппы(g: StockHistoryGroup): string {
  if (g.note === null) return "без пометки";
  if (g.source !== "stock-import") return g.note;
  return placeFromImportNote(g.note) ?? g.note;
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
                {/* `.rcard-h` — единственный заголовок «имя + подпись справа»,
                    объявленный в `globals.css` ВНЕ `.row` (`:325-327`). Голый
                    `.t` там существует только как `.row .t`, то есть вне строки
                    не даёт ничего; `.section-title` не годится — его
                    `text-transform: uppercase` сделал бы из «Рустам» «РУСТАМ». */}
                <div className="rcard-h" style={{ margin: "14px 0 8px" }}>
                  <span className="t">{заголовокГруппы(g)}</span>
                  <span className="ts">{видПометки(g.source)}</span>
                </div>
                <div className="rows">
                  {/* Индекс в ключе не украшение: у импортированных строк
                      `counted_at` — полдень тех же суток (`noonAt(dt)`), и две
                      строки одного дня/товара/места дали бы React дубль ключа. */}
                  {g.rows.map((r, i) => (
                    <div className="row" key={`${r.countedAt}|${r.product}|${i}`}>
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
 * фильтр по товару — из адреса же (`?q=`), и поле для него лист рисует САМ.
 *
 * Своя форма, а не общее поле страницы: общего поля у страницы нет вовсе —
 * поиск рисуют книги (`ListShell` при `searchHrefBase`), а лист отчёта книгой
 * не является. Без формы ветка «По этому товару истории нет» и весь смысл
 * `COVERED_BY_STOCK_HISTORY` включались бы только руками собранным адресом.
 *
 * Форма ОКНО СОХРАНЯЕТ (скрытое `days`), а `ReportWindow` фильтр СБРАСЫВАЕТ:
 * его ссылки несут только `?days=`, как на всех трёх листах П5b. Расширять
 * общий переключатель ради одного листа — вне охвата среза (R-H-1); поведение
 * одинаково у всех отчётов, и именно поэтому оно не сюрприз.
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
      <form className="search" action={`/domain/${domain}`} method="get">
        <input type="hidden" name="tab" value={TAB} />
        <input type="hidden" name="days" value={days} />
        <input
          type="search"
          name="q"
          defaultValue={товар}
          placeholder="Товар — как его называет прайс или автомат…"
          aria-label="Фильтр истории по товару"
        />
        <button className="btn" type="submit" style={{ flex: "none", padding: "0 18px" }}>
          Найти
        </button>
      </form>
      <StockHistoryTables report={report} />
    </>
  );
}
