"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { MACHINE_KIND_LABELS, machineStatusLabel, type MachineKind } from "@mydon/shared";
import type { CoffeeFillStatusRow } from "../lib/core";
import { BunkerLevels } from "./bunker-levels";

/** Строка парка для списка/плиток — всё уже развёрнуто сервером. */
export interface MachineListItem {
  id: string;
  name: string;
  serial: string | null;
  point: string | null;
  /** Вид из machine_card; null — карточка вида не заведена. */
  kind: string | null;
  status: string;
  statusNote: string | null;
  /** Живая заполненность Ourvend (снеки), null — данных нет. */
  fillRate: number | null;
  deficit: number | null;
  bunkers: CoffeeFillStatusRow[] | null;
  menuCount: number;
}

const KIND_EMOJI: Record<string, string> = {
  coffee: "☕",
  snack: "🍫",
  drink: "🥤",
  combo: "🍫",
  other: "❔",
};

const KIND_FILTERS = ["coffee", "snack", "drink"] as const;

/** Подписи виджетов — латиницей, как в именах парка (слово владельца). */
const KIND_PLURAL: Record<string, string> = {
  coffee: "coffee",
  snack: "snack",
  drink: "drinks",
  combo: "snack + drinks",
};

const SORTS = [
  { key: "name", label: "по имени" },
  { key: "point", label: "по локации" },
  { key: "fill", label: "по заполненности" },
  { key: "status", label: "по состоянию" },
  { key: "menu", label: "по меню" },
] as const;
type SortKey = (typeof SORTS)[number]["key"];

const STORE = "mydon.machines.view";

/** Порядок состояний в сортировке: сначала то, что требует глаз. */
const STATUS_RANK: Record<string, number> = { repair: 0, warehouse: 1, in_service: 2 };

function statusChip(status: string): string {
  return status === "in_service" ? "chip g" : status === "repair" ? "chip h" : "chip";
}

/**
 * Браузер парка: поиск, фильтры-чипы по виду и состоянию, сортировка и два
 * вида — список и плитки. Выбор вида и сортировки переживает уход со страницы
 * (localStorage): владелец настраивает один раз, а не при каждом заходе.
 */
