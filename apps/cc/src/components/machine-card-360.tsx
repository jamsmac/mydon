import Link from "next/link";
import type { ReactNode } from "react";
import {
  MACHINE_KIND_LABELS,
  machineStatusLabel,
  type MachineKind,
} from "@mydon/shared";
import type { CoffeePlacementRow, Entity, VendingMachine } from "../lib/core";
import { CardTabs } from "./card-tabs";
import { when } from "../lib/format";

/** Эмодзи-аватар по виду автомата — мгновенное узнавание в шапке. */
const KIND_EMOJI: Record<string, string> = {
  coffee: "☕",
  snack: "🍫",
  drink: "🥤",
  combo: "🍫",
  other: "❔",
};

/** Мини-плитка паспорта: подпись + значение, опционально ссылка (↗). */
function Tile({
  label,
  value,
  href,
  mono,
  empty,
  wide,
}: {
  label: string;
  value: ReactNode;
  href?: string | undefined;
  mono?: boolean;
  empty?: boolean;
  wide?: boolean;
}) {
  const cls = `mct${empty ? " mct-empty" : ""}${wide ? " mct-wide" : ""}`;
  const body = (
    <>
      <span className="lb">{label}</span>
      <b className={`vl${mono ? " mono" : ""}`}>{value}</b>
      {href ? <span className="act">↗</span> : null}
    </>
  );
  if (href) {
    const external = href.startsWith("http");
    return external ? (
      <a className={`${cls} mct-link`} href={href} target="_blank" rel="noreferrer">
        {body}
      </a>
    ) : (
      <Link className={`${cls} mct-link`} href={href}>
        {body}
      </Link>
    );
  }
  return <div className={cls}>{body}</div>;
}

/** Кольцо полноты карточки: сколько ключевых разделов уже заполнено. */
function Ring({ pct }: { pct: number }) {
  const r = 22;
  const c = 2 * Math.PI * r;
  return (
    <div className="mc-ring" title={`Полнота карточки: ${pct}%`}>
      <svg width="52" height="52" aria-hidden>
        <circle cx="26" cy="26" r={r} fill="none" stroke="var(--line)" strokeWidth="5" />
        <circle
          cx="26"
          cy="26"
          r={r}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="5"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct / 100)}
          strokeLinecap="round"
        />
      </svg>
      <b className="mono">{pct}%</b>
    </div>
  );
}

