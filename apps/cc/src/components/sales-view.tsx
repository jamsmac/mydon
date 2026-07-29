import Link from "next/link";
import { core, type SaleRow } from "../lib/core";

const money = (v: string | number) => `${Number(v).toLocaleString("ru-RU")}`;
const day = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y.slice(2)}`;
};

/**
 * Журнал продаж (этап 1 миграции): дневные позиции из синка mydon-stock/OurVend.
 * У источника нет времени внутри дня — честно показываем по дням.
 */
export async function SalesView() {
  let rows: SaleRow[] = [];
  let summary: Awaited<ReturnType<typeof core.salesSummary>> | null = null;
  let silent: Awaited<ReturnType<typeof core.salesSilent>> = [];
  try {
    [rows, summary, silent] = await Promise.all([
      core.sales(7, 300),
      core.salesSummary(),
      core.salesSilent(2),
    ]);
  } catch {
    return (
      <div className="empty">
        <b>Журнал продаж недоступен</b>
        Core не ответил — обнови страницу.
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="empty">
        <b>Продаж пока нет</b>
        {summary?.configured
          ? "Синк работает — данные появятся после первых продаж."
          : "Синк продаж не настроен на сервере (STOCK_DATABASE_URL)."}
      </div>
    );
  }

  return (
    <>
      {summary && (
        <div className="tiles" style={{ marginBottom: 14 }}>
          <div className={`tile ${summary.today.amount === 0 ? "zero" : ""}`}>
            <div className="lab">Выручка сегодня</div>
            <div className="v">{money(summary.today.amount)} <span className="u">сум</span></div>
            <div className="foot"><span className="mk" />вчера: {money(summary.yesterday.amount)} сум</div>
          </div>
          <div className={`tile ${summary.today.qty === 0 ? "zero" : ""}`}>
            <div className="lab">Продано сегодня</div>
            <div className="v">{money(summary.today.qty)}</div>
            <div className="foot"><span className="mk" />вчера: {money(summary.yesterday.qty)}</div>
          </div>
          <div className="tile">
            <div className="lab">За 30 дней</div>
            <div className="v">{money(summary.days30.amount)} <span className="u">сум</span></div>
            <div className="foot"><span className="mk" />позиций: {money(summary.days30.qty)}</div>
          </div>
          <div className={`tile ${silent.length > 0 ? "is-hot" : "zero"}`}>
            <div className="lab">Молчат 2+ дня</div>
            <div className="v">{silent.length}</div>
            <div className="foot"><span className="mk" />{silent.length > 0 ? "продаж не видно — проверь" : "все продают"}</div>
          </div>
        </div>
      )}

      {silent.length > 0 && (
        <div className="notice">
          <b>Автоматы без продаж 2+ дня:</b>
          {silent.map((s) => (
            <span key={s.serial} style={{ marginRight: 10 }}>
              {s.machineId ? (
                <Link href={`/card/${s.machineId}`} style={{ color: "var(--hot)" }}>
                  {s.name ?? s.serial}
                </Link>
              ) : (
                s.serial
              )}
              {" "}(посл. {day(s.lastDt)})
            </span>
          ))}
        </div>
      )}

      <div className="book">
        <div className="th">
          <span>Товар · автомат</span>
          <span>День</span>
          <span style={{ textAlign: "right" }}>Сумма</span>
        </div>
        {rows.map((r) => (
          <div className="tr" key={r.id}>
            <span className="nm">
              {r.product}
              <span style={{ color: "var(--tx-3)" }}> · {r.machineName ?? r.machineSerial}{Number(r.qty) > 1 ? ` · ×${Number(r.qty)}` : ""}</span>
            </span>
            <span className="cd">{day(r.dt)}</span>
            <span className="pr">{money(r.amount)} <span className="u">сум</span></span>
          </div>
        ))}
      </div>
      <p style={{ fontSize: 12, color: "var(--tx-3)", marginTop: 10 }}>
        {rows.length} позиций за 7 дней · дневные сводки OurVend, обновляются каждые 10 минут
      </p>
    </>
  );
}
