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

  // Сколько записей ждёт слова владельца — вход в очередь утверждения прямо с
  // главной (на телефоне это основной путь). Ошибка тут не должна ронять сводку.
  let queue = 0;
  try {
    const p = await core.pendingEntities();
    queue = p.cards.length + new Set(p.fields.map((f) => f.entityId)).size;
  } catch {
    queue = 0;
  }

  const list = alarms(briefing);
  const total = list.reduce((s, a) => s + a.n, 0);

  return (
    <>
      <div className="page-head">
        <h1 className="h1">Главное</h1>
        <p className="lead">Обновлено {when(briefing.generatedAt)} · то же, что приходит в 07:30 в Telegram</p>
      </div>

      {pending.length > 0 && (
        <div className="card hot" style={{ marginBottom: 16 }}>
          <div className="sect-h">
            <span className="chip h">требует решения · {pending.length}</span>
          </div>
          {pending.slice(0, 2).map((a) => (
            <Link href="/approvals" className="trow hot" key={a.id}>
              <div className="tb">
                <div className="tt">{a.action}</div>
                <div className="tm">
                  <span className="who"><span className="av ag">✦</span>{a.agent}</span>
                </div>
              </div>
              <span className="due hot">решить</span>
            </Link>
          ))}
          <Link href="/approvals" className="btn full sm">Все решения</Link>
        </div>
      )}

      {queue > 0 && (
        <Link href="/queue" className="trow hot" style={{ marginBottom: 16 }}>
          <div className="tb">
            <div className="tt">На утверждение</div>
            <div className="tm">
              заведено не тобой · {queue} {queue === 1 ? "запись" : "записей"}
            </div>
          </div>
          <span className="due hot">открыть</span>
        </Link>
      )}

      <div className="tiles">
        {list.map((a) => (
          <div className={`tile ${a.n > 0 ? "is-hot" : "zero"}`} key={a.k}>
            <div className="lab">{a.k}</div>
            <div className="v">{a.n}</div>
            <div className="foot"><span className="mk" />{a.n > 0 ? "нужно внимание" : "спокойно"}</div>
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

      <div className="sect-h" style={{ marginTop: 26 }}><h3 className="h2">Очередь решений</h3></div>
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
