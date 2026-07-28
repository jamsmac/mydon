import Link from "next/link";
import { core, CoreUnavailable, type AgentCard, type AuditEntry } from "../../../lib/core";
import { CoreDown } from "../../../components/core-down";
import { AgentEditor } from "../../../components/agent-editor";
import { when } from "../../../lib/format";

export const dynamic = "force-dynamic";

/** Последние действия именно этого агента — «что он вообще делал». */
function ownTrail(all: AuditEntry[], name: string): AuditEntry[] {
  return all
    .filter((e) => e.actorRef === `agent:${name}` || e.actorRef === name || e.target === name)
    .slice(0, 12);
}

const ACTION_LABEL: Record<string, string> = {
  "agent.create": "заведён",
  "agent.update": "изменены настройки",
  "agent.archive": "удалён из работы",
  "approval.request": "попросил разрешения",
  "approval.approved": "получил одобрение",
  "approval.rejected": "получил отказ",
};

export default async function AgentPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;

  let agent: AgentCard;
  let trail: AuditEntry[] = [];
  try {
    agent = await core.agent(name);
    // Журнал не критичен для карточки: не показать историю — не повод падать.
    try {
      trail = ownTrail(await core.audit(200), name);
    } catch {
      trail = [];
    }
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }

  return (
    <>
      <div className="page-head">
        <Link href="/agents" className="back">
          ← Все агенты
        </Link>
        <h1>{agent.name}</h1>
        <p>{agent.description ?? "Описание не задано."}</p>
      </div>

      <AgentEditor agent={agent} />

      <div className="section-title">Что делал</div>
      {trail.length === 0 ? (
        <div className="empty">
          <b>Пока ничего</b>
          Действия появятся, когда агент отработает по расписанию.
        </div>
      ) : (
        <div className="rows">
          {trail.map((e) => (
            <div className="row" key={e.id}>
              <div className="t">
                <b>{ACTION_LABEL[e.action] ?? e.action}</b>
                <small>{e.actorRef ?? ""}</small>
              </div>
              <span className="when">{when(e.ts)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
