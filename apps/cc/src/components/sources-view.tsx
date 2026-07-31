import Link from "next/link";
import {
  core,
  CoreUnavailable,
  type Entity,
  type RawDecoder,
  type RawDrift,
  type RawSourceState,
  type RawSnapshotMeta,
} from "../lib/core";
import { CoreDown } from "./core-down";
import { RawMapping } from "./raw-mapping";
import { RawTable } from "./raw-table";
import { MachineStaysView } from "./machine-stays";
import { PricesView } from "./prices-view";
import { ProductsReview } from "./products-review";
import { PaymentsView } from "./payments-view";

/** Что показывает вкладка отчёта. */
type ReportView = "rows" | "map" | "stays" | "prices" | "goods" | "pay";

export interface SourcesViewProps {
  /** Адрес страницы направления: /domain/vendhub */
  base: string;
  /** Параметры адреса как есть — в них лежат и фильтры по колонкам (f0, f1…). */
  sp: Record<string, string>;
}

const p2 = (n: number) => String(n).padStart(2, "0");
/** Время съёма — до минуты: владелец сверяет его с тем, что видел в кабинете. */
function whenFull(iso: string): string {
  const d = new Date(iso);
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
function day(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()}`;
}
/** Сколько дней назад — словами, потому что «14 дней назад» понятнее даты. */
function ago(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "сегодня";
  if (days === 1) return "вчера";
  return `${days} дн. назад`;
}

function href(base: string, sp: Record<string, string>, next: Record<string, string | null>): string {
  const p = new URLSearchParams(sp);
  for (const [k, v] of Object.entries(next)) {
    if (v === null) p.delete(k);
    else p.set(k, v);
  }
  return `${base}?${p.toString()}`;
}

/** Параметры таблицы сбрасываются при смене отчёта: чужие фильтры бессмысленны. */
function withoutTableState(sp: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    if (k === "q" || k === "sort" || k === "dir" || k === "page" || k === "size") continue;
    if (/^f\d+$/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Источники VendHub — сырой слой.
 *
 * Строки лежат ровно так, как пришли из чужой системы: те же колонки, тот же
 * порядок, значения строками. Ничего не переименовано и не приведено к типам —
 * иначе спорную цифру нечем будет подтвердить. Разбор в аналитику живёт
 * отдельно и этот слой не меняет.
 */
export async function SourcesView({ base, sp }: SourcesViewProps) {
  let sources: RawSourceState[];
  try {
    ({ sources } = await core.rawSources());
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }

  const source = sources.find((s) => s.code === sp.src) ?? sources[0];
  if (!source) {
    return (
      <div className="empty">
        <b>Источники не заведены</b>
        Справочник систем пуст — добавь их в packages/shared/src/sources.ts.
      </div>
    );
  }
  const report = source.reports.find((r) => r.reportCode === sp.rep) ?? source.reports[0];
  const view: ReportView =
    sp.view === "map" ||
    sp.view === "stays" ||
    sp.view === "prices" ||
    sp.view === "goods" ||
    sp.view === "pay"
      ? sp.view
      : "rows";
  const clean = withoutTableState(sp);

  // Сводка сверху: сколько систем реально что-то принесли и где давно не снимали.
  const connected = sources.filter((s) => s.connected).length;
  const allReports = sources.flatMap((s) => s.reports);
  const never = allReports.filter((r) => r.freshness === "never").length;
  const stale = allReports.filter((r) => r.freshness === "stale").length;
  const totalRows = allReports.reduce((n, r) => n + r.rows, 0);

  return (
    <>
      <div className="tiles" style={{ marginBottom: 14 }}>
        <div className={`tile mini ${connected === 0 ? "zero" : ""}`}>
          <div className="lab">Систем на связи</div>
          <div className="v">
            {connected} <span className="u">из {sources.length}</span>
          </div>
          <div className="foot">
            <span className="mk" />
            {connected === 0 ? "выгрузок ещё не было" : "принесли хотя бы одну выгрузку"}
          </div>
        </div>
        <div className={`tile mini ${totalRows === 0 ? "zero" : ""}`}>
          <div className="lab">Строк собрано</div>
          <div className="v">{totalRows.toLocaleString("ru-RU")}</div>
          <div className="foot">
            <span className="mk" />в последних снимках
          </div>
        </div>
        <div className={`tile mini ${stale > 0 ? "is-hot" : "zero"}`}>
          <div className="lab">Устарело</div>
          <div className="v">{stale}</div>
          <div className="foot">
            <span className="mk" />
            {stale > 0 ? "отчётов давно не снимали" : "свежие выгрузки"}
          </div>
        </div>
        <div className={`tile mini ${never === allReports.length ? "" : "zero"}`}>
          <div className="lab">Ни разу не снимали</div>
          <div className="v">{never}</div>
          <div className="foot">
            <span className="mk" />
            {never > 0 ? "отчётов ждут первой выгрузки" : "все отчёты пробованы"}
          </div>
        </div>
      </div>

      {/* Системы-источники */}
      <div className="srcs">
        {sources.map((s) => (
          <Link
            key={s.code}
            href={href(base, withoutTableState({ ...sp, src: s.code }), { src: s.code, rep: null })}
            className={`src ${s.code === source.code ? "on" : ""}`}
          >
            <span className={`dot ${s.connected ? "on" : ""}`} />
            <span className="srct">{s.title}</span>
            <span className="srcs2">{s.subtitle}</span>
          </Link>
        ))}
      </div>

      <p className="hint" style={{ marginBottom: 10 }}>
        Кабинет источника:{" "}
        <a href={source.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>
          {source.url}
        </a>
      </p>

      {/* Отчёты выбранной системы */}
      <div className="subtabs">
        {source.reports.map((r) => (
          <Link
            key={r.reportCode}
            href={href(base, clean, { rep: r.reportCode })}
            className={`subtab ${r.reportCode === report?.reportCode ? "active" : ""} ${
              r.snapshots === 0 ? "dim" : ""
            }`}
          >
            {r.title}
            {r.rows > 0 ? <span className="n"> {r.rows.toLocaleString("ru-RU")}</span> : ""}
          </Link>
        ))}
      </div>

      {report ? (
        <ReportPane base={base} sp={sp} source={source} reportCode={report.reportCode} view={view} />
      ) : (
        <div className="empty">
          <b>У этой системы не описано ни одного отчёта</b>
          Добавь его в справочник источников — и он появится здесь.
        </div>
      )}
    </>
  );
}

/** Один отчёт: шапка снимка и либо строки, либо сопоставление. */
async function ReportPane({
  base,
  sp,
  source,
  reportCode,
  view,
}: {
  base: string;
  sp: Record<string, string>;
  source: RawSourceState;
  reportCode: string;
  view: ReportView;
}) {
  const report = source.reports.find((r) => r.reportCode === reportCode);
  if (!report) return null;

  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    if (k === "q" || k === "sort" || k === "dir" || k === "page" || k === "size" || /^f\d+$/.test(k)) {
      if (v.trim().length > 0) params[k] = v;
    }
  }

  let snapshot: RawSnapshotMeta | null = null;
  let rows: { idx: number; cells: string[] }[] = [];
  let total = 0;
  let page = 1;
  let size = 100;
  let decoders: RawDecoder[] = [];
  let drift: RawDrift | null = null;
  try {
    const res = await core.rawRows(source.code, reportCode, params);
    snapshot = res.snapshot;
    rows = res.rows;
    total = res.total;
    page = res.page ?? 1;
    size = res.size ?? 100;
    decoders = res.decoders ?? [];
    drift = res.drift ?? null;
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }

  if (!snapshot) {
    return (
      <div className="empty">
        <b>Отчёт ещё не выгружался</b>
        Путь в системе: {report.path}. Как только первая выгрузка попадёт в
        хранилище, здесь появится таблица — с теми же колонками и в том же
        порядке, что и в источнике.
      </div>
    );
  }

  const viewHref = (v: ReportView) =>
    href(base, sp, { view: v === "rows" ? null : v });
  const exportParams = new URLSearchParams(params);
  exportParams.set("src", source.code);
  exportParams.set("rep", reportCode);
  const exportHref = `/api/sources/export?${exportParams.toString()}`;

  const filters: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) if (/^f\d+$/.test(k)) filters[k] = v;
  const sortNum = Number(params.sort);
  const sort = params.sort !== undefined && Number.isInteger(sortNum) ? sortNum : null;

  const keep: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    if (k === "q" || k === "sort" || k === "dir" || k === "page" || k === "size" || /^f\d+$/.test(k)) continue;
    keep[k] = v;
  }

  const period =
    snapshot.periodFrom || snapshot.periodTo
      ? `${day(snapshot.periodFrom)} — ${day(snapshot.periodTo)}`
      : "не указан";

  return (
    <>
      {drift && (
        <div className="notice">
          <b>Источник изменил состав колонок</b>
          {drift.added.length > 0 && <>Появились: {drift.added.join(", ")}. </>}
          {drift.removed.length > 0 && <>Пропали: {drift.removed.join(", ")}. </>}
          {drift.reordered && <>Колонки переставлены местами. </>}
          Загрузку это не ломает — снимок лёг со своим составом. Но связь с
          карточками может перестать находиться: проверь вкладку «Сопоставление».
        </div>
      )}

      <div className="wgrid" style={{ marginBottom: 14 }}>
        <div className="wt">
          <div className="wl">Снято</div>
          <div className="wv" style={{ fontSize: 17 }}>{whenFull(snapshot.fetchedAt)}</div>
          <div className="wf">{ago(snapshot.fetchedAt)}</div>
        </div>
        <div className="wt">
          <div className="wl">Строк в снимке</div>
          <div className="wv">{snapshot.rows.toLocaleString("ru-RU")}</div>
          <div className="wf">
            {snapshot.rowsTotal !== null && snapshot.rowsTotal > snapshot.rows
              ? `у источника ${snapshot.rowsTotal.toLocaleString("ru-RU")} — снимок неполный`
              : "колонок: " + snapshot.columns.length}
          </div>
        </div>
        <div className="wt">
          <div className="wl">Период</div>
          <div className="wv" style={{ fontSize: 17 }}>{period}</div>
          <div className="wf">как выбрано в источнике</div>
        </div>
        <div className="wt">
          <div className="wl">Учётная запись</div>
          <div className="wv" style={{ fontSize: 17 }}>{snapshot.account ?? "—"}</div>
          <div className="wf">{report.ru}</div>
        </div>
      </div>

      <div className="subtabs">
        <Link href={viewHref("rows")} className={`subtab ${view === "rows" ? "active" : ""}`}>
          Строки
        </Link>
        <Link href={viewHref("map")} className={`subtab ${view === "map" ? "active" : ""}`}>
          Сопоставление с реестром
        </Link>
        <Link href={viewHref("stays")} className={`subtab ${view === "stays" ? "active" : ""}`}>
          Где стояли автоматы
        </Link>
        <Link href={viewHref("prices")} className={`subtab ${view === "prices" ? "active" : ""}`}>
          Цены
        </Link>
        <Link href={viewHref("goods")} className={`subtab ${view === "goods" ? "active" : ""}`}>
          Товары
        </Link>
        <Link href={viewHref("pay")} className={`subtab ${view === "pay" ? "active" : ""}`}>
          Оплата
        </Link>
      </div>

      {view === "rows" ? (
        <RawTable
          columns={snapshot.columns}
          rows={rows}
          total={total}
          page={page}
          size={size}
          q={params.q ?? ""}
          sort={sort}
          dir={params.dir === "desc" ? "desc" : "asc"}
          filters={filters}
          base={base}
          keep={keep}
          exportHref={exportHref}
          decoders={decoders}
        />
      ) : view === "map" ? (
        <MappingPane source={source.code} reportCode={reportCode} />
      ) : view === "prices" ? (
        <PricesPane source={source.code} reportCode={reportCode} />
      ) : view === "goods" ? (
        <GoodsPane source={source.code} reportCode={reportCode} />
      ) : view === "pay" ? (
        <PayPane base={base} sp={sp} source={source.code} reportCode={reportCode} />
      ) : (
        <StaysPane source={source.code} reportCode={reportCode} />
      )}
    </>
  );
}

/** Каким способом приходят деньги — срез для сверки с платёжными системами. */
async function PayPane({
  base,
  sp,
  source,
  reportCode,
}: {
  base: string;
  sp: Record<string, string>;
  source: string;
  reportCode: string;
}) {
  try {
    const review = await core.rawPayments(source, reportCode);
    // Сводке верить на слово не надо: с каждого кода можно уйти в сами заказы,
    // отфильтрованные по этой колонке.
    const rowsHref =
      review.column < 0
        ? null
        : (code: string) =>
            href(base, withoutTableState(sp), { view: null, [`f${review.column}`]: code });
    return <PaymentsView review={review} rowsHref={rowsHref} />;
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }
}

/** Ассортимент источника: что продаётся и по чему не собирается чек. */
async function GoodsPane({ source, reportCode }: { source: string; reportCode: string }) {
  try {
    const [review, products] = await Promise.all([
      core.rawProducts(source, reportCode),
      core.entitiesOfType("vendhub", "product"),
    ]);
    return (
      <ProductsReview
        source={source}
        review={review}
        cards={products
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name, "ru"))
          .map((e) => ({ id: e.id, name: e.name }))}
      />
    );
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }
}

/** Где какой товар почём и кто отстал с ценой. */
async function PricesPane({ source, reportCode }: { source: string; reportCode: string }) {
  try {
    return <PricesView review={await core.rawPrices(source, reportCode)} />;
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }
}

/** Где стоял каждый автомат и когда переезжал. */
async function StaysPane({ source, reportCode }: { source: string; reportCode: string }) {
  try {
    const { machines } = await core.rawStays(source, reportCode);
    return <MachineStaysView machines={machines} />;
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }
}

/** Сопоставление: что из выгрузки узнано по карточкам реестра, а что нет. */
async function MappingPane({ source, reportCode }: { source: string; reportCode: string }) {
  let groups;
  let machines: Entity[] = [];
  let products: Entity[] = [];
  try {
    const [mapping, m, p] = await Promise.all([
      core.rawMapping(source, reportCode),
      core.entitiesOfType("vendhub", "machine"),
      core.entitiesOfType("vendhub", "product"),
    ]);
    groups = mapping.groups;
    machines = m;
    products = p;
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }

  const byName = (a: Entity, b: Entity) => a.name.localeCompare(b.name, "ru");
  return (
    <>
      <p className="hint" style={{ marginTop: 12 }}>
        Сырьё не меняется: связь живёт отдельно и переживает следующую выгрузку.
        Совпадение по точному ключу считается заново каждый раз — переименуешь
        карточку, и связь пересчитается сама.
      </p>
      <RawMapping
        source={source}
        groups={groups}
        cards={{
          machine: machines.slice().sort(byName).map((e) => ({ id: e.id, name: e.name })),
          product: products.slice().sort(byName).map((e) => ({ id: e.id, name: e.name })),
        }}
      />
    </>
  );
}
