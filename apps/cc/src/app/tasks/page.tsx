import { core, CoreUnavailable, type AgentCard, type Person, type Task } from "../../lib/core";
import { AwaitingBlock } from "../../components/awaiting-block";
import { CoreDown } from "../../components/core-down";
import { QuickAdd } from "../../components/task-quick-add";
import { TaskRow } from "../../components/task-row";
import { groupByUrgency } from "@mydon/shared";

export const dynamic = "force-dynamic";

/**
 * Задачи. Группировка по срочности, а не по статусам: владельцу нужен ответ
 * на «что делать сейчас», а не «в каком состоянии карточка».
 */
export default async function Tasks() {
  let open: Task[];
  let awaiting: Task[];
  let people: Person[] = [];
  let agents: AgentCard[] = [];
  try {
    [open, awaiting, people, agents] = await Promise.all([
      core.tasks({ open: "1" }),
      // Второй список: `done` без отметки приёмки не показывает никто —
      // ни `/tasks` (там `open=1`), ни лента. Именно он требует решения
      // владельца прямо сейчас, поэтому блок стоит НАД группами срочности.
      core.tasks({ awaiting: "1" }),
      core.people(),
      core.agents(),
    ]);
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }

  const groups = groupByUrgency(open);
  // Имена исполнителей: в строке задачи должно быть видно «кто», а не id.
  const names = new Map<string, string>();
  for (const p of people) names.set(`human:${p.id}`, p.name);
  for (const a of agents) names.set(`agent:${a.name}`, a.name);

  const overdue = groups.find((g) => g.key === "overdue")?.tasks.length ?? 0;

  return (
    <>
      <div className="page-head">
        <h1>Задачи</h1>
        <p>
          {open.length === 0
            ? "Открытых задач нет."
            : `Открыто ${open.length}${overdue > 0 ? `, из них просрочено ${overdue}` : ""}.`}
        </p>
      </div>

      <QuickAdd people={people} agents={agents.map((a) => ({ name: a.name, status: a.status }))} />

      <AwaitingBlock tasks={awaiting} names={new Map(people.map((p) => [p.id, p.name]))} />

      {groups.length === 0 ? (
        <div className="empty">
          <b>Пусто — и это нормально</b>
          Поставь задачу себе, сотруднику или агенту в строке выше.
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.key} className="group-block">
            <div className="section-title">
              {g.title}
              <span className="group-count">{g.tasks.length}</span>
            </div>
            {g.hint && <p className="group-hint">{g.hint}</p>}
            <div className="rows">
              {g.tasks.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  ownerName={names.get(`${t.ownerKind}:${t.ownerRef ?? ""}`) ?? t.ownerRef ?? "—"}
                  urgent={g.key === "overdue"}
                />
              ))}
            </div>
          </section>
        ))
      )}
    </>
  );
}
