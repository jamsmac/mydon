"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import Link from "next/link";
import { createProductFromSource, linkRawValue } from "../app/sources/actions";
import type { ProductReview, SourceProduct } from "../lib/core";

/** Сумма без «сум» в хвосте: в столбце денег единица и так очевидна. */
function num(n: number): string {
  return Math.round(n).toLocaleString("ru-RU");
}

/** Дата без времени. */
function day(v: string): string {
  const d = v.slice(0, 10).split("-");
  return d.length === 3 ? `${d[2]}.${d[1]}.${d[0]}` : v;
}

/** Доля от общего — целыми процентами: десятые здесь ничего не решают. */
function share(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  return `${Math.round((part / whole) * 100)}%`;
}

/**
 * Одна позиция ассортимента источника.
 *
 * Показывается ровно то, что мешает выбить чек, и во что это обходится.
 * «Нет карточки» и «карточка без ИКПУ» разделены: для кассы это одно и то же,
 * но чинятся они по-разному.
 */
function ProductRow({
  source,
  p,
  total,
  options,
}: {
  source: string;
  p: SourceProduct;
  total: number;
  options: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function act(fn: () => Promise<{ ok: boolean; error?: string }>): void {
    setError(null);
    start(async () => {
      const res = await fn();
      if (res.ok) router.refresh();
      else setError(res.error ?? "Не получилось");
    });
  }

  const blocked = p.gaps.length > 0;
  const noCard = p.entityId === null && !p.dismissed;

  return (
    <div className={`prow ${blocked ? "hot" : ""}`}>
      <div className="pmain">
        <span className="pname">{p.name}</span>
        <span className="pmeta mono">
          {num(p.revenue)} сум · {share(p.revenue, total)} · {p.orders.toLocaleString("ru-RU")} заказов
        </span>
        <span className="pmeta">
          {day(p.firstOrderAt)} — {day(p.lastOrderAt)}
          {p.unreadable > 0 && ` · ${p.unreadable} с нечитаемой ценой`}
        </span>
      </div>

      <div className="pstate">
        {p.dismissed ? (
          <span className="hint">карточка не нужна — твоё решение</span>
        ) : noCard ? (
          <span className="chip h">нет карточки</span>
        ) : (
          <>
            <Link href={`/card/${p.entityId}`} className="mapok">
              {p.entityName}
            </Link>
            <span className="chip">{p.decidedBy === "auto" ? "совпало точно" : "связал ты"}</span>
            {blocked ? (
              p.gaps.map((g) => (
                <span className="chip h" key={g.field} title={g.why}>
                  {g.field}: {g.flaw === "нет" ? "нет" : g.why}
                </span>
              ))
            ) : (
              <span className="chip g">чек соберётся</span>
            )}
          </>
        )}
      </div>

      <div className="pact">
        <select
          className="mapsel"
          disabled={pending}
          value={p.entityId ?? (p.dismissed ? "__none__" : "")}
          onChange={(e) =>
            act(() => linkRawValue(source, "product", p.name, e.target.value === "__none__" ? "" : e.target.value))
          }
        >
          <option value="" disabled>
            выбрать карточку…
          </option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
          <option value="__none__">карточка не нужна</option>
        </select>
        {noCard && (
          <button
            type="button"
            className="btn sm"
            disabled={pending}
            onClick={() => act(() => createProductFromSource(source, p.name))}
          >
            Завести карточку
          </button>
        )}
      </div>

      {/* Двойники: решает владелец, поэтому рядом всегда лежит основание. */}
      {noCard && p.lookalikes.length > 0 && (
        <div className="plook">
          {p.lookalikes.map((l) => (
            <div className="plookr" key={l.name}>
              <span className="pmeta">
                похоже на <b>{l.name}</b> — {l.reason}
              </span>
              {l.entityId !== null && (
                <button
                  type="button"
                  className="btn sm ghost"
                  disabled={pending}
                  onClick={() => act(() => linkRawValue(source, "product", p.name, l.entityId!))}
                >
                  Это «{l.entityName}»
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {error && <span className="err-text">{error}</span>}
    </div>
  );
}

/**
 * Ассортимент источника: что продаётся и по чему не собирается чек.
 *
 * Считается в деньгах, а не в строках: «встречается часто» и «приносит много» —
 * разные вещи, и разбирать надо второе.
 */
export function ProductsReview({
  source,
  review,
  cards,
}: {
  source: string;
  review: ProductReview;
  cards: { id: string; name: string }[];
}) {
  const [onlyBlocked, setOnlyBlocked] = useState(true);

  if (review.products.length === 0) {
    return (
      <div className="empty">
        <b>Ассортимент пока не собран</b>
        Для него нужна выгрузка, где у заказа есть товар, цена и время.
      </div>
    );
  }

  const shown = onlyBlocked ? review.products.filter((p) => p.gaps.length > 0) : review.products;

  return (
    <>
      <div className="tiles" style={{ marginBottom: 14 }}>
        <div className="tile mini">
          <div className="lab">Выручка в выгрузке</div>
          <div className="v">{num(review.revenue)}</div>
          <div className="foot">
            <span className="mk" />
            без тестовых отгрузок
          </div>
        </div>
        <div className={`tile mini ${review.blockedRevenue > 0 ? "is-hot" : "zero"}`}>
          <div className="lab">Чек не собирается</div>
          <div className="v">{num(review.blockedRevenue)}</div>
          <div className="foot">
            <span className="mk" />
            {share(review.blockedRevenue, review.revenue)} выручки
          </div>
        </div>
        <div className={`tile mini ${review.noCard > 0 ? "is-hot" : "zero"}`}>
          <div className="lab">Позиций без карточки</div>
          <div className="v">{review.noCard}</div>
          <div className="foot">
            <span className="mk" />
            из {review.products.length} в продаже
          </div>
        </div>
        <div className={`tile mini ${review.incomplete > 0 ? "is-hot" : "zero"}`}>
          <div className="lab">Карточка есть, но неполная</div>
          <div className="v">{review.incomplete}</div>
          <div className="foot">
            <span className="mk" />
            нет ИКПУ, упаковки или НДС
          </div>
        </div>
      </div>

      <p className="hint" style={{ marginBottom: 10 }}>
        Разбирать сверху вниз: там деньги. Нет карточки и карточка без ИКПУ — для
        кассы одно и то же, чек не собирается, но чинятся они по-разному. Отдельно
        отмечено «заполнено, но неверно»: огрызок ИКПУ опаснее пустого поля, потому
        что карточка выглядит готовой. Правило — ровно 17 цифр, как в mydon-stock
        и VendHub-OS: чек принимает касса, и своего правила мы не выдумываем.
        Подсказка «похоже на …» приходит из данных: названия напитков в панели
        переводят, а вкусы оставляют как есть, поэтому «Какао» и Cocoa приходят с
        одним вкусом. Общий вкус бывает и у подмены кнопки — потому в основании
        стоят числа, и решаешь ты, а не код.
      </p>

      <div className="subtabs" style={{ marginBottom: 12 }}>
        <button
          type="button"
          className={`subtab ${onlyBlocked ? "active" : ""}`}
          onClick={() => setOnlyBlocked(true)}
        >
          Мешает кассе <span className="n">×{review.products.filter((p) => p.gaps.length > 0).length}</span>
        </button>
        <button
          type="button"
          className={`subtab ${onlyBlocked ? "" : "active"}`}
          onClick={() => setOnlyBlocked(false)}
        >
          Весь ассортимент <span className="n">×{review.products.length}</span>
        </button>
      </div>

      {shown.length === 0 ? (
        <div className="empty">
          <b>Кассе ничего не мешает</b>
          По каждой позиции есть карточка с ИКПУ, упаковкой и ставкой НДС.
        </div>
      ) : (
        <div className="plist">
          {shown.map((p) => (
            <ProductRow key={p.name} source={source} p={p} total={review.revenue} options={cards} />
          ))}
        </div>
      )}
    </>
  );
}
