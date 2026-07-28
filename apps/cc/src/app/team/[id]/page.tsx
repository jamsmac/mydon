import Link from "next/link";
import { core, CoreUnavailable, type Person, type Task } from "../../../lib/core";
import { CoreDown } from "../../../components/core-down";
import { PersonEditor } from "../../../components/person-editor";
import { dueLabel } from "@mydon/shared";

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

  return (
    <>
      <div className="page-head">
        <Link href="/team" className="back">← Команда</Link>
        <h1>{person.name}</h1>
        <p>{person.role ?? "роль не указана"}</p>
      </div>

      <PersonEditor person={person} />

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
                <span className="pill ok">сделано</span>
              </Link>
            ))}
          </div>
        </>
      )}
    </>
  );
}
