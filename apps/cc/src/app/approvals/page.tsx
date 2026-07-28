import { core, CoreUnavailable, type Approval } from "../../lib/core";
import { CoreDown } from "../../components/core-down";
import { ApprovalCard } from "../../components/approval-card";
import { when } from "../../lib/format";

export const dynamic = "force-dynamic";

const LABEL: Record<Approval["decision"], string> = {
  pending: "ждёт",
  approved: "одобрено",
  rejected: "отклонено",
  clarify: "уточнить",
};

export default async function Approvals() {
  let all: Approval[];
  try {
    all = await core.allApprovals();
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }

  const pending = all.filter((a) => a.decision === "pending");
  const decided = all.filter((a) => a.decision !== "pending");

  return (
    <>
      <div className="page-head">
        <h1>Решения</h1>
        <p>Агенты предлагают — решаешь ты. Решение попадает в журнал сразу.</p>
      </div>

      {pending.length === 0 ? (
        <div className="empty">
          <b>Ничего не ждёт решения</b>
          Порог автономии T0: агенты только предлагают, сами не действуют.
        </div>
      ) : (
        pending.map((a) => <ApprovalCard key={a.id} item={a} />)
      )}

      {decided.length > 0 && (
        <>
          <div className="section-title">Уже решено</div>
          <div className="rows">
            {decided.slice(0, 30).map((a) => (
              <div className="row" key={a.id}>
                <div className="t">
                  <b>{a.action}</b>
                  <small>
                    {a.agent} · уровень {a.tier}
                  </small>
                </div>
                <span className={`pill ${a.decision === "approved" ? "ok" : "bad"}`}>
                  {LABEL[a.decision]}
                </span>
                <span className="when">{a.decidedAt ? when(a.decidedAt) : ""}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
