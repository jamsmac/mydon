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

      <p className="hint" style={{ marginBottom: 8 }}>
        Журнал по твоей форме — 13 колонок. Выгрузка ПО сегодня даёт{" "}
        <b>5</b>: Время (день), Товар, Сумма, Аппарат, Локация. Остальные{" "}
        <b>8</b> (Тип, № заказа, Код, Оплата, Статус, Чек, ИКПУ) ПО не отдаёт —
        помечены «—». Появятся, когда ПО включит выгрузку по каждой операции.
      </p>

      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table className="jtable">
          <thead>
            <tr>
              <th>ID</th>
              <th>Время</th>
              <th>Тип</th>
              <th>Товар</th>
              <th style={{ textAlign: "right" }}>Сумма</th>
              <th>№ заказа</th>
              <th>Код товара</th>
              <th>Аппарат</th>
              <th>Локация</th>
              <th>Оплата</th>
              <th>Статус</th>
              <th>Чек</th>
              <th>ИКПУ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="mono dim">{r.id.slice(0, 8)}</td>
                <td className="mono">{day(r.dt)}</td>
                <td className="dash">—</td>
                <td>
                  {r.product}
                  {Number(r.qty) > 1 && <span className="dim"> ×{Number(r.qty)}</span>}
                </td>
                <td className="mono num">{money(r.amount)} <span className="u">сум</span></td>
                <td className="dash">—</td>
                <td className="dash">—</td>
                <td>
                  {r.machineId ? (
                    <Link href={`/card/${r.machineId}`} style={{ color: "var(--accent-tx, #5B9BFF)" }}>
                      {r.machineName ?? r.machineSerial}
                    </Link>
                  ) : (
                    r.machineName ?? r.machineSerial
                  )}
                </td>
                <td>{r.point ?? <span className="dash">—</span>}</td>
                <td className="dash">—</td>
                <td className="dash">—</td>
                <td className="dash">—</td>
                <td className="dash">—</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 12, color: "var(--tx-3)", marginTop: 10 }}>
        {rows.length} позиций за 7 дней · дневные сводки OurVend, обновляются каждые 10 минут
      </p>
    </>
  );
}
