import Link from "next/link";
import { core, type PurchaseRow } from "../lib/core";
import { SyncIntakeButton } from "./sync-intake-button";

const money = (v: string | number | null) =>
  v === null ? "—" : `${Number(v).toLocaleString("ru-RU")}`;
const day = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y.slice(2)}`;
};

/** Приход товара и сырья — журнал из mydon-stock (этап 2 миграции). */
export async function PurchasesView() {
  let rows: PurchaseRow[] = [];
  let summary: Awaited<ReturnType<typeof core.supplySummary>> | null = null;
  try {
    [rows, summary] = await Promise.all([core.purchases(30, 300), core.supplySummary()]);
  } catch {
    return <div className="empty"><b>Приход недоступен</b>Core не ответил — обнови страницу.</div>;
  }
  if (rows.length === 0) {
    return (
      <div className="empty">
        <b>Прихода за 30 дней нет</b>
        Записи появятся из учёта склада (mydon-stock) сами.
      </div>
    );
  }
  return (
    <>
      <SyncIntakeButton />
      {summary && (
        <div className="tiles" style={{ marginBottom: 14 }}>
          <div className="tile">
            <div className="lab">Приход за 30 дней</div>
            <div className="v">{money(summary.purchases30.total)} <span className="u">сум</span></div>
            <div className="foot"><span className="mk" />партий: {summary.purchases30.count}</div>
          </div>
        </div>
      )}
      <div className="book">
        <div className="th">
          <span>Товар</span>
          <span>День</span>
          <span style={{ textAlign: "right" }}>Сумма</span>
        </div>
        {rows.map((r) => (
          <div className="tr" key={r.id}>
            <span className="nm">
              {r.product}
              <span style={{ color: "var(--tx-3)" }}>
                {" "}· ×{Number(r.qty)}{r.unit ? ` ${r.unit}` : ""}
                {r.note ? ` · ${r.note}` : ""}
                {r.expiryDate ? ` · годен до ${day(r.expiryDate)}` : ""}
              </span>
            </span>
            <span className="cd">{day(r.dt)}</span>
            <span className="pr">{r.total !== null ? <>{money(r.total)} <span className="u">сум</span></> : "—"}</span>
          </div>
        ))}
      </div>
      <p style={{ fontSize: 12, color: "var(--tx-3)", marginTop: 10 }}>
        {rows.length} партий за 30 дней · из учёта склада, обновляется каждые 10 минут
      </p>
    </>
  );
}

/** Остатки внутри автоматов: свежий снапшот OurVend, нули горят. */
export async function MachineStockView() {
  let levels: Awaited<ReturnType<typeof core.machineStockLevels>> = [];
  let summary: Awaited<ReturnType<typeof core.supplySummary>> | null = null;
  try {
    [levels, summary] = await Promise.all([core.machineStockLevels(), core.supplySummary()]);
  } catch {
    return <div className="empty"><b>Остатки недоступны</b>Core не ответил — обнови страницу.</div>;
  }
  if (levels.length === 0) {
    return (
      <div className="empty">
        <b>Снапшотов остатков пока нет</b>
        OurVend отдаёт их по снек-автоматам — появятся сами.
      </div>
    );
  }

  const byMachine = new Map<string, typeof levels>();
  for (const l of levels) {
    const key = l.machineName ?? l.machineSerial;
    if (!byMachine.has(key)) byMachine.set(key, []);
    byMachine.get(key)!.push(l);
  }

  return (
    <>
      {summary && (
        <div className="tiles" style={{ marginBottom: 14 }}>
          <div className={`tile ${summary.emptyPositions > 0 ? "is-hot" : "zero"}`}>
            <div className="lab">Пустые позиции</div>
            <div className="v">{summary.emptyPositions}</div>
            <div className="foot"><span className="mk" />{summary.emptyPositions > 0 ? "пора везти пополнение" : "пустых нет"}</div>
          </div>
          <div className={`tile ${summary.lowPositions > 0 ? "" : "zero"}`}>
            <div className="lab">Мало (≤2 шт)</div>
            <div className="v">{summary.lowPositions}</div>
            <div className="foot"><span className="mk" />скоро закончатся</div>
          </div>
          <div className="tile zero">
            <div className="lab">Снапшот от</div>
            <div className="v" style={{ fontSize: 20 }}>{summary.lastStockDt ? day(summary.lastStockDt) : "—"}</div>
            <div className="foot"><span className="mk" />дневные данные OurVend</div>
          </div>
        </div>
      )}

      {[...byMachine.entries()].map(([name, items]) => {
        const empty = items.filter((i) => i.qty === 0).length;
        const first = items[0];
        return (
          <div className="sect" style={{ marginTop: 18 }} key={name}>
            <div className="sect-h">
              <h3 className="h2">
                {first.machineId ? <Link href={`/card/${first.machineId}`}>{name}</Link> : name}
              </h3>
              {empty > 0 ? <span className="chip h">пусто ×{empty}</span> : <span className="chip g">заполнен</span>}
              <span className="chip">{day(first.dt)}</span>
            </div>
            <div className="book">
              {items
                .slice()
                .sort((a, b) => a.qty - b.qty)
                .map((i) => (
                  <div className="tr" key={`${name}:${i.product}`}>
                    <span className="nm">
                      {i.qty === 0 && <span style={{ color: "var(--hot)", marginRight: 7 }}>●</span>}
                      {i.qty > 0 && i.qty <= 2 && <span style={{ color: "var(--tx-2)", marginRight: 7 }}>◐</span>}
                      {i.product}
                    </span>
                    <span className="cd" />
                    <span className="pr" style={i.qty === 0 ? { color: "var(--hot)" } : undefined}>
                      {i.qty === 0 ? "пусто" : `${i.qty} шт`}
                    </span>
                  </div>
                ))}
            </div>
          </div>
        );
      })}
    </>
  );
}
