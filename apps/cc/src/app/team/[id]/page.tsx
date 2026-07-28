import Link from "next/link";
import { core, CoreUnavailable, type Person, type Task } from "../../../lib/core";
import { CoreDown } from "../../../components/core-down";
import { PersonEditor } from "../../../components/person-editor";
import { dueLabel } from "@mydon/shared";

const DOMAIN_TITLES: Record<string, string> = {
  globerent: "GLOBERENT",
  vendhub: "VendHub",
  personal: "Личный контур",
  mydon: "MYDON",
};

export const dynamic = "force-dynamic";

export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let person: Person;
  let tasks: Task[] = [];
  try {
    person = await core.person(id);
    try {
      tasks = await core.tasks({ ownerKind: "human", ownerRef: id });
    } catch {
      tasks = [];
    }
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }

  const open = tasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
  const done = tasks.filter((t) => t.status === "done");

  // Качество по фактам, а не по ощущениям: сроки и оценки из самих задач.
  const withDue = done.filter((t) => t.due !== null);
  const onTime = withDue.filter((t) => t.completedAt !== null && t.completedAt <= t.due!);
  const excellent = done.filter((t) => t.quality === "excellent").length;
  const redo = tasks.filter((t) => t.quality === "redo").length;
  const unrated = done.filter((t) => t.quality === null).length;

  return (
    <>
      <div className="page-head">
        <Link href="/team" className="back">← Команда</Link>
        <h1>{person.name}</h1>
        <p>
          {person.role ?? "роль не указана"}
          {person.domain ? ` · ${DOMAIN_TITLES[person.domain] ?? person.domain}` : ""}
        </p>
      </div>

      <PersonEditor person={person} />

      {done.length > 0 && (
        <div className="card">
          <div className="result-title">Качество работы</div>
          <p>
            Сделано задач: {done.length}
            {withDue.length > 0 ? ` · в срок ${Math.round((onTime.length / withDue.length) * 100)}%` : ""}
            {excellent > 0 ? ` · ⭐ отлично ×${excellent}` : ""}
            {redo > 0 ? ` · ↩ переделки ×${redo}` : ""}
          </p>
          {unrated > 0 && (
            <small className="hint">
              Без оценки: {unrated}. Оценка ставится в карточке задачи — открой её из списка ниже.
            </small>
          )}
        </div>
      )}

      <div className="section-title">
        В работе<span className="group-count">{open.length}</span>
      </div>
      {open.length === 0 ? (
        <div className="empty"><b>Свободен</b>Открытых задач нет.</div>
      ) : (
        <div className="rows">
          {open.map((t) => (
            <Link href={`/tasks/${t.id}`} className="row rowlink" key={t.id}>
              <div className="t">
                <b>{t.title}</b>
                <small>{dueLabel(t.due)}</small>
              </div>
            </Link>
          ))}
        </div>
      )}

      {done.length > 0 && (
        <>
          <div className="section-title">Сделано</div>
          <div className="rows">
            {done.slice(0, 15).map((t) => (
              <Link href={`/tasks/${t.id}`} className="row rowlink" key={t.id}>
                <div className="t">
                  <b>{t.title}</b>
                  <small>{t.resultNote ?? "без отчёта"}</small>
                </div>
                <span className={`pill ${t.quality === "redo" ? "bad" : "ok"}`}>
                  {t.quality === "excellent" ? "⭐ отлично" : t.quality === "redo" ? "переделка" : "сделано"}
                </span>
              </Link>
            ))}
          </div>
        </>
      )}
    </>
  );
}
