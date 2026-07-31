import Link from "next/link";
import type { PaymentChannel, PaymentReview } from "../lib/core";

/** Сумма без «сум» в хвосте: в столбце денег единица и так очевидна. */
function num(n: number): string {
  return Math.round(n).toLocaleString("ru-RU");
}

/** Доля от общего — целыми процентами: десятые здесь ничего не решают. */
function share(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  return `${Math.round((part / whole) * 100)}%`;
}

const MONTHS = [
  "янв", "фев", "мар", "апр", "май", "июн",
  "июл", "авг", "сен", "окт", "ноя", "дек",
];

/** «2026-07» → «июл 2026»: месяц читают глазами, а не разбирают. */
function monthName(m: string): string {
  const [y, mm] = m.split("-");
  const i = Number(mm) - 1;
  return MONTHS[i] ? `${MONTHS[i]} ${y}` : m;
}

/**
 * Один канал оплаты.
 *
 * Код источника показан как есть и не заменён нашим толкованием: рядом стоит
 * то, как канал называет сама панель. Если смысл не подтверждён — так и
 * написано, потому что догадка, выданная за факт, хуже её отсутствия.
 */
function ChannelBlock({
  ch,
  total,
  rowsHref,
}: {
  ch: PaymentChannel;
  total: number;
  rowsHref: string | null;
}) {
  return (
    <div className="sect" style={{ marginTop: 18 }}>
      <div className="sect-h">
        <h3 className="h2 mono">{ch.code}</h3>
        {ch.label !== null ? (
          <span className={`chip ${ch.confirmed ? "" : "h"}`}>
            {ch.label}
            {!ch.confirmed && " — не подтверждено"}
          </span>
        ) : (
          <span className="chip h">источник не объясняет этот код</span>
        )}
        <span className="chip b mono">
          {num(ch.revenue)} сум · {share(ch.revenue, total)}
        </span>
        <span className="chip mono">{ch.orders.toLocaleString("ru-RU")} заказов</span>
        {ch.unreadable > 0 && (
          <span className="chip h mono">{ch.unreadable} с нечитаемой ценой</span>
        )}
        {rowsHref && (
          <Link href={rowsHref} className="chip" style={{ color: "var(--accent)" }}>
            смотреть заказы →
          </Link>
        )}
      </div>

      {!ch.confirmed && (
        <p className="hint" style={{ marginBottom: 8 }}>
          Так этот код называет сама панель. Что это за канал на деле, из выгрузки
          не видно — покажет сверка: возьми месячную сумму и сравни с выпиской
          платёжной системы. Пока не сверено, менять название нельзя.
        </p>
      )}

      {/* По месяцам: это и есть строка, с которой идут к выписке. */}
      <div className="mlist">
        {ch.months.map((m) => (
          <div className="mrow" key={m.month}>
            <span className="mname">{monthName(m.month)}</span>
            <span className="mbar" aria-hidden>
              <i style={{ width: `${Math.min(100, (m.revenue / Math.max(...ch.months.map((x) => x.revenue), 1)) * 100)}%` }} />
            </span>
            <span className="mval mono">{num(m.revenue)}</span>
            <span className="mcnt mono">{m.orders.toLocaleString("ru-RU")}</span>
          </div>
        ))}
      </div>

      {ch.machines.length > 0 && (
        <details className="mdet">
          <summary>По автоматам ({ch.machines.length})</summary>
          <div className="maplist" style={{ marginTop: 8 }}>
            {ch.machines.map((m) => (
              <div className="maprow" key={m.serial}>
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
                    {num(m.revenue)} сум
                  </span>
                  <span className="mapc">{m.orders.toLocaleString("ru-RU")} заказов</span>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/**
 * Каким способом приходят деньги.
 *
 * Срез существует ради сверки, а не ради красоты: месячная сумма по каналу —
 * это то, с чем идут к выписке Payme, Click или Uzum. Коды источника здесь не
 * переводятся и не переименовываются; чем канал окажется на самом деле,
 * покажет сравнение с этими системами, когда они станут источниками.
 */
export function PaymentsView({
  review,
  rowsHref,
}: {
  review: PaymentReview;
  /** Ссылка в сами заказы с фильтром по коду. null — колонки в выгрузке нет. */
  rowsHref: ((code: string) => string) | null;
}) {
  if (review.channels.length === 0) {
    return (
      <div className="empty">
        <b>Каналы оплаты пока не видны</b>
        Для среза нужна выгрузка, где у заказа есть способ оплаты, сумма и время.
      </div>
    );
  }

  const unconfirmed = review.channels.filter((c) => !c.confirmed).length;

  return (
    <>
      <div className="tiles" style={{ marginBottom: 14 }}>
        <div className="tile mini">
          <div className="lab">Всего в выгрузке</div>
          <div className="v">{num(review.revenue)}</div>
          <div className="foot">
            <span className="mk" />
            {review.orders.toLocaleString("ru-RU")} заказов, включая тестовые
          </div>
        </div>
        <div className="tile mini">
          <div className="lab">Каналов оплаты</div>
          <div className="v">{review.channels.length}</div>
          <div className="foot">
            <span className="mk" />
            кодов в колонке источника
          </div>
        </div>
        <div className={`tile mini ${review.unconfirmedRevenue > 0 ? "is-hot" : "zero"}`}>
          <div className="lab">Смысл не подтверждён</div>
          <div className="v">{num(review.unconfirmedRevenue)}</div>
          <div className="foot">
            <span className="mk" />
            {share(review.unconfirmedRevenue, review.revenue)} выручки ждут сверки
          </div>
        </div>
        <div className={`tile mini ${unconfirmed > 0 ? "" : "zero"}`}>
          <div className="lab">Кодов под вопросом</div>
          <div className="v">{unconfirmed}</div>
          <div className="foot">
            <span className="mk" />
            {unconfirmed > 0 ? "названы, но не проверены" : "все коды понятны"}
          </div>
        </div>
      </div>

      <p className="hint" style={{ marginBottom: 12 }}>
        Коды показаны так, как их отдаёт панель, и подписаны её же словами —
        включая «Таможенный платеж», название явно не про вендинг. Заменять его
        своим толкованием нельзя: справочник расшифровок такое же сырьё, как и
        строки. Payme, Click, Uzum или списание бонусов — это выяснит сверка,
        когда платёжные системы встанут рядом источниками. До тех пор код
        помечен «не подтверждено», а не переименован.
        <br />
        Ничего не отфильтровано, включая тестовые выдачи: итог обязан сходиться
        с тем, что показывает сама панель.
      </p>

      {review.channels.map((ch) => (
        <ChannelBlock
          key={ch.code}
          ch={ch}
          total={review.revenue}
          rowsHref={rowsHref ? rowsHref(ch.code) : null}
        />
      ))}
    </>
  );
}
