import { core, type CollectionRow } from "../lib/core";
import { CollectionReceive } from "./collection-receive";

const p2 = (n: number) => String(n).padStart(2, "0");
/** Дата-время сбора до секунды — требование спецификации VendCash. */
function whenFull(iso: string): string {
  const d = new Date(iso);
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
const sum = (v: string | null) => (v === null ? "—" : `${Number(v).toLocaleString("ru-RU")} сум`);

/**
 * Инкассация (перенос VendCash): ожидающие приёма — с вводом суммы,
 * принятые — книгой, итог за 30 дней.
 */
export async function CollectionsView() {
  let pending: CollectionRow[] = [];
  let received: CollectionRow[] = [];
  let summary = { pending: 0, receivedCount: 0, receivedSum: 0, days: 30 };
  try {
    [pending, received, summary] = await Promise.all([
      core.collections({ status: "collected" }),
      core.collections({ status: "received", days: "30" }),
      core.collectionsSummary(30),
    ]);
  } catch {
    return (
      <div className="empty">
        <b>Инкассация недоступна</b>
        Core не ответил — попробуй обновить страницу.
      </div>
    );
  }

  return (
    <>
      <div className="tiles" style={{ marginBottom: 16 }}>
        <div className={`tile ${summary.pending > 0 ? "is-hot" : "zero"}`}>
          <div className="lab">Ждут приёма</div>
          <div className="v">{summary.pending}</div>
          <div className="foot"><span className="mk" />{summary.pending > 0 ? "пересчитай и введи сумму" : "всё принято"}</div>
        </div>
        <div className={`tile ${summary.receivedCount === 0 ? "zero" : ""}`}>
          <div className="lab">Принято за 30 дней</div>
          <div className="v">{summary.receivedCount}</div>
          <div className="foot"><span className="mk" />инкассаций</div>
        </div>
        <div className={`tile ${summary.receivedSum === 0 ? "zero" : ""}`}>
          <div className="lab">Сумма за 30 дней</div>
          <div className="v">{Number(summary.receivedSum).toLocaleString("ru-RU")} <span className="u">сум</span></div>
          <div className="foot"><span className="mk" />наличные, принятые тобой</div>
        </div>
      </div>

      {pending.length > 0 && (
        <div className="sect" style={{ marginTop: 0 }}>
          <div className="sect-h">
            <h3 className="h2">Ожидают приёма</h3>
            <span className="chip h">{pending.length}</span>
          </div>
          {pending.map((c) => (
            <div className="trow hot" key={c.id} style={{ flexWrap: "wrap" }}>
              <div className="tb">
                <div className="tt">{c.machineName ?? "автомат"}</div>
                <div className="tm">
                  <span>{c.operatorName ?? "оператор не указан"}</span>
                  <span className="mono">{whenFull(c.collectedAt)}</span>
                </div>
              </div>
              <CollectionReceive id={c.id} />
            </div>
          ))}
        </div>
      )}

      <div className="sect">
        <div className="sect-h">
          <h3 className="h2">Принятые</h3>
          <span className="chip">{received.length}</span>
        </div>
        {received.length === 0 ? (
          <div className="empty">
            <b>За 30 дней приёмов не было</b>
            Оператор пишет боту «инкассация», выбирает автомат — и сбор появляется здесь.
          </div>
        ) : (
          <div className="book">
            <div className="th">
              <span>Автомат</span>
              <span>Собрано</span>
              <span style={{ textAlign: "right" }}>Сумма</span>
            </div>
            {received.map((c) => (
              <div className="tr" key={c.id}>
                <span className="nm">{c.machineName ?? "—"}{c.operatorName ? ` · ${c.operatorName}` : ""}</span>
                <span className="cd">{whenFull(c.collectedAt)}</span>
                <span className="pr">{sum(c.amount)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
