import Link from "next/link";
import type { ReactNode } from "react";
import { cardPrice, pricePerGram } from "@mydon/shared";
import type { CoffeeBunkerIngredient, Entity, StockBatchRow } from "../lib/core";
import { CardTabs } from "./card-tabs";
import { FLAG_CHIP_CLASS, FLAG_LABELS, rowDueLabel } from "./expiry-book";
import { fmtDay } from "../lib/globerent";
import { when } from "../lib/format";

const sum = (n: number) => n.toLocaleString("ru-RU");

function число(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim().length > 0) {
    const n = Number(v.replace(/[\s\u00A0\u202F]/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function строка(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/**
 * Ближайший срок среди партий этого сырья: минимум `expiry` среди тех, у
 * кого он вообще посчитан (`null` — у карточки нет норматива и приход не
 * указал срок явно, флаг `"none"`). Строки без `expiry` не участвуют в
 * сравнении — иначе «нет срока» выиграло бы гонку за самую раннюю дату.
 */
function nearestBatchExpiry(rows: StockBatchRow[]): StockBatchRow | null {
  let best: (StockBatchRow & { expiry: string }) | null = null;
  for (const row of rows) {
    if (row.expiry === null) continue;
    if (best === null || row.expiry < best.expiry) best = { ...row, expiry: row.expiry };
  }
  return best;
}

/**
 * KPI «Ближайший срок» на Обзоре (§ Your Job, шаг 2). Три честных состояния —
 * ни одно не подменяет другое: партий нет ≠ срок в порядке ≠ Core не ответил.
 * Текст срока — `rowDueLabel` из `expiry-book.tsx` (Task 5): то же слово
 * «через N дней»/«истёк N дней назад», что и на листе «Сроки годности».
 */
function batchesKpi(
  rows: StockBatchRow[] | null,
  today: string,
): { value: string; foot: string; hot: boolean } {
  if (rows === null) return { value: "—", foot: "не удалось проверить", hot: false };
  if (rows.length === 0) return { value: "—", foot: "партий нет", hot: false };
  const nearest = nearestBatchExpiry(rows);
  if (nearest === null) return { value: "—", foot: "без срока годности", hot: false };
  const due = rowDueLabel(nearest, today);
  return {
    value: due.text,
    foot: nearest.batchCode ? `партия ${nearest.batchCode}` : "код партии не указан",
    hot: nearest.flag === "expired" || nearest.flag === "expiring",
  };
}

/** Строка «где используется»: товар, норма на порцию, доля в его себестоимости. */
export interface IngredientUsageRow {
  productId: string;
  productName: string;
  quantity: number;
  unit: string;
  /**
   * Доля строки этого ингредиента в себестоимости товара, 0..1. null — не
   * посчиталась: у какой-то строки рецепта нет цены/единицы или единицы
   * несовместимы (та же причина, что у `RecipeCost.unresolved`).
   */
  costShare: number | null;
}

/**
 * Карточка ингредиента 360 — тот же приём, что у товара и контрагента: шапка
 * с главным, кольцо полноты, KPI-плитки и вкладки.
 *
 * Разделы свои: где используется (обратный разбор составов товаров), бункеры
 * (мост `coffee_ingredient.entityId`, срез B — миграция 0059), закупки
 * (история цены и розничные чеки — сегодня есть только у карточки «Сахар»),
 * склад (остаток и приход — уже существовавший `StockPanel`), паспорт.
 *
 * Цена за грамм и цена карточки читаются здесь же из `entity.attrs` через
 * `cardPrice`/`pricePerGram` (`@mydon/shared`, срез B, Task 2) — тот же расчёт,
 * что использует Core для себестоимости бункерного расхода: цифры на карточке
 * и в бункере не должны разойтись.
 */
export function IngredientCard360({
  entity,
  usage,
  bunkerCount,
  bunkerNameMatch,
  supplierId,
  photosCount,
  batches,
  slots,
}: {
  entity: Entity;
  usage: IngredientUsageRow[];
  /** Сколько позиций бункера ссылается на эту карточку. null — реестр не ответил. */
  bunkerCount: number | null;
  /** В бункерном реестре есть позиция с тем же именем, но мост (`entityId`) на неё не проставлен. */
  bunkerNameMatch: boolean;
  /** Карточка контрагента, чьё имя совпало с полем «поставщик». null — не совпало или поставщик не указан. */
  supplierId: string | null;
  photosCount: number;
  /** Партии этого сырья (Task 6). null — Core не ответил на `/stock/batches`; это НЕ «партий нет». */
  batches: StockBatchRow[] | null;
  slots: {
    usage: ReactNode;
    bunkers: ReactNode;
    purchases: ReactNode;
    batches: ReactNode;
    stock: ReactNode;
    passport: ReactNode;
  };
}) {
  const a = entity.attrs ?? {};
  const approved = entity.approvedAt != null;
  const price = cardPrice(a);
  const perGram = pricePerGram(a);
  const поставщик = строка(a["поставщик"]);
  const срокГодности = число(a["срок годности, дней"]);
  const весУпаковки = число(a["вес упаковки, г"]);
  const покупок = Array.isArray(a["закупки сахара"]) ? (a["закупки сахара"] as unknown[]).length : 0;
  // «Сегодня» по Ташкенту (тот же приём, что `todayKey` в domain/page.tsx) —
  // только для текста «через N дней»: сам флаг уже посчитан Core на своём `now`.
  const сегодня = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" });
  const batchKpi = batchesKpi(batches, сегодня);

  // Полнота карточки: чего не хватает, чтобы ингредиент считался заведённым.
  const метки: [boolean, string, string][] = [
    [approved, "Карточка не утверждена", "passport"],
    [price !== null, "Цена покупки не указана", "passport"],
    [usage.length > 0, "Не входит ни в один рецепт", "usage"],
    [photosCount > 0, "Нет фото", "passport"],
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
          🧂
        </div>
        <div className="mc-id">
          <h1>{entity.name}</h1>
          <p className="mc-sub">
            {price ? `${sum(price.price)} сум/${price.unit}` : "цена не указана"}
            {perGram !== null ? ` · ${sum(perGram)} сум/г` : ""}
          </p>
          <div className="mc-badges">
            {price && <span className="chip b">{price.unit}</span>}
            {bunkerCount !== null && bunkerCount > 0 && (
              <span className="chip g" data-mc-tab="bunkers" role="button" tabIndex={0}>
                бункер{bunkerCount > 1 ? ` × ${bunkerCount}` : ""}
              </span>
            )}
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
                    <span className="lab">Цена покупки</span>
                    <div className="v">{price ? sum(price.price) : "—"}</div>
                    <div className="foot">
                      <span className="mk" />
                      {price ? `сум за «${price.unit}»` : "не указана"}
                    </div>
                  </div>
                  <div className="tile">
                    <span className="lab">Цена за грамм</span>
                    <div className="v">{perGram !== null ? sum(perGram) : "—"}</div>
                    <div className="foot">
                      <span className="mk" />
                      {perGram !== null
                        ? "сум/г · для себестоимости"
                        : price
                          ? "единица не весовая"
                          : "цены нет"}
                    </div>
                  </div>
                  <div className="tile">
                    <span className="lab">Поставщик</span>
                    <div className="v">
                      {supplierId ? <Link href={`/card/${supplierId}`}>{поставщик}</Link> : (поставщик ?? "—")}
                    </div>
                    <div className="foot">
                      <span className="mk" />
                      {supplierId ? "карточка контрагента" : поставщик ? "имя не совпало с реестром" : "не указан"}
                    </div>
                  </div>
                  <div className="tile">
                    <span className="lab">Срок годности</span>
                    <div className="v">{срокГодности !== null ? срокГодности : "—"}</div>
                    <div className="foot">
                      <span className="mk" />
                      {срокГодности !== null ? "дней · норматив хранения" : "не указан"}
                    </div>
                  </div>
                  <div className="tile">
                    <span className="lab">Вес упаковки</span>
                    <div className="v">{весУпаковки !== null ? sum(весУпаковки) : "—"}</div>
                    <div className="foot">
                      <span className="mk" />
                      {весУпаковки !== null ? "грамм · паспорт" : "не указан"}
                    </div>
                  </div>
                  <div className="tile" data-mc-tab="usage" role="button" tabIndex={0}>
                    <span className="lab">Где используется</span>
                    <div className="v">{usage.length}</div>
                    <div className="foot">
                      <span className="mk" />
                      товаров с этим ингредиентом<span className="go">→</span>
                    </div>
                  </div>
                  <div className="tile" data-mc-tab="bunkers" role="button" tabIndex={0}>
                    <span className="lab">Бункеры</span>
                    <div className="v">{bunkerCount ?? "—"}</div>
                    <div className="foot">
                      <span className="mk" />
                      {bunkerCount === null
                        ? "не удалось проверить"
                        : bunkerCount > 0
                          ? "позиций заливки"
                          : bunkerNameMatch
                            ? "мост не проставлен"
                            : "не бункерный"}
                      <span className="go">→</span>
                    </div>
                  </div>
                  <div
                    className={`tile${batchKpi.hot ? " is-hot" : ""}`}
                    data-mc-tab="batches"
                    role="button"
                    tabIndex={0}
                  >
                    <span className="lab">Ближайший срок</span>
                    <div className="v">{batchKpi.value}</div>
                    <div className="foot">
                      <span className="mk" />
                      {batchKpi.foot}
                      <span className="go">→</span>
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
            key: "usage",
            label: "Где используется",
            badge: usage.length > 0 ? String(usage.length) : undefined,
            content: slots.usage,
          },
          {
            key: "bunkers",
            label: "Бункеры",
            badge: bunkerCount !== null && bunkerCount > 0 ? String(bunkerCount) : undefined,
            content: slots.bunkers,
          },
          {
            key: "purchases",
            label: "Закупки",
            badge: покупок > 0 ? String(покупок) : undefined,
            content: slots.purchases,
          },
          {
            key: "batches",
            label: "Партии",
            badge: batches !== null && batches.length > 0 ? String(batches.length) : undefined,
            content: slots.batches,
          },
          { key: "stock", label: "Остаток", content: slots.stock },
          { key: "passport", label: "Паспорт", content: slots.passport },
        ]}
      />
    </div>
  );
}

/** Где используется: обратный разбор составов товаров (`entity(product).attrs["состав"]`). */
export function IngredientUsageSection({ rows }: { rows: IngredientUsageRow[] }) {
  return (
    <div className="sect" id="usage">
      <div className="sect-h">
        <h3 className="h2">Где используется</h3>
        <span className="chip">{rows.length}</span>
        <span className="sp" />
      </div>
      {rows.length === 0 ? (
        <div className="empty">
          <b>Ни в одном рецепте</b>
          Состав задаётся на карточке товара с принципом «С рецептом» — этот ингредиент
          туда пока не попал.
        </div>
      ) : (
        <div className="rows">
          {rows.map((row) => (
            <div className="row" key={row.productId}>
              <div className="t">
                <Link href={`/card/${row.productId}`}>{row.productName}</Link>
              </div>
              <span className="pill">
                {row.quantity} {row.unit} на порцию
              </span>
              <span className="pill">
                {row.costShare !== null
                  ? `${Math.round(row.costShare * 100)}% себестоимости`
                  : "доля не посчиталась"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Бункеры: позиции бункерного реестра, куда подставлена эта карточка через
 * мост `coffee_ingredient.entityId` (срез B). Пустая секция без объяснения
 * значила бы «данных нет» там, где на самом деле два разных честных ответа:
 * тара в бункеры не идёт вовсе, а бункерный ингредиент может ждать моста.
 */
export function IngredientBunkers({
  rows,
  nameMatch,
}: {
  /** null — бункерный реестр не ответил; это НЕ то же самое, что пустой список. */
  rows: CoffeeBunkerIngredient[] | null;
  /** Позиция с тем же именем есть в бункерном реестре, но мост на эту карточку не проставлен. */
  nameMatch: boolean;
}) {
  return (
    <div className="sect" id="bunkers">
      <div className="sect-h">
        <h3 className="h2">Бункеры</h3>
        <span className="chip">{rows === null ? "—" : rows.length}</span>
        <span className="sp" />
      </div>
      {rows === null ? (
        <div className="empty">
          <b>Не удалось проверить</b>
          Бункерный реестр не ответил — обнови страницу. Это не значит, что карточка не
          бункерная: ответа просто нет.
        </div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <b>{nameMatch ? "Карточка не связана с бункерным реестром" : "Не бункерный ингредиент"}</b>
          {nameMatch
            ? "В бункерном реестре есть позиция с таким же именем, но мост (entityId) на эту карточку " +
              "не проставлен — заливка считает себестоимость по запасной цене реестра, а не по карточке."
            : "Эта карточка не используется в кофейных бункерах — например, тара в них не заливается."}
        </div>
      ) : (
        <div className="rows">
          {rows.map((row) => (
            <div className="row" key={row.position}>
              <div className="t">
                <b>Позиция {row.position}</b>
              </div>
              <span className="pill">
                {row.purchasePrice !== null ? `${sum(row.purchasePrice)} сум/г` : "цены нет"}
                {row.priceSource ? ` · ${row.priceSource}` : ""}
              </span>
              <span className="pill">
                {row.targetFillWeight !== null ? `эталон ${sum(row.targetFillWeight)} г` : "эталон не задан"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Партии (Task 6, срез C): приход, остаток леджером, срок и флаг, вскрыта ли,
 * поставщик, документ. Флаг и подписи — те же `FLAG_LABELS`/`FLAG_CHIP_CLASS`
 * и текст срока — та же `rowDueLabel`, что и на листе «Сроки годности» (Task
 * 5, `expiry-book.tsx`): один словарь на карточку и на отчёт, не два.
 *
 * Поставщик — ссылка на карточку контрагента при `supplierId`; иначе
 * `supplierRaw`, как ввёл человек, с пометкой «не совпало с реестром» (то же
 * слово, что и в тайле «Поставщик» на Обзоре этой же карточки, чуть выше).
 * Ничего не вводили — строка о поставщике не показывается вовсе, иначе
 * «не вводили» выглядело бы так же, как «ввели с опечаткой».
 */
export function IngredientBatches({ rows }: { rows: StockBatchRow[] | null }) {
  const сегодня = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" });
  return (
    <div className="sect" id="batches">
      <div className="sect-h">
        <h3 className="h2">Партии</h3>
        <span className="chip">{rows === null ? "—" : rows.length}</span>
        <span className="sp" />
      </div>
      {rows === null ? (
        <div className="empty">
          <b>Не удалось проверить</b>
          Core не ответил на запрос партий (/stock/batches) — обнови страницу. Это не значит,
          что партий нет: ответа просто нет.
        </div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <b>Партии ещё не заводились</b>
          Остаток этого сырья заведён снимком без привязки к партии — заведи первый приход с
          партией во вкладке «Остаток», тогда здесь появятся дата, срок и документ.
        </div>
      ) : (
        <div className="rows">
          {rows.map((row) => {
            const due = rowDueLabel(row, сегодня);
            const документ = row.invoiceNo
              ? `счёт-фактура № ${row.invoiceNo}${row.invoiceDate ? ` от ${fmtDay(row.invoiceDate)}` : ""}`
              : "документ не указан";
            return (
              <div className="row" key={row.id}>
                <div className="t">
                  <b>{row.batchCode ?? "без кода"}</b>
                  <small>
                    получено {fmtDay(row.receivedOn)} · {row.warehouseName} · остаток{" "}
                    {sum(row.remaining)} {row.unit}
                  </small>
                  <small>
                    {row.opened ? `вскрыта${row.openedOn ? ` ${fmtDay(row.openedOn)}` : ""}` : "не вскрыта"}
                  </small>
                  {row.supplierId ? (
                    <small>
                      поставщик: <Link href={`/card/${row.supplierId}`}>{row.supplierName ?? "без имени в карточке"}</Link>
                    </small>
                  ) : row.supplierRaw ? (
                    <small>поставщик: «{row.supplierRaw}» — не совпало с реестром</small>
                  ) : null}
                  <small>{документ}</small>
                </div>
                <span className={FLAG_CHIP_CLASS[row.flag]}>{FLAG_LABELS[row.flag]}</span>
                <span className="pill">{due.text}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Закупки: авто-история цены (`"история цены покупки"`, ведётся Core при
 * смене цены) и розничные чеки — сегодня только массив `"закупки сахара"` на
 * карточке «Сахар» (R-B7: ключ не переименован). Другие карточки такого
 * массива не заводили — секция честно пустая, а не выдумывает записи.
 */
export function IngredientPurchases({ entity }: { entity: Entity }) {
  const a = entity.attrs ?? {};
  const история = строка(a["история цены покупки"]);
  const закупки = Array.isArray(a["закупки сахара"]) ? (a["закупки сахара"] as unknown[]) : [];

  if (история === null && закупки.length === 0) {
    return (
      <div className="empty">
        <b>Закупки не зафиксированы</b>
        История цены и розничные чеки появятся здесь, когда владелец занесёт их в карточку.
      </div>
    );
  }

  return (
    <div className="sect" id="purchases">
      <div className="sect-h">
        <h3 className="h2">Закупки</h3>
        {закупки.length > 0 && <span className="chip b">чеков: {закупки.length}</span>}
        <span className="sp" />
      </div>
      {закупки.length > 0 && (
        <div className="rows">
          {закупки.map((raw, i) => {
            const row = (raw ?? {}) as Record<string, unknown>;
            const дата = строка(row["дата"]);
            const магазин = строка(row["магазин"]) ?? строка(row["поставщик"]);
            const ценаЗаКг = число(row["цена за кг"]);
            const чек = строка(row["чек"]);
            return (
              <div className="row" key={`${дата ?? "запись"}-${i}`}>
                <div className="t">
                  <b>{дата ?? "дата не указана"}</b>
                  {магазин && <small>{магазин}</small>}
                  {чек && <small>{чек}</small>}
                </div>
                <span className="pill">
                  {ценаЗаКг !== null ? `${sum(ценаЗаКг)} сум/кг` : "цена не указана"}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {история && (
        <p className="hint" style={{ marginTop: 10, whiteSpace: "pre-line" }}>
          История цены покупки: {история}
        </p>
      )}
    </div>
  );
}
