import Link from "next/link";
import { partLocationLabel } from "@mydon/shared";
import { core, CoreUnavailable, type PartCountSessionListRow } from "../../../lib/core";
import { CoreDown } from "../../../components/core-down";
import { StartCountForm } from "../../../components/part-count-start";

export const dynamic = "force-dynamic";

const когда = (iso: string | null): string => (iso ? new Date(iso).toLocaleString("ru-RU", { timeZone: "Asia/Tashkent", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");

function statusOf(s: PartCountSessionListRow): { text: string; cls: string } {
  if (s.reversesId) return { text: "откат", cls: "mono" };
  if (s.appliedAt) return { text: "применена", cls: "ok" };
  if (s.finishedAt) return { text: "ждёт применения", cls: "act" };
  return { text: "идёт", cls: "act" };
}

/** Сессии инвентаризации узлов (R-PU-7): что идёт, что ждёт применения, что применено. */
export default async function PartCountPage() {
  let sessions: PartCountSessionListRow[];
  try {
    sessions = await core.partCountSessions(100);
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }
  const waiting = sessions.filter((s) => !s.appliedAt && !s.reversesId);
  return (
    <>
      <div className="page-head">
        <Link href="/parts" className="back">
          ← Все узлы
        </Link>
        <h1>Инвентаризация узлов</h1>
        <p>
          Сотрудник считает по одному в боте («🗂 Инвентаризация узлов»), владелец применяет здесь.
          {waiting.length > 0 ? ` Ждут применения: ${waiting.length}.` : ""}
        </p>
      </div>

      <section className="group-block">
        <div className="section-title">Начать с панели</div>
        <StartCountForm />
      </section>

      <section className="group-block">
        <div className="section-title">
          Сессии
          <span className="group-count">{sessions.length}</span>
        </div>
        {sessions.length === 0 ? (
          <div className="empty">
            <b>Сессий ещё не было</b>
            Первая инвентаризация — со склада: бот, «🗂 Инвентаризация узлов», склад, по одному узлу с фото.
          </div>
        ) : (
          <div className="rows">
            {sessions.map((s) => {
              const st = statusOf(s);
              return (
                <Link key={s.id} className="row" href={`/parts/count/${s.id}`}>
                  <span className="t">
                    {partLocationLabel(s.location)} · {когда(s.startedAt)}
                    {s.personName ? ` · ${s.personName}` : ""}
                    {s.note ? ` · ${s.note}` : ""}
                  </span>
                  <span className="pill mono">строк {s.lines}</span>
                  <span className={`pill ${st.cls}`}>{st.text}</span>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