export function MachineCard360({
  entity,
  kind,
  status,
  statusNote,
  updatedBy,
  placements,
  live,
  coffee,
  planogramCount,
  partsCount,
  pricesCount,
  photosCount,
  hasGeo,
  mapHref,
  slots,
}: {
  entity: Entity;
  kind: string | null;
  status: string | null;
  statusNote: string | null;
  updatedBy: string | null;
  placements: CoffeePlacementRow[];
  /** Живой срез Ourvend по этому серийнику — если сбор его приносил. */
  live: VendingMachine | null;
  /** Кофейный: привязка к кофе-точке и сколько бункеров с заливкой. Не кофе — null. */
  coffee: { linked: boolean; filled: number } | null;
  planogramCount: number;
  partsCount: number;
  pricesCount: number;
  photosCount: number;
  hasGeo: boolean;
  mapHref: string | null;
  /** Контент вкладок: карточка собирает, страница поставляет. */
  slots: {
    content: ReactNode;
    service: ReactNode;
    place: ReactNode;
    passport: ReactNode;
  };
}) {
  const a = entity.attrs ?? {};
  const approved = entity.approvedAt != null;
  const текущая = placements.find((p) => p.endDate === null) ?? null;
  const точка = текущая?.locationName ?? (typeof a["точка"] === "string" ? a["точка"] : null);
  const источник = typeof a["источник"] === "string" ? a["источник"] : entity.createdFrom;

  // Полнота карточки: 8 признаков, каждый — раздел, который можно дозаполнить.
  const метки: [boolean, string, string][] = [
    [approved, "Карточка не утверждена", "passport"],
    [kind !== null && kind !== "other", "Вид не указан", "service"],
    [текущая !== null, "Место не записано", "service"],
    [hasGeo, "Координат нет — не видно на карте", "place"],
    // Содержимое зависит от вида: у кофейного — бункеры точки, у остальных — раскладка.
    coffee !== null
      ? [coffee.linked, "Бункеры не привязаны к кофе-точке", "content"]
      : [planogramCount > 0, "Раскладка пуста", "content"],
    [photosCount > 0, "Нет ни одного фото", "passport"],
    [status !== null, "Состояние не проставлено", "service"],
    [entity.externalRef !== null && entity.externalRef !== "", "Серийник не указан", "passport"],
  ];
  const заполнено = метки.filter(([ok]) => ok).length;
  const pct = Math.round((заполнено / метки.length) * 100);
  const внимание = метки.filter(([ok]) => !ok);

  const статус = status ?? "in_service";
  const statusChip =
    статус === "in_service" ? "chip g" : статус === "repair" ? "chip h" : "chip";

  return (
    <div className="mc">
      <header className="mc-hero">
        <div className="mc-ava" aria-hidden>
          {KIND_EMOJI[kind ?? "other"] ?? "❔"}
        </div>
        <div className="mc-id">
          <h1>{entity.name}</h1>
          <p className="mc-sub">
            {entity.externalRef ? (
              <span className="mono">S/N {entity.externalRef}</span>
            ) : (
              "серийник не указан"
            )}
            {точка ? <> · {точка}</> : null}
            {mapHref ? (
              <>
                {" · "}
                <a href={mapHref} target="_blank" rel="noreferrer">
                  карта ↗
                </a>
              </>
            ) : null}
          </p>
          <div className="mc-badges">
            <span className="chip b">
              {MACHINE_KIND_LABELS[(kind ?? "other") as MachineKind] ?? kind}
            </span>
            <span className={statusChip} data-mc-tab="service" role="button" tabIndex={0}>
              {machineStatusLabel(status)}
              {statusNote ? ` · ${statusNote}` : ""}
            </span>
            {!approved && (
              <span className="chip h" data-mc-tab="passport" role="button" tabIndex={0}>
                ждёт утверждения
              </span>
            )}
            {live && live.status === "ok" && (
              <span className="chip" data-mc-tab="content" role="button" tabIndex={0}>
                заполнен {live.fillRate}% · −{live.deficit.toLocaleString("ru-RU")} ед
              </span>
            )}
          </div>
        </div>
        <Ring pct={pct} />
      </header>

      <div className="mc-meta">
        <span>
          обновлено <b>{when(entity.updatedAt)}</b>
        </span>
        {updatedBy && (
          <span>
            вид проставил <b>{updatedBy}</b>
          </span>
        )}
        {источник && (
          <span>
            источник <b>{источник}</b>
          </span>
        )}
      </div>

      <CardTabs
        items={[
          {
            key: "overview",
            label: "Обзор",
            content: (
              <>
                <div className="tiles mc-kpis">
                  {live && live.status === "ok" && (
                    <div className={`tile${live.deficit >= 100 ? " is-hot" : ""}`}>
                      <span className="lab">Заполненность</span>
                      <div className="v">
                        {live.fillRate}
                        <span className="u">%</span>
                      </div>
                      <div className="foot">
                        <span className="mk" />
                        {live.filled}/{live.capacity} · дефицит −{live.deficit.toLocaleString("ru-RU")}
                      </div>
                    </div>
                  )}
                  {coffee !== null ? (
                    <div className="tile" data-mc-tab="content" role="button" tabIndex={0}>
                      <span className="lab">Бункеры</span>
                      <div className="v">
                        {coffee.filled}
                        <span className="u">/8</span>
                      </div>
                      <div className="foot">
                        <span className="mk" />
                        {coffee.linked ? "с заливкой сейчас" : "точка не привязана"}
                        <span className="go">→</span>
                      </div>
                    </div>
                  ) : (
                    <div className="tile" data-mc-tab="content" role="button" tabIndex={0}>
                      <span className="lab">Раскладка</span>
                      <div className="v">{planogramCount}</div>
                      <div className="foot">
                        <span className="mk" />
                        слотов с товаром<span className="go">→</span>
                      </div>
                    </div>
                  )}
                  <div className="tile" data-mc-tab="service" role="button" tabIndex={0}>
                    <span className="lab">Узлы</span>
                    <div className="v">{partsCount}</div>
                    <div className="foot">
                      <span className="mk" />
                      установлено сейчас<span className="go">→</span>
                    </div>
                  </div>
                  {pricesCount > 0 && (
                    <div className="tile" data-mc-tab="content" role="button" tabIndex={0}>
                      <span className="lab">Прайс</span>
                      <div className="v">{pricesCount}</div>
                      <div className="foot">
                        <span className="mk" />
                        товаров в продаже<span className="go">→</span>
                      </div>
                    </div>
                  )}
                  <div className="tile" data-mc-tab="place" role="button" tabIndex={0}>
                    <span className="lab">Стоянки</span>
                    <div className="v">{placements.length}</div>
                    <div className="foot">
                      <span className="mk" />
                      {placements.length > 0 ? "периодов размещения" : "место не записано"}
                      <span className="go">→</span>
                    </div>
                  </div>
                </div>

                <div className="mc-grid">
                  <div className="card">
                    <h3 className="h2">Точка</h3>
                    <div className="mc-tiles">
                      <Tile
                        label="Стоит сейчас"
                        value={точка ?? "место не записано"}
                        empty={точка === null}
                        wide
                      />
                      {mapHref ? (
                        <Tile label="Карта" value="открыть точку" href={mapHref} />
                      ) : (
                        <Tile label="Координаты" value="не указаны" empty />
                      )}
                      <Tile
                        label="Периодов"
                        value={placements.length > 0 ? String(placements.length) : "—"}
                        mono
                      />
                    </div>
                  </div>

                  <div className="card">
                    <h3 className="h2">Идентификация</h3>
                    <div className="mc-tiles">
                      <Tile label="Серийник" value={entity.externalRef ?? "—"} mono />
                      <Tile
                        label="Вид"
                        value={MACHINE_KIND_LABELS[(kind ?? "other") as MachineKind] ?? "—"}
                      />
                      {источник ? <Tile label="Источник" value={источник} /> : null}
                      <Tile label="Обновлено" value={when(entity.updatedAt)} />
                    </div>
                  </div>

                  <div className="card">
                    <h3 className="h2">Требует внимания</h3>
                    {внимание.length === 0 ? (
                      <p className="hint">Карточка заполнена — дозаполнять нечего.</p>
                    ) : (
                      <div className="rows">
                        {внимание.map(([, text, tab]) => (
                          <div className="row mc-attn" key={text} data-mc-tab={tab} role="button" tabIndex={0}>
                            <div className="t">
                              <b>{text}</b>
                            </div>
                            <span className="pill">исправить →</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </>
            ),
          },
          {
            key: "content",
            label: "Содержимое",
            badge:
              coffee !== null
                ? coffee.filled > 0
                  ? `${coffee.filled}/8`
                  : undefined
                : planogramCount > 0
                  ? String(planogramCount)
                  : undefined,
            content: slots.content,
          },
          {
            key: "service",
            label: "Обслуживание",
            badge: partsCount > 0 ? String(partsCount) : undefined,
            content: slots.service,
          },
          {
            key: "place",
            label: "Точка",
            badge: placements.length > 0 ? String(placements.length) : undefined,
            content: slots.place,
          },
          { key: "passport", label: "Паспорт", content: slots.passport },
        ]}
      />
    </div>
  );
}
