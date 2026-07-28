import Link from "next/link";
import { core, CoreUnavailable, type AgentCard } from "../../lib/core";
import { CoreDown } from "../../components/core-down";
import { NewAgentForm } from "../../components/agent-new";

export const dynamic = "force-dynamic";

const BUSINESS_LABEL: Record<string, string> = {
  globerent: "GLOBERENT",
  vendhub: "VendHub",
  trent: "TRent",
  personal: "Личное",
  mydon: "MYDON",
  shared: "Общий",
};

/** Что означает уровень самостоятельности — словами, а не буквой. */
export const TIER_LABEL: Record<string, string> = {
  T0: "только спрашивает",
  T1: "предлагает, решаешь ты",
  T2: "мелкое — сам",
  T3: "многое — сам",
  T4: "почти всё сам",
};

export default async function Agents() {
  let list: AgentCard[];
  try {
    list = await core.agents();
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }

  const working = list.filter((a) => a.status === "active");
  const idle = list.filter((a) => a.status !== "active");

  return (
    <>
      <div className="page-head">
        <h1>Агенты</h1>
        <p>
          Работают {working.length} из {list.length}. Настройки хранятся в базе — не сбрасываются
          при обновлении системы.
        </p>
      </div>

      {working.length > 0 && <div className="section-title">В работе</div>}
      <div className="rows">
        {working.map((a) => (
          <AgentRow key={a.id} a={a} />
        ))}
      </div>

      {idle.length > 0 && <div className="section-title">Выключены</div>}
      <div className="rows">
        {idle.map((a) => (
          <AgentRow key={a.id} a={a} />
        ))}
      </div>

      <div className="section-title">Завести агента</div>
      <NewAgentForm />
    </>
  );
}

function AgentRow({ a }: { a: AgentCard }) {
  const jobs = a.schedule.length;
  return (
    <Link href={`/agents/${a.name}`} className="row rowlink">
      <div className="t">
        <b>{a.name}</b>
        <small>
          {BUSINESS_LABEL[a.business] ?? a.business} ·{" "}
          {jobs > 0 ? `${jobs} расписан${jobs === 1 ? "ие" : "ий"}` : "без расписания"} ·{" "}
          {TIER_LABEL[a.autonomyDefault] ?? a.autonomyDefault}
        </small>
      </div>
      <span className={`pill ${a.status === "active" ? "ok" : ""}`}>
        {a.status === "active" ? "работает" : "выключен"}
      </span>
    </Link>
  );
}
