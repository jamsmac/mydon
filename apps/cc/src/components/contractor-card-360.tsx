import Link from "next/link";
import type { ReactNode } from "react";
import { CONTRACTOR_ROLE_LABELS, contractorDirections, type ContractorRole } from "@mydon/shared";
import type { Entity, StockBatchRow } from "../lib/core";
import { CardTabs } from "./card-tabs";
import { fmtDay } from "../lib/globerent";
import { plural, when } from "../lib/format";
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
  batches,
  slots,
}: {
  entity: Entity;
  documentsCount: number;
  contractsCount: number;
  flowsCount: number;
  /**
   * Партии, где этот контрагент — поставщик (срез D, Task 5). null — Core не
   * ответил на /stock/batches; здесь используется только для бейджа и
   * «Требует внимания» — сам список рендерит `ContractorSupplies` в слоте.
   */
  batches: StockBatchRow[] | null;
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
  // Бейдж вкладки «Закупки»: легаси-снимок позиций плюс партии из реестра
  // (срез D) — обе витрины теперь в одной вкладке, как и у карточки сырья.
  const закупокВсего = позиции.length + (batches?.length ?? 0);

  // Полнота карточки: чего не хватает, чтобы контрагент считался заведённым.
  const метки: [boolean, string, string][] = [
    [approved, "Карточка не утверждена", "passport"],
    [инн !== null, "ИНН не указан — контрагента не свести с документами", "passport"],
    [роли.length > 0, "Роль не задана: клиент, поставщик или агент", "passport"],
    [направления.length > 0, "Не отмечено ни одно направление", "passport"],
    [закупокВсего > 0, "Не видно, что поставляет", "supplies"],
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
            badge: закупокВсего > 0 ? String(закупокВсего) : undefined,
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

/**
 * Закупки контрагента: две независимые витрины.
 *
 * 1) Легаси-снимок — `"что поставляет"` (позиции и диапазон цен), заведённый
 *    владельцем вручную до партий. Не связан с `batches` — показывается, если
 *    есть, независимо от них (та же логика, что и у `IngredientPurchases`).
 * 2) Живая история из партий (срез D, Task 5): что и когда покупали, по каким
 *    счетам и на какую сумму — из партий, где этот контрагент — поставщик.
 *    Три честных пустых состояния (см. `historyImported`) — урок срезов B и
 *    C: подмена одного другим уже дважды чинилась постфактум.
 */
export function ContractorSupplies({
  entity,
  batches,
  historyImported,
}: {
  entity: Entity;
  /** Партии, где этот контрагент — поставщик. null — Core не ответил на
   * /stock/batches; это НЕ значит, что закупок у него не было. */
  batches: StockBatchRow[] | null;
  /**
   * Хотя бы одна партия существует ГДЕ УГОДНО в системе (не только у этого
   * контрагента) — отличает «реестр закупок ещё не загружен вовсе» от
   * «у этого контрагента закупок не было».
   */
  historyImported: boolean;
}) {
  const raw = (entity.attrs ?? {})["что поставляет"];
  const позиции = Array.isArray(raw) ? raw : [];
  const период = строкаОф(entity, "период поставок");
  const легаси = позиции.length > 0;

  const счетов = batches !== null ? new Set(batches.map((b) => b.invoiceNo).filter((n): n is string => n !== null)).size : 0;
  const сумма = batches !== null ? batches.reduce((acc, b) => acc + (b.unitPriceGross !== null ? b.unitPriceGross * b.qtyReceived : 0), 0) : 0;

  return (
    <div className="sect">
      {легаси && (
        <>
          <div className="sect-h">
            <h3 className="h2">Что поставляет (снимок)</h3>
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
            Снимок из книги закупок владельца{период ? ` за ${период}` : ""}. Цены — как в
            счетах-фактурах, с НДС.
          </p>
        </>
      )}

      <div style={легаси ? { marginTop: 18 } : undefined}>
        {легаси && <h3 className="h2">Из партий (счета-фактуры)</h3>}
        {batches === null ? (
          // Пустое состояние 1/3: ядро не ответило — не «закупок не было».
          <div className="empty">
            <b>Не удалось проверить</b>
            Core не ответил на запрос партий (/stock/batches) — обнови страницу. Это не значит,
            что закупок у него не было: ответа просто нет.
          </div>
        ) : batches.length === 0 ? (
          historyImported ? (
            // Пустое состояние 2/3: реестр загружен, но этот контрагент в нём не встретился.
            <div className="empty">
              <b>Закупок у него не было</b>
              Среди импортированных партий нет ни одной с этим поставщиком.
            </div>
          ) : (
            // Пустое состояние 3/3: реестр закупок ещё не загружен вовсе (честный
            // факт прода на 21.08.2026 — партий нет ни у одного контрагента).
            <div className="empty">
              <b>История закупок ещё не импортирована</b>
              Реестр закупок владельца в систему пока не загружен — партии со счетами-фактурами
              появятся здесь после импорта.
            </div>
          )
        ) : (
          <>
            <div className="rows">
              {[...batches]
                .sort((x, y) => y.receivedOn.localeCompare(x.receivedOn))
                .map((b) => {
                  const цена = b.unitPriceGross;
                  const итого = цена !== null ? цена * b.qtyReceived : null;
                  return (
                    <div className="row" key={b.id}>
                      <div className="t">
                        <b>
                          <Link href={`/card/${b.ingredientId}`}>{b.ingredientName}</Link>
                        </b>
                        <small>
                          {fmtDay(b.receivedOn)} · {sum(b.qtyReceived)} {b.unit}
                        </small>
                        <small>
                          {b.invoiceNo
                            ? `счёт-фактура № ${b.invoiceNo}${b.invoiceDate ? ` от ${fmtDay(b.invoiceDate)}` : ""}`
                            : "документ не указан"}
                        </small>
                      </div>
                      <span className="pill">{цена !== null ? `${sum(Math.round(цена))} сум/${b.unit}` : "цена не указана"}</span>
                      <span className="pill b">{итого !== null ? `${sum(Math.round(итого))} сум` : "—"}</span>
                    </div>
                  );
                })}
            </div>
            <p className="hint" style={{ marginTop: 10 }}>
              Итого {plural(batches.length, "партия", "партии", "партий")}: {batches.length}
              {счетов > 0 ? ` · ${плюральСчёт(счетов)}` : ""} на сумму {sum(Math.round(сумма))} сум (с НДС).
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/** «1 счёт» / «2 счёта» / «5 счетов» — то же согласование, что у `plural`, но своё слово. */
function плюральСчёт(n: number): string {
  return `${n} ${plural(n, "счёт", "счёта", "счетов")}`;
}
