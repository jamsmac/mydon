import Link from "next/link";
import type { CombinedSales, CombinedOrder } from "../lib/core";

function num(n: number): string {
  return n.toLocaleString("ru-RU");
}

function sum(n: number): string {
  return `${Math.round(n).toLocaleString("ru-RU")} сум`;
}

/**
 * Объединённый журнал «Все продажи».
 *
 * gjvending и OurVend — разные автоматы, вместе это весь оборот. Здесь они
 * сложены в одну ленту, каждый заказ помечен источником. Это не сверка: флоты
 * не пересекаются, задваивать нечего. OurVend в vendinghub пока не интегрирован,
 * поэтому весь оборот сразу виден только тут.
 */
export function AllSalesView({
  r,
  base,
  sp,
}: {
  r: CombinedSales;
  base: string;
  sp: Record<string, string>;
}) {
  const link = (params: Record<string, string | null>) => {
    const p = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(params)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    return `${base}?${p.toString()}`;
  };

  const anyLoaded = r.bySource.some((s) => s.loaded);
  if (!anyLoaded) {
    return (
      <div className="empty">
        <b>Продаж пока нет</b>
        Ни один поштучный источник (gjvending, OurVend) ещё не загружен. Как
        появится выгрузка — весь оборот сложится здесь.
      </div>
    );
  }

  const pages = Math.max(1, Math.ceil(r.count / r.size));

  return (
    <>
      <p className="hint" style={{ marginBottom: 12 }}>
        Всё, что продали оба флота, в одной ленте. <b>gjvending и OurVend — разные
        автоматы</b>, поэтому их продажи складываются, а не сверяются: вместе это
        весь оборот. OurVend в vendinghub пока не интегрирован — значит весь
        оборот сразу виден только здесь.
      </p>

      <div className="tiles" style={{ marginBottom: 14 }}>
        <div className="tile mini">
          <div className="lab">Оборот всего</div>
          <div className="v">{sum(r.totalRevenue)}</div>
          <div className="foot">
            <span className="mk" />
            {num(r.totalOrders)} продаж
          </div>
        </div>
        {r.bySource.map((s) => (
          <div className={`tile mini ${s.loaded ? "" : "zero"}`} key={s.source}>
            <div className="lab">{s.key}</div>
            <div className="v">{s.loaded ? sum(s.revenue) : "—"}</div>
            <div className="foot">
              <span className="mk" />
              {s.loaded ? `${num(s.orders)} продаж` : "не загружен"}
            </div>
          </div>
        ))}
        {r.unreadable > 0 && (
          <div className="tile mini is-hot">
            <div className="lab">Сумма нечитаема</div>
            <div className="v">{num(r.unreadable)}</div>
            <div className="foot">
              <span className="mk" />
              не вошли в оборот
            </div>
          </div>
        )}
      </div>

      {/* Разрезы: по способу оплаты и по месяцам. */}
      <div className="sect" style={{ marginTop: 4 }}>
        <div className="sect-h">
          <h3 className="h2">Как приходят деньги</h3>
          <span className="chip">способ оплаты — слово источника</span>
        </div>
        <div className="maplist">
          {r.byPayment.map((b) => (
            <div className="maprow" key={b.key}>
              <div className="mapv">
                <span className="mapl mono">{b.key}</span>
              </div>
              <div className="mapt">
                <span className="chip g">{sum(b.revenue)}</span>
                <span className="chip">{num(b.orders)} продаж</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {r.byMonth.length > 0 && (
        <div className="sect" style={{ marginTop: 14 }}>
          <div className="sect-h">
            <h3 className="h2">По месяцам</h3>
          </div>
          <div className="maplist">
            {r.byMonth.map((b) => (
              <div className="maprow" key={b.key}>
                <div className="mapv">
                  <span className="mapl mono">{b.key}</span>
                </div>
                <div className="mapt">
                  <span className="chip g">{sum(b.revenue)}</span>
                  <span className="chip">{num(b.orders)} продаж</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Единая лента заказов по времени. */}
      <div className="sect" style={{ marginTop: 14 }}>
        <div className="sect-h">
          <h3 className="h2">Лента продаж</h3>
          <span className="chip">свежие сверху</span>
        </div>
        <div className="rlist">
          <div className="rhead asales">
            <span>Источник</span>
            <span>Время</span>
            <span>Автомат</span>
            <span>Товар</span>
            <span style={{ textAlign: "right" }}>Сумма</span>
            <span>Оплата</span>
          </div>
          {r.orders.map((o) => (
            <SaleRow key={`${o.source}-${o.externalId}-${o.ts}`} o={o} />
          ))}
        </div>
      </div>

      <div className="pager" style={{ marginTop: 12 }}>
        {r.page > 1 && (
          <Link className="btn sm ghost" href={link({ apage: String(r.page - 1) })}>
            ← назад
          </Link>
        )}
        <span className="hint">
          {r.page} / {pages} · {num(r.count)} продаж всего
        </span>
        {r.page < pages && (
          <Link className="btn sm ghost" href={link({ apage: String(r.page + 1) })}>
            вперёд →
          </Link>
        )}
      </div>
    </>
  );
}

/** Одна строка ленты «Все продажи». */
function SaleRow({ o }: { o: CombinedOrder }) {
  return (
    <div className="rrow asales">
      <span>
        <span className="chip b">{o.title}</span>
      </span>
      <span className="mono dim">{o.ts || "—"}</span>
      <span className="mono">{o.machine || "—"}</span>
      <span>{o.product || "—"}</span>
      <span className="mono" style={{ textAlign: "right" }}>
        {o.amountNum === null ? <span className="warn">{o.amount || "—"}</span> : sum(o.amountNum)}
      </span>
      <span className="mono">{o.payment || "—"}</span>
    </div>
  );
}
