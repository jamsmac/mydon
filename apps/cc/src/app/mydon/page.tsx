import Link from "next/link";
import { core, CoreUnavailable, type Approval, type Briefing } from "../../lib/core";
import { CoreDown } from "../../components/core-down";
import { ApprovalCard } from "../../components/approval-card";
import { when } from "../../lib/format";

export const dynamic = "force-dynamic";

/** Те же четыре тревоги, что в утреннем брифинге бота (ответ владельца, Ф11). */
function alarms(b: Briefing) {
  return [
    { n: b.overdueMoney, k: "просрочено платежей" },
    { n: b.idleMachines, k: "автоматы простаивают" },
    { n: b.contractsDueSoon, k: "договоры на исходе" },
    { n: b.pendingApprovals, k: "ждут твоего решения" },
  ];
}

export default async function Main() {
  let briefing: Briefing;
  let pending: Approval[];
  try {
    [briefing, pending] = await Promise.all([core.briefing(), core.pendingApprovals()]);
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }

  const list = alarms(briefing);
  const total = list.reduce((s, a) => s + a.n, 0);

  return (
    <>
      <div className="page-head">
        <h1>Главное</h1>
        <p>Обновлено {when(briefing.generatedAt)} · то же, что приходит в 07:30 в Telegram</p>
      </div>

      <div className="tiles">
        {list.map((a) => (
          <div className="tile" key={a.k}>
            <div className={`v ${a.n > 0 ? "alarm" : "calm"}`}>{a.n}</div>
            <div className="k">{a.k}</div>
          </div>
        ))}
      </div>

      {total === 0 && (
        <div className="empty" style={{ marginTop: 16 }}>
          <b>Тревог нет</b>
          Просрочек, простоев и незакрытых согласований не найдено.
        </div>
      )}

      {briefing.contractsBadDate !== undefined && briefing.contractsBadDate > 0 && (
        <div className="warn" style={{ marginTop: 14 }}>
          <b>Договоры с непонятной датой: {briefing.contractsBadDate}</b>
          У них не разобрать срок окончания — в подсчёт «на исходе» они не попали. Проверьте вручную,
          иначе срок пройдёт незамеченным.
        </div>
      )}

      <div className="section-title">Требует решения</div>
      {pending.length === 0 ? (
        <div className="empty">
          <b>Очередь пуста</b>
          Агенты ничего не предлагают. Порог автономии T0 — сами они не действуют.
        </div>
      ) : (
        <>
          {pending.slice(0, 3).map((a) => (
            <ApprovalCard key={a.id} item={a} />
          ))}
          {pending.length > 3 && (
            <Link href="/approvals" className="navlink" style={{ justifyContent: "center" }}>
              Показать все — {pending.length}
            </Link>
          )}
        </>
      )}
    </>
  );
}
