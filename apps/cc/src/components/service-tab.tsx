"use client";

import Link from "next/link";
import { useState } from "react";
import type { ServiceFeedItem, ServiceFeedKind } from "@mydon/shared";

/** Плитка мини-KPI вкладки. Текст и подсветка уже посчитаны в page.tsx. */
export interface ServiceKpiTile {
  label: string;
  value: string;
  /** Подсветить как «требует внимания» (недолив/пусто/просрочка). */
  hot?: boolean;
  foot: string;
}

/** Быстрое действие — якорь на форму ниже на той же вкладке (#coffee/#snack/#cash). */
export interface ServiceAction {
  icon: string;
  title: string;
  subtitle: string;
  href: string;
}

const FEED_FILTERS: { key: ServiceFeedKind | "all"; label: string }[] = [
  { key: "all", label: "все" },
  { key: "coffee", label: "кофе" },
  { key: "snack", label: "снек" },
  { key: "cash", label: "деньги" },
];

/** «сегодня 09:52» / «вчера 17:03» / «24 июн» — по Ташкенту, как на канвасе. */
function feedWhen(iso: string): string {
  const d = new Date(iso);
  const tz = { timeZone: "Asia/Tashkent" } as const;
  const dayKey = d.toLocaleDateString("en-CA", tz);
  const todayKey = new Date().toLocaleDateString("en-CA", tz);
  const yesterdayKey = new Date(Date.now() - 86_400_000).toLocaleDateString("en-CA", tz);
  const time = d.toLocaleTimeString("ru-RU", { ...tz, hour: "2-digit", minute: "2-digit" });
  if (dayKey === todayKey) return `сегодня ${time}`;
  if (dayKey === yesterdayKey) return `вчера ${time}`;
  return d.toLocaleDateString("ru-RU", { ...tz, day: "numeric", month: "short" }).replace(/\.$/, "");
}

/**
 * ACTIVITY — вкладка «Обслуживание» целиком (Task 9).
 *
 * Данные уже загружены и объединены в `page.tsx` (провал одного источника не
 * обнуляет чужие KPI — best-effort try/catch там же); здесь только разметка
 * мини-KPI, трёх быстрых действий и единой ленты из трёх источников
 * (`mergeServiceFeed` + адаптеры, Task 8). Интерактивность — только фильтр
 * ленты (useState, по образцу `card-tabs.tsx`), поэтому весь файл клиентский:
 * серверных данных компонент не запрашивает, вложенный сервер/клиент-стык
 * внутри одного модуля React не допускает.
 */
export function ServiceTab({
  kpi,
  feed,
  actions,
  referenceHref,
}: {
  kpi: ServiceKpiTile[];
  feed: ServiceFeedItem[];
  actions: ServiceAction[];
  /** Куда ведёт нижняя ссылка на нумерацию бункеров/наборов (лист справочника). */
  referenceHref: string;
}) {
  const [filter, setFilter] = useState<ServiceFeedKind | "all">("all");
  const rows = filter === "all" ? feed : feed.filter((i) => i.kind === filter);

  return (
    <div className="sect">
      <div className="wgrid" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
        {kpi.map((t) => (
          <div key={t.label} className={`wt ${t.hot ? "is-hot" : ""}`}>
            <div className="wl">{t.label}</div>
            <div className="wv">{t.value}</div>
            <div className="wf">{t.foot}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
        {actions.map((a) => (
          <a
            key={a.href}
            href={a.href}
            className="wt"
            style={{ flex: "1 1 220px", textDecoration: "none", minHeight: "auto" }}
          >
            <div className="wl">
              {a.icon} {a.title}
            </div>
            <div className="wf">{a.subtitle}</div>
          </a>
        ))}
      </div>

      <div className="sect">
        <div className="sect-h">
          <h3 className="h2">История — что и когда было</h3>
          <span className="sp" />
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {FEED_FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                className={`chip ${filter === f.key ? "b" : ""}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        {rows.length === 0 ? (
          <div className="empty">
            <b>Событий нет</b>
            За последнее время в поле ничего не фиксировали — или фильтр отсеял всё.
          </div>
        ) : (
          <div className="rows">
            {rows.map((r, i) => (
              <div className="row" key={`${r.kind}-${r.ts}-${i}`}>
                <span className="when">{feedWhen(r.ts)}</span>
                <div className="t">
                  <b>{r.место}</b> · {r.текст}
                </div>
                {r.кто && <span className="pill human">{r.кто}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="notice">
        <b>Задачи ↔ Обслуживание:</b> подготовка бункеров и «точек ждёт визита» рождают задачи
        оператору; выполненная заливка сама закрывает задачу — двойного ввода нет.
      </div>

      <p className="hint">
        Нумерация бункеров (1–8 × ингредиент) и наборов (1–27, тара) — в{" "}
        <Link href={referenceHref}>Справочниках</Link>, здесь только выбор из них.
      </p>
    </div>
  );
}
