import Link from "next/link";
import type { MachineProductPrice, PriceReview, ProductPriceSpread } from "../lib/core";
import { plural } from "../lib/format";

/** Дата без времени: в истории цен секунды не нужны. */
function day(v: string): string {
  const d = v.slice(0, 10).split("-");
  return d.length === 3 ? `${d[2]}.${d[1]}.${d[0]}` : v;
}

/** Цена без «сум» в хвосте — в столбце цен единица и так очевидна. */
function num(n: number): string {
  return n.toLocaleString("ru-RU");
}

/**
 * Лента цен одного товара на одном автомате.
 *
 * Цена — не поле, а период: пока её не поменяли, она держится. Отрезки
 * восстановлены из заказов, поэтому охватывают весь период выгрузки.
 */
export function PriceTimeline({ periods }: { periods: MachineProductPrice["periods"] }) {
  if (periods.length === 0) return null;
  const last = periods.length - 1;
  return (
    <div className="stays">
      {periods.map((p, i) => {
        const prev = periods[i - 1];
        const move = prev === undefined ? "" : p.price > prev.price ? "up" : "down";
        return (
          <div className={`stay ${i === last ? "now" : ""}`} key={`${p.price}-${p.from}`}>
            <div className="stayp">
              {num(p.price)} сум
              {move === "up" && <span className="chip g">подняли</span>}
              {move === "down" && <span className="chip h">опустили</span>}
              {i === last && <span className="chip">сейчас</span>}
            </div>
            <div className="stayd mono">
              {day(p.from)} — {i === last ? "по сей день" : day(p.to)}
            </div>
            <div className="stayn mono">{num(p.orders)} заказов</div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Ассортимент и цены одного автомата — для его карточки.
 *
 * Сверху то, чем торгуют больше: остальное — хвост истории, где важен сам факт,
 * что товар когда-то продавался, а не его цена.
 */
export function MachinePricesView({ items }: { items: MachineProductPrice[] }) {
  if (items.length === 0) {
    return (
      <div className="empty">
        <b>Цены пока не собраны</b>
        Для них нужна выгрузка заказов: цена восстанавливается из них, а не
        заводится руками.
      </div>
    );
  }
  const changed = items.filter((i) => i.changes > 0).length;
  const messy = items.filter((i) => i.mismatched > 0).length;

  return (
    <>
      <p className="hint" style={{ marginBottom: 10 }}>
        Товаров в истории: {items.length}
        {changed > 0 && `, цену меняли у ${changed}`}
        {messy > 0 && `, у ${messy} заказы идут по разным ценам вперемешку`}.
      </p>
      {items.map((i) => (
        <div className="sect" key={i.product} style={{ marginTop: 14 }}>
          <div className="sect-h">
            <h3 className="h2">
              {i.productEntityId ? (
                <Link href={`/card/${i.productEntityId}`} style={{ color: "var(--accent)" }}>
                  {i.product}
                </Link>
              ) : (
                i.product
              )}
            </h3>
            {i.price !== null && <span className="chip b mono">{num(i.price)} сум</span>}
            {i.changes > 0 ? (
              <span className="chip">
                {i.changes} {plural(i.changes, "смена", "смены", "смен")} цены
              </span>
            ) : (
              <span className="chip">цена не менялась</span>
            )}
            {i.productEntityId === null && <span className="chip h">нет карточки товара</span>}
            {i.mismatched > 0 && (
              <span className="chip h">{num(i.mismatched)} заказов по чужой цене</span>
            )}
          </div>
          <PriceTimeline periods={i.periods} />
        </div>
      ))}
    </>
  );
}

/** Один товар в сквозном срезе: эталон, кто по чём торгует и кто отстал. */
function ProductSpread({ p }: { p: ProductPriceSpread }) {
  return (
    <div className="sect" style={{ marginTop: 18 }}>
      <div className="sect-h">
        <h3 className="h2">
          {p.entityId ? (
            <Link href={`/card/${p.entityId}`} style={{ color: "var(--accent)" }}>
              {p.product}
            </Link>
          ) : (
            p.product
          )}
        </h3>
        {p.reference !== null ? (
          <span className="chip b mono">эталон {num(p.reference)} сум</span>
        ) : (
          <span className="chip h">цены расходятся, большинства нет</span>
        )}
        {p.behind > 0 && (
          <span className="chip h">
            отстали: {p.behind} {plural(p.behind, "автомат", "автомата", "автоматов")}
          </span>
        )}
        {p.lost > 0 && <span className="chip h mono">мимо кассы {num(p.lost)} сум</span>}
        {p.entityId === null && <span className="chip">нет карточки товара</span>}
      </div>

      {p.referenceSince !== null && p.behind > 0 && (
        <p className="hint" style={{ marginBottom: 8 }}>
          Эталон стал ценой большинства {day(p.referenceSince)} — недобор считается с этого дня,
          а не с того, когда цену поднял первый автомат.
        </p>
      )}

      <div className="maplist">
        {p.machines.map((m) => (
          <div className={`maprow ${m.gap > 0 ? "hot" : ""}`} key={m.serial}>
            <div className="mapv">
              <span className="mapl">
                {m.entityId ? (
                  <Link href={`/card/${m.entityId}`} style={{ color: "var(--accent)" }}>
                    {m.entityName}
                  </Link>
                ) : (
                  m.serial
                )}
              </span>
              <span className="mapc mono">{m.serial}</span>
            </div>
            <div className="mapt">
              <span className="mono" style={{ fontWeight: 600 }}>
                {num(m.price)} сум
              </span>
              <span className="mapc">с {day(m.since)}</span>
              {!m.active && <span className="chip">молчит с {day(m.lastOrderAt)}</span>}
              {m.gap > 0 && (
                <>
                  <span className="chip h mono">−{num(m.gap)} за стакан</span>
                  <span className="chip h mono">
                    {num(m.ordersSince)} {plural(m.ordersSince, "стакан", "стакана", "стаканов")} ·{" "}
                    {num(m.lost)} сум
                  </span>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Сквозной срез по ценам.
 *
 * Отставание — это не «дешевле всех», а «дешевле цены большинства»: один
 * автомат, где цену подняли раньше срока, не делает остальные отставшими.
 * Поэтому эталон берётся большинством, а при ничьей не берётся вовсе.
 */
export function PricesView({ review }: { review: PriceReview }) {
  if (review.products.length === 0) {
    return (
      <div className="empty">
        <b>Цен пока нет</b>
        Для них нужна выгрузка, где у заказа есть автомат, товар, цена и время.
      </div>
    );
  }

  const behind = review.products.filter((p) => p.behind > 0).length;
  const noRef = review.products.filter((p) => p.reference === null).length;

  return (
    <>
      <div className="tiles" style={{ marginBottom: 14 }}>
        <div className="tile mini">
          <div className="lab">Товаров в продаже</div>
          <div className="v">{review.products.length}</div>
          <div className="foot">
            <span className="mk" />по заказам источника
          </div>
        </div>
        <div className={`tile mini ${review.lost > 0 ? "is-hot" : "zero"}`}>
          <div className="lab">Мимо кассы</div>
          <div className="v">{num(review.lost)}</div>
          <div className="foot">
            <span className="mk" />
            {review.lost > 0 ? "на уже совершённых продажах" : "цены сходятся"}
          </div>
        </div>
        <div className={`tile mini ${behind > 0 ? "is-hot" : "zero"}`}>
          <div className="lab">Товаров с отставшей ценой</div>
          <div className="v">{behind}</div>
          <div className="foot">
            <span className="mk" />
            {behind > 0 ? "где-то продают дешевле большинства" : "везде одна цена"}
          </div>
        </div>
        <div className={`tile mini ${noRef > 0 ? "" : "zero"}`}>
          <div className="lab">Без эталона</div>
          <div className="v">{noRef}</div>
          <div className="foot">
            <span className="mk" />
            {noRef > 0 ? "цены разошлись, большинства нет" : "у всех есть цена большинства"}
          </div>
        </div>
      </div>

      <p className="hint" style={{ marginBottom: 12 }}>
        Цена восстановлена из заказов и, как точка, является периодом, а не полем.
        Сменой цены считается только та, где старая цена кончилась раньше, чем
        началась новая: если две цены идут вперемешку, это не смена, а подмена
        кнопки — пробит один напиток, приготовлен другой.
        {review.unreadable > 0 && (
          <> Заказов с нечитаемой ценой: {num(review.unreadable)} — в расчёт не вошли.</>
        )}
        {review.lastOrderAt !== null && (
          <> Последний заказ в выгрузке — {day(review.lastOrderAt)}; молчащие автоматы
          отставшими не считаются.</>
        )}
      </p>

      {review.products.map((p) => (
        <ProductSpread key={p.product} p={p} />
      ))}
    </>
  );
}
