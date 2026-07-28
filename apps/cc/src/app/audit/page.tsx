import { core, CoreUnavailable, type AuditEntry } from "../../lib/core";
import { CoreDown } from "../../components/core-down";
import { when } from "../../lib/format";

export const dynamic = "force-dynamic";

const ACTOR: Record<AuditEntry["actorKind"], string> = {
  human: "ты",
  agent: "агент",
  system: "система",
};

/** Понятное имя действия: в журнале коды, а читать его будет не программист. */
function describe(action: string): string {
  const map: Record<string, string> = {
    "entity.create": "завёл карточку",
    "entity.update": "изменил карточку",
    "approval.request": "попросил разрешения",
    "approval.approved": "одобрил",
    "approval.rejected": "отклонил",
    "approval.clarify": "отправил на уточнение",
    "claim.confirmed": "заявленное подтвердилось",
    "claim.refuted": "заявленное НЕ подтвердилось",
  };
  return map[action] ?? action;
}

export default async function Audit() {
  let entries: AuditEntry[];
  try {
    entries = await core.audit(60);
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }

  return (
    <>
      <div className="page-head">
        <h1>Журнал</h1>
        <p>Кто что сделал и когда — включая действия агентов. Запись идёт вместе с действием.</p>
      </div>

      {entries.length === 0 ? (
        <div className="empty">
          <b>Журнал пуст</b>
          Записи появятся, как только в системе что-то произойдёт.
        </div>
      ) : (
        <div className="rows">
          {entries.map((e) => (
            <div className="row" key={e.id}>
              <span className={`pill ${e.actorKind}`}>{ACTOR[e.actorKind]}</span>
              <div className="t">
                <b>{describe(e.action)}</b>
                {e.actorRef && <small>{e.actorRef}</small>}
              </div>
              <span className="when">{when(e.ts)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
