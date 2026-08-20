import type { ReactNode } from "react";
import { CONTRACTOR_ROLE_LABELS, contractorDirections, type ContractorRole } from "@mydon/shared";
import type { Entity } from "../lib/core";
import { CardTabs } from "./card-tabs";
import { when } from "../lib/format";
import { DOMAIN_TITLES } from "../lib/labels";

const sum = (n: number) => n.toLocaleString("ru-RU");

/** Роли карточки — массив строк в attrs, у старых записей может не быть вовсе. */
function ролиОф(entity: Entity): string[] {
  const r = (entity.attrs ?? {})["roles"];
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === "string") : [];
}

function числоОф(entity: Entity, key: string): number | null {
  const v = (entity.attrs ?? {})[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function строкаОф(entity: Entity, key: string): string | null {
  const v = (entity.attrs ?? {})[key];
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/**
 * Карточка контрагента — тот же приём, что у автомата и товара: шапка с
 * главным, кольцо полноты, KPI-плитки и вкладки.
 *
 * Разделы свои: что поставляет (позиции и цены из книги закупок), деньги и
 * документы (договоры и платежи финансового контура), паспорт. Контрагент —
 * одна карточка на юрлицо: ИНН уникален во всём реестре, а направления, где он
 * работает, показаны бейджами.
 */
export function ContractorCard360({
  entity,
  documentsCount,
  contractsCount,
  flowsCount,
  slots,
}: {
  entity: Entity;
  documentsCount: number;
  contractsCount: number;
  flowsCount: number;
  slots: {
    supplies: ReactNode;
    money: ReactNode;
    passport: ReactNode;
  };
}) {
  const approved = entity.approvedAt != null;
  const инн = entity.externalRef?.trim() || null;
  const роли = ролиОф(entity);
  const направления = contractorDirections(entity.attrs);
  const оборот = числоОф(entity, "оборот по реестру");
  const закупок = числоОф(entity, "закупок в реестре");
  const счетов = числоОф(entity, "счетов в реестре");
  const период = строкаОф(entity, "период поставок");
  const позиции = Array.isArray((entity.attrs ?? {})["что поставляет"])
    ? ((entity.attrs ?? {})["что поставляет"] as unknown[])
    : [];

  // Полнота карточки: чего не хватает, чтобы контрагент считался заведённым.
  const метки: [boolean, string, string][] = [
    [approved, "Карточка не утверждена", "passport"],
    [инн !== null, "ИНН не указан — контрагента не свести с документами", "passport"],
    [роли.length > 0, "Роль не задана: клиент, поставщик или агент", "passport"],
    [направления.length > 0, "Не отмечено ни одно направление", "passport"],
    [позиции.length > 0, "Не видно, что поставляет", "supplies"],
    [documentsCount + contractsCount > 0, "Нет ни одного документа или договора", "money"],
  ];
  const заполнено = метки.filter(([ok]) => ok).length;
  const pct = Math.round((заполнено / метки.length) * 100);
  const внимание = метки.filter(([ok]) => !ok);
  const r = 22;
  const c = 2 * Math.PI * r;

  return (
    <div className="mc">
      <header className="mc-hero">
        <div className="mc-ava" aria-hidden>
          🤝
        </div>
        <div className="mc-id">
          <h1>{entity.name}</h1>
          <p className="mc-sub">
            {инн ? <>ИНН <span className="mono">{инн}</span></> : "ИНН не указан"}
            {период ? <> · поставки {период}</> : null}
          </p>
          <div className="mc-badges">
            {роли.map((role) => (
              <span className="chip b" key={role}>
                {CONTRACTOR_ROLE_LABELS[role as ContractorRole] ?? role}
              </span>
            ))}
            {направления.map((d) => (
              <span className="chip" key={d}>
                {DOMAIN_TITLES[d] ?? d}
              </span>
            ))}
            {!approved && (
              <span className="chip h" data-mc-tab="passport" role="button" tabIndex={0}>
                ждёт утверждения
              </span>
            )}
          </div>
        </div>
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
      </header>

      <div className="mc-meta">
        <span>
          обновлено <b>{when(entity.updatedAt)}</b>
        </span>
        {entity.createdFrom && (
          <span>
            источник <b>{entity.createdFrom}</b>
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
                  <div className="tile">
                    <span className="lab">Оборот</span>
                    <div className="v">{оборот !== null ? sum(оборот) : "—"}</div>
                    <div className="foot">
                      <span className="mk" />
                      {оборот !== null ? "по книге закупок" : "закупки не сведены"}
                    </div>
                  </div>
                  <div className="tile" data-mc-tab="supplies" role="button" tabIndex={0}>
                    <span className="lab">Поставляет</span>
                    <div className="v">{позиции.length}</div>
                    <div className="foot">
                      <span className="mk" />
                      позиций{закупок !== null ? ` · закупок ${закупок}` : ""}
                      <span className="go">→</span>
                    </div>
                  </div>
                  <div className="tile" data-mc-tab="money" role="button" tabIndex={0}>
                    <span className="lab">Документы</span>
                    <div className="v">{documentsCount + contractsCount}</div>
                    <div className="foot">
                      <span className="mk" />
                      договоров {contractsCount}
                      {счетов !== null ? ` · счетов ${счетов}` : ""}
                      <span className="go">→</span>
                    </div>
                  </div>
                  <div className="tile" data-mc-tab="money" role="button" tabIndex={0}>
                    <span className="lab">Платежи</span>
                    <div className="v">{flowsCount}</div>
                    <div className="foot">
                      <span className="mk" />
                      в финансовом контуре<span className="go">→</span>
                    </div>
                  </div>
                </div>

                <div className="mc-grid">
                  <div className="card">
                    <h3 className="h2">Требует внимания</h3>
                    {внимание.length === 0 ? (
                      <p className="hint">Карточка заполнена — дозаполнять нечего.</p>
                    ) : (
                      <div className="rows">
                        {внимание.map(([, text, tab]) => (
                          <div
                            className="row mc-attn"
                            key={text}
                            data-mc-tab={tab}
                            role="button"
                            tabIndex={0}
                          >
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
            key: "supplies",
            label: "Закупки",
            badge: позиции.length > 0 ? String(позиции.length) : undefined,
            content: slots.supplies,
          },
          {
            key: "money",
            label: "Документы и деньги",
            badge: contractsCount + flowsCount > 0 ? String(contractsCount + flowsCount) : undefined,
            content: slots.money,
          },
          { key: "passport", label: "Паспорт", content: slots.passport },
        ]}
      />
    </div>
  );
}

/** Что и почём поставлял — снимок из книги закупок владельца. */
export function ContractorSupplies({ entity }: { entity: Entity }) {
  const raw = (entity.attrs ?? {})["что поставляет"];
  const позиции = Array.isArray(raw) ? raw : [];
  const период = строкаОф(entity, "период поставок");

  if (позиции.length === 0) {
    return (
      <div className="empty">
        <b>Закупки не сведены</b>
        По этому контрагенту нет ни одной позиции из книги закупок. Он появится здесь, когда его
        поставки свяжут с реестром.
      </div>
    );
  }

  return (
    <div className="sect">
      <div className="sect-h">
        <h3 className="h2">Что поставляет</h3>
        <span className="chip b">позиций: {позиции.length}</span>
      </div>
      <div className="book">
        <div className="th">
          <span>Наименование</span>
          <span>Всего</span>
          <span style={{ textAlign: "right" }}>Цены, сум</span>
        </div>
        {позиции.map((p, i) => {
          const row = (p ?? {}) as Record<string, unknown>;
          const имя = typeof row["наименование"] === "string" ? row["наименование"] : "—";
          const ед = typeof row["ед"] === "string" ? row["ед"] : "";
          const всего = typeof row["всего"] === "number" ? row["всего"] : null;
          const цены = Array.isArray(row["цены"]) ? (row["цены"] as unknown[]) : [];
          return (
            <div className="tr" key={`${имя}-${i}`}>
              <span className="nm">{имя}</span>
              <span className="cd">
                {всего !== null ? `${всего.toLocaleString("ru-RU")} ${ед}` : "—"}
              </span>
              <span className="pr">
                {цены.length > 0
                  ? цены
                      .filter((c): c is number => typeof c === "number")
                      .map((c) => c.toLocaleString("ru-RU"))
                      .join(" · ")
                  : "—"}
              </span>
            </div>
          );
        })}
      </div>
      <p className="hint" style={{ marginTop: 10 }}>
        Снимок из книги закупок владельца{период ? ` за ${период}` : ""}. Цены — как в счетах-фактурах,
        с НДС. Живая история партий появится, когда реестр закупок загрузят в склад.
      </p>
    </div>
  );
}
