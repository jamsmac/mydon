"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

export interface RawTableProps {
  columns: string[];
  rows: { idx: number; cells: string[] }[];
  total: number;
  page: number;
  size: number;
  q: string;
  sort: number | null;
  dir: "asc" | "desc";
  filters: Record<string, string>;
  /** Адрес страницы без параметров: /domain/vendhub */
  base: string;
  /** Параметры, которые нужно сохранять при любой навигации (вкладка, источник). */
  keep: Record<string, string>;
  /** Ссылка на скачивание с текущими фильтрами. */
  exportHref: string;
  /** Расшифровки кодов источника: номер колонки → словарь значений. */
  decoders: { column: number; values: Record<string, string>; unconfirmed: string[] }[];
}

const SIZES = [50, 100, 250, 500, 1000];

/**
 * Таблица сырого отчёта.
 *
 * Порядок колонок и написание значений — как у источника: ничего не
 * переименовано и не приведено к типам. Поиск, фильтры и сортировка считаются
 * на сервере: в выгрузке бывают десятки тысяч строк, в браузер их тянуть нельзя.
 */
export function RawTable(props: RawTableProps) {
  const { columns, rows, total, page, size, sort, dir, base, keep, exportHref, decoders } = props;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [q, setQ] = useState(props.q);
  const [filters, setFilters] = useState<Record<string, string>>(props.filters);
  const [open, setOpen] = useState<{ kind: "row"; idx: number } | { kind: "cols" } | null>(null);
  const first = useRef(true);

  const pages = Math.max(1, Math.ceil(total / size));

  function go(next: Record<string, string | null>): void {
    const p = new URLSearchParams(keep);
    for (const [k, v] of Object.entries(filters)) if (v.trim()) p.set(k, v);
    if (q.trim()) p.set("q", q.trim());
    if (sort !== null) p.set("sort", String(sort));
    if (dir === "desc") p.set("dir", "desc");
    if (page > 1) p.set("page", String(page));
    if (size !== 100) p.set("size", String(size));
    for (const [k, v] of Object.entries(next)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    start(() => router.push(`${base}?${p.toString()}`));
  }

  // Поиск и фильтры не должны дёргать сервер на каждую букву.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => go({ page: null }), 400);
    return () => clearTimeout(t);
    // Зависимости только от ввода: go читает свежие значения при вызове.
  }, [q, filters]);

  function sortBy(i: number): void {
    if (sort === i) go({ sort: String(i), dir: dir === "asc" ? "desc" : "asc", page: null });
    else go({ sort: String(i), dir: "asc", page: null });
  }

  /**
   * Расшифровка кода источника. Сырьё остаётся сырьём: в ячейке по-прежнему
   * «userDefined», а перевод идёт подсказкой рядом. Неподтверждённый смысл
   * помечаем вопросом — догадка, выданная за факт, хуже её отсутствия.
   */
  function decode(colIdx: number, value: string): { label: string; confirmed: boolean } | null {
    const d = decoders.find((x) => x.column === colIdx);
    if (!d) return null;
    const label = d.values[value.trim()];
    if (label === undefined) return null;
    return { label, confirmed: !d.unconfirmed.includes(value.trim()) };
  }

  const activeFilters = Object.values(filters).filter((v) => v.trim()).length;
  const shown = rows.length === 0 ? 0 : (page - 1) * size + 1;
  const row = open?.kind === "row" ? rows.find((r) => r.idx === open.idx) : undefined;

  return (
    <>
      <div className="rawbar">
        <input
          className="rawsearch"
          placeholder="Поиск по всем колонкам…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="button" className="btn sm ghost" onClick={() => setOpen({ kind: "cols" })}>
          Структура
        </button>
        <a className="btn sm ghost" href={exportHref}>
          Скачать CSV
        </a>
        {(activeFilters > 0 || q.trim().length > 0) && (
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => {
              setQ("");
              setFilters({});
            }}
          >
            Сбросить
          </button>
        )}
        <span className="hint">
          {activeFilters > 0 ? `фильтров по колонкам: ${activeFilters}` : "фильтры по колонкам — в шапке"}
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          <b>Под фильтры ничего не подошло</b>
          Сбрось поиск — строки снимка вернутся на место.
        </div>
      ) : (
        <div className={`rawwrap ${pending ? "busy" : ""}`}>
          <table className="rawtable">
            <thead>
              <tr>
                <th className="rawno">#</th>
                {columns.map((c, i) => (
                  <th key={`${c}-${i}`} onClick={() => sortBy(i)} title={`Сортировать по «${c}»`}>
                    <span className="ci">{i + 1}</span>
                    {c}
                    {sort === i ? (dir === "asc" ? " ↑" : " ↓") : ""}
                  </th>
                ))}
              </tr>
              <tr className="filt">
                <th className="rawno" />
                {columns.map((c, i) => (
                  <th key={`f-${c}-${i}`}>
                    <input
                      placeholder="фильтр"
                      value={filters[`f${i}`] ?? ""}
                      onChange={(e) => setFilters({ ...filters, [`f${i}`]: e.target.value })}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.idx} onClick={() => setOpen({ kind: "row", idx: r.idx })}>
                  <td className="rawno">{r.idx}</td>
                  {columns.map((c, i) => (
                    <td key={`${r.idx}-${i}`} className={sort === i ? "sel" : ""} title={r.cells[i] ?? ""}>
                      {r.cells[i] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > 0 && (
        <div className="pager">
          <span className="mono">
            {shown.toLocaleString("ru-RU")}–{Math.min(page * size, total).toLocaleString("ru-RU")} из{" "}
            <b>{total.toLocaleString("ru-RU")}</b>
          </span>
          <span className="sp" />
          <button type="button" className="btn sm ghost" disabled={page <= 1} onClick={() => go({ page: null })}>
            «
          </button>
          <button
            type="button"
            className="btn sm ghost"
            disabled={page <= 1}
            onClick={() => go({ page: String(page - 1) })}
          >
            ←
          </button>
          <span className="mono">
            стр. {page} / {pages}
          </span>
          <button
            type="button"
            className="btn sm ghost"
            disabled={page >= pages}
            onClick={() => go({ page: String(page + 1) })}
          >
            →
          </button>
          <button
            type="button"
            className="btn sm ghost"
            disabled={page >= pages}
            onClick={() => go({ page: String(pages) })}
          >
            »
          </button>
          <select
            className="rawsize"
            value={size}
            onChange={(e) => go({ size: e.target.value, page: null })}
          >
            {SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span className="hint">на странице</span>
        </div>
      )}

      {open && (
        <>
          <div className="ovl" onClick={() => setOpen(null)} />
          <aside className="drawer">
            <div className="drawer-h">
              <div className="drawer-t">
                {open.kind === "cols" ? "Структура отчёта" : `Строка ${open.idx} — как в источнике`}
              </div>
              <button type="button" className="btn sm ghost" onClick={() => setOpen(null)}>
                Закрыть
              </button>
            </div>
            <div className="drawer-b">
              {open.kind === "cols" ? (
                <>
                  <p className="hint" style={{ marginBottom: 10 }}>
                    Порядок колонок — как у источника. Он часть данных: по нему сверяется выгрузка.
                  </p>
                  <dl className="kv">
                    {columns.map((c, i) => (
                      <div className="kvr" key={`c-${c}-${i}`}>
                        <dt>{i + 1}</dt>
                        <dd>{c}</dd>
                      </div>
                    ))}
                  </dl>
                </>
              ) : (
                <dl className="kv">
                  {columns.map((c, i) => {
                    const v = row?.cells[i] ?? "";
                    const d = v ? decode(i, v) : null;
                    return (
                      <div className="kvr" key={`r-${c}-${i}`}>
                        <dt>
                          {i + 1}. {c}
                        </dt>
                        <dd>
                          {v ? v : "—"}
                          {d && (
                            <span className={`decoded ${d.confirmed ? "" : "unsure"}`}>
                              {d.confirmed ? d.label : `${d.label} — не подтверждено`}
                            </span>
                          )}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              )}
            </div>
          </aside>
        </>
      )}
    </>
  );
}
