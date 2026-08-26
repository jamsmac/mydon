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
 * Шапка группы: заголовок + подпись под ним. ОДНОЙ функцией, а не двумя —
 * заголовок и подпись зависят друг от друга (UX-1, UX-2).
 *
 * Что значит пометка — ЗАВИСИТ ОТ ИСТОЧНИКА (R-H-2). У `own` это ЧЕЛОВЕК
 * (`ingestStock` пишет в `note` актора), у `stock-import` — МЕСТО донора
 * («Холодильник»). Общий заголовок «место» поставил бы имя оператора в
 * колонку склада, и владелец завёл бы «Рустам» в справочник локаций.
 *
 * ИМПОРТ. В `note` лежит вся пометка целиком («импорт истории mydon-stock ·
 * место: Холодильник»): API отдаёт данные сырыми, и правильно делает. Но
 * заголовком тут стоит имя МЕСТА, поэтому префикс снимает
 * `placeFromImportNote` — обратная к той самой функции, что пометку и писала
 * (`packages/shared/src/stock-history.ts`). Своей копии префикса витрина не
 * заводит: разъехавшись, копия молча перестала бы сокращать заголовки.
 * Не разобралось (импорт БЕЗ места — законный случай) — печатаем «место не
 * указано». Печатать сырую пометку нельзя: имя чужого проекта в заголовке —
 * ровно то, от чего лист избавлялся; выдумывать «Основной склад» — тоже:
 * донор место не сохранил, и лист говорит именно это.
 *
 * СВОИ СТРОКИ. Сегодня в `note` у них лежит РОВНО литерал `owner`: контроллер
 * зовёт `ingestStock(dto)` без актора, бот тоже его не шлёт. Английское
 * системное слово в русской панели под подписью «кто считал» читается как имя
 * человека, которого зовут owner. Поэтому известный литерал переводится в
 * роль («владелец»), пустая пометка называет ИСТОЧНИК записи
 * («инвентаризация MYDON»), и в обоих случаях подписи «кто считал» нет вовсе:
 * она — обещание, что рядом стоит человек. Подпись возвращается ровно там,
 * где в пометке действительно имя.
 */
function шапкаГруппы(g: StockHistoryGroup): { title: string; caption: string | null } {
  if (g.source === "stock-import") {
    return { title: (g.note === null ? null : placeFromImportNote(g.note)) ?? "место не указано", caption: "место" };
  }
  const пометка = g.note?.trim() ?? "";
  if (пометка === "") return { title: "инвентаризация MYDON", caption: null };
  if (пометка === "owner") return { title: "владелец", caption: null };
  return { title: пометка, caption: "кто считал" };
}

/**
 * Подпись окна в лиде — и она обязана быть правдой при ОБРЕЗКЕ.
 *
 * `since` — первые сутки ЗАПРОШЕННОГО окна, и печатать «с {since}» безусловно
 * значит соврать под `history_capped`: Core сортирует по `counted_at desc` и
 * режет ХВОСТ, то есть показанные строки до начала окна не доходят. Хвостовое
 * предупреждение это не лечит — шапку владелец читает первой и уже поверил.
 * Поэтому при обрезке лид называет ровно то, что показано: сколько записей и
 * с какой даты они на самом деле идут (самая ранняя ПОКАЗАННАЯ), плюс что с
 * этим делать. Тогда причину владелец читает один раз — здесь, а не ещё раз в
 * хвосте (`COVERED_BY_STOCK_HISTORY`).
 *
 * `since` читается как необязательное НАМЕРЕННО: форму с провода никто не
 * валидирует, и ответ Core, откаченного на образ без этого поля, дал бы
 * `undefined.slice` внутри `day()` — то есть 500 вместо листа.
 */
function подписьОкна(report: StockCountsReport, обрезано: boolean): string | null {
  if (обрезано) {
    const ранняя = report.rows.reduce<string | null>((м, r) => (м === null || r.dt < м ? r.dt : м), null);
    const с = ранняя === null ? "" : `, с ${day(ранняя)}`;
    const n = report.rows.length;
    return `показаны последние ${count(n)} ${plural(n, "запись", "записи", "записей")}${с} — сузьте окно или задайте товар`;
  }
  const since: string | undefined = report.since;
  return since ? `с ${day(since)}` : null;
}