export function MachinesBrowser({ items }: { items: MachineListItem[] }) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");
  const [sort, setSort] = useState<SortKey>("name");
  const [view, setView] = useState<"list" | "grid">("list");

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORE) ?? "{}");
      if (saved.view === "grid" || saved.view === "list") setView(saved.view);
      if (SORTS.some((s) => s.key === saved.sort)) setSort(saved.sort);
    } catch {
      // сломанное сохранение — остаёмся на умолчаниях
    }
  }, []);
  const remember = (patch: { view?: "list" | "grid"; sort?: SortKey }) => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORE) ?? "{}");
      window.localStorage.setItem(STORE, JSON.stringify({ ...saved, ...patch }));
    } catch {
      // приватный режим — просто не запоминаем
    }
  };

  const kindOf = (m: MachineListItem) => m.kind ?? "other";
  const countKind = (k: string) => items.filter((m) => kindOf(m) === k).length;
  const countStatus = (s: string) => items.filter((m) => m.status === s).length;
  const statusesPresent = ["in_service", "warehouse", "repair"].filter((s) => countStatus(s) > 0);

  // Живой срез парка: средняя заполненность и суммарный дефицит по снекам,
  // у которых Ourvend приносит данные.
  const живые = items.filter((m) => m.fillRate !== null);
  const liveAvg =
    живые.length > 0
      ? Math.round(живые.reduce((a, m) => a + (m.fillRate ?? 0), 0) / живые.length)
      : null;
  const liveDeficit = живые.reduce((a, m) => a + (m.deficit ?? 0), 0);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = items.filter((m) => {
      if (kind !== "all" && kindOf(m) !== kind) return false;
      if (status !== "all" && m.status !== status) return false;
      if (needle === "") return true;
      return [m.name, m.serial ?? "", m.point ?? ""].some((s) =>
        s.toLowerCase().includes(needle),
      );
    });
    const by: Record<SortKey, (a: MachineListItem, b: MachineListItem) => number> = {
      name: (a, b) => a.name.localeCompare(b.name, "ru"),
      point: (a, b) => (a.point ?? "я").localeCompare(b.point ?? "я", "ru"),
      // Живой заполненности нет — в конец: сортировка отвечает «кого заправлять».
      fill: (a, b) => (a.fillRate ?? 101) - (b.fillRate ?? 101),
      status: (a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9),
      menu: (a, b) => b.menuCount - a.menuCount,
    };
    return [...rows].sort(by[sort]);
  }, [items, q, kind, status, sort]);

  const row = (m: MachineListItem) => (
    <Link href={`/card/${m.id}`} className="row" key={m.id}>
      <div className="t">
        <b>{m.name}</b>
        <small>
          {m.serial ? `серийник ${m.serial}` : "серийник не указан"}
          {m.point ? ` · ${m.point}` : ""}
          {m.statusNote ? ` · ${m.statusNote}` : ""}
        </small>
      </div>
      {m.fillRate !== null && (
        <span className={`pill ${m.fillRate < 50 ? "bad" : m.fillRate < 70 ? "" : "ok"}`}>
          {m.fillRate}%
        </span>
      )}
      {m.bunkers && <BunkerLevels rows={m.bunkers} compact />}
      {m.status !== "in_service" && (
        <span className={statusChip(m.status)}>{machineStatusLabel(m.status)}</span>
      )}
      <span className={`chip ${kindOf(m) === "coffee" ? "b" : kindOf(m) === "other" ? "" : "g"}`}>
        {m.kind ? MACHINE_KIND_LABELS[m.kind as MachineKind] ?? m.kind : "тип не указан"}
      </span>
    </Link>
  );

  const card = (m: MachineListItem) => (
    <Link href={`/card/${m.id}`} className="mb-card" key={m.id}>
      <div className="mb-head">
        <span className="mb-emoji" aria-hidden>
          {KIND_EMOJI[kindOf(m)] ?? "❔"}
        </span>
        <b className="mb-name">{m.name}</b>
        {m.status !== "in_service" && (
          <span className={statusChip(m.status)}>{machineStatusLabel(m.status)}</span>
        )}
      </div>
      <div className="mb-sub">
        {m.serial ? <span className="mono">{m.serial}</span> : "серийник не указан"}
        {m.point ? ` · ${m.point}` : ""}
      </div>
      {m.fillRate !== null ? (
        <>
          <div className="mb-bar" title={`Заполнен ${m.fillRate}% · дефицит −${m.deficit ?? 0}`}>
            <i
              className={m.fillRate < 50 ? "crit" : m.fillRate < 70 ? "warn" : ""}
              style={{ width: `${Math.max(4, Math.min(100, m.fillRate))}%` }}
            />
          </div>
          <div className="mb-foot">
            заполнен {m.fillRate}% · −{(m.deficit ?? 0).toLocaleString("ru-RU")} ед
          </div>
        </>
      ) : m.bunkers ? (
        <div className="mb-bunkers">
          <BunkerLevels rows={m.bunkers} compact />
        </div>
      ) : (
        <div className="mb-foot">{m.menuCount > 0 ? `меню · ${m.menuCount} поз.` : "живых данных нет"}</div>
      )}
    </Link>
  );

  return (
    <>
      <div className="mb-toolbar">
        <input
          className="mb-search"
          placeholder="Имя, серийник или локация…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Поиск по парку"
        />
        <select
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as SortKey);
            remember({ sort: e.target.value as SortKey });
          }}
          aria-label="Сортировка"
        >
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
        <div className="mb-seg" role="group" aria-label="Вид списка">
          <button
            type="button"
            className={view === "list" ? "on" : ""}
            onClick={() => {
              setView("list");
              remember({ view: "list" });
            }}
            title="Списком"
          >
            ☰
          </button>
          <button
            type="button"
            className={view === "grid" ? "on" : ""}
            onClick={() => {
              setView("grid");
              remember({ view: "grid" });
            }}
            title="Плитками"
          >
            ⊞
          </button>
        </div>
      </div>

      {/* Виджеты-показатели парка. Они же фильтры: тап по виджету сужает
          список, активный подсвечен — видно и цифры, и что отфильтровано. */}
      <div className="mbk-strip">
        <button
          type="button"
          className={`mbk${kind === "all" && status === "all" ? " on" : ""}`}
          onClick={() => {
            setKind("all");
            setStatus("all");
          }}
          title="Весь парк"
        >
          <b>{items.length}</b>
          <span>автоматов</span>
        </button>
        {KIND_FILTERS.filter((k) => countKind(k) > 0).map((k) => (
          <button
            key={k}
            type="button"
            className={`mbk${kind === k ? " on" : ""}`}
            onClick={() => setKind(kind === k ? "all" : k)}
          >
            <b>
              {KIND_EMOJI[k]} {countKind(k)}
            </b>
            <span>{KIND_PLURAL[k] ?? MACHINE_KIND_LABELS[k as MachineKind]}</span>
          </button>
        ))}
        {countKind("other") > 0 && (
          <button
            type="button"
            className={`mbk${kind === "other" ? " on" : ""}`}
            onClick={() => setKind(kind === "other" ? "all" : "other")}
          >
            <b>❔ {countKind("other")}</b>
            <span>не размечен</span>
          </button>
        )}
        <span className="mb-sep" />
        {statusesPresent.map((s) => (
          <button
            key={s}
            type="button"
            className={`mbk${status === s ? " on" : ""}${s === "repair" ? " hot" : ""}`}
            onClick={() => setStatus(status === s ? "all" : s)}
          >
            <b>{countStatus(s)}</b>
            <span>{machineStatusLabel(s).toLowerCase()}</span>
          </button>
        ))}
        {liveAvg !== null && (
          <>
            <span className="mb-sep" />
            <div className="mbk info" title="Живой срез Ourvend по снекам в расчёте">
              <b>{liveAvg}%</b>
              <span>заполнен · −{liveDeficit.toLocaleString("ru-RU")} ед</span>
            </div>
          </>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="empty">
          <b>Никого не нашлось</b>
          Поменяй запрос или сбрось фильтры — парк на месте.
        </div>
      ) : view === "list" ? (
        <div className="rows">{filtered.map(row)}</div>
      ) : (
        <div className="mb-grid">{filtered.map(card)}</div>
      )}
    </>
  );
}