/**
 * Заголовок группы и подпись к нему.
 *
 * `.rcard-h` — единственный заголовок «имя + подпись справа», объявленный в
 * `globals.css` ВНЕ `.row` (`:325-327`). Голый `.t` там существует только как
 * `.row .t`, то есть вне строки не даёт ничего; `.section-title` не годится —
 * его `text-transform: uppercase` сделал бы из «Рустам» «РУСТАМ».
 *
 * Подписи может не быть вовсе (см. `шапкаГруппы`): пустой `<span>` вместо неё
 * оставил бы на месте подписи пустоту с её отступами, а нужен именно её
 * отсутствие.
 */
function ШапкаГруппы({ g }: { g: StockHistoryGroup }) {
  const { title, caption } = шапкаГруппы(g);
  return (
    <div className="rcard-h" style={{ margin: "14px 0 8px" }}>
      <span className="t">{title}</span>
      {caption === null ? null : <span className="ts">{caption}</span>}
    </div>
  );
}

/**
 * Пустая история БЕЗ фильтра — третье состояние, а не зелёная галка.
 *
 * Старый текст («Инвентаризаций за окно нет») звучал как приговор складу,
 * хотя причина чаще проще: последний счёт был раньше окна, а кнопки «365
 * дн.»/«730 дн.» стоят прямо над этим блоком — вопрос решается одним кликом.
 * Поэтому окно названо числом (как у соседа, «Мёртвый сток»), а расширение
 * предложено ровно теми окнами, которые ШИРЕ текущего: на 730 совет
 * «расширьте» был бы издевательством.
 *
 * Дата, с которой копятся СВОИ пересчёты, названа честно: таблица истории
 * появилась 26.08.2026, и счёт, сделанный владельцем 25.08, в неё уже не
 * попал. «Пересчёты копятся сами» без даты обещало бы то, чего в данных нет.
 */
function ПустаяИстория({ days }: { days: number }) {
  const шире = STOCK_HISTORY_WINDOWS.filter((w) => w > days);
  const совет =
    шире.length === 0
      ? ""
      : `Считали раньше — расширьте окно кнопками выше (${шире.map((w) => count(w)).join(" или ")} дн.). `;
  return (
    <div className="empty">
      <b>{`За ${count(days)} дн. инвентаризаций нет`}</b>
      {`${совет}Ещё не считали — свои пересчёты копятся с 26.08.2026 сами: их пишет бот («склад …») и панель.`}
    </div>
  );
}

export function StockHistoryTables({ report }: { report: StockCountsReport }) {
  const дни = groupStockCounts(report.rows);
  const пусто = report.rows.length === 0;
  const фильтр = report.product;
  const обрезано = report.warnings.some((w) => w.code === "history_capped");
  const окно = подписьОкна(report, обрезано);
  // Счёт строк при обрезке уже назван самой подписью окна («показаны последние
  // 2000 записей»): второй раз тем же числом лид сказал бы то же самое.
  const части = [
    `Пересчёты склада за ${count(report.days)} дн.`,
    ...(окно === null ? [] : [окно]),
    ...(обрезано
      ? []
      : [`${count(report.rows.length)} ${plural(report.rows.length, "строка", "строки", "строк")}`]),
    ...(фильтр ? [`товар «${фильтр}»`] : []),
  ];

  return (
    <>
      <p className="lead">{части.join(" · ")}</p>

      {пусто ? (
        фильтр ? (
          // По ЗАДАННОМУ товару Core уже сказал словами (`stock_missing`), и
          // лист его не дублирует: одну причину владелец читает один раз.
          <div className="empty">
            <b>По этому товару истории нет</b>
            {"Причина — ниже, в «Посчитано не всё»: чаще всего дело в имени, а не в складе."}
          </div>
        ) : (
          <ПустаяИстория days={report.days} />
        )
      ) : (
        дни.map((d) => (
          <div key={d.dt}>
            <div className="section-title">{day(d.dt)}</div>
            {d.groups.map((g) => (
              <div key={`${g.source}|${g.note ?? ""}`}>
                <ШапкаГруппы g={g} />
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
