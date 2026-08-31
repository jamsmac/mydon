import { core, CoreUnavailable, type AgentCard, type Person, type Task } from "../../lib/core";
import { AwaitingBlock } from "../../components/awaiting-block";
import { CoreDown } from "../../components/core-down";
import { QuickAdd } from "../../components/task-quick-add";
import { TaskRow } from "../../components/task-row";
import { groupByUrgency } from "@mydon/shared";
import { groupTasksByDirection } from "../../lib/task-directions";

export const dynamic = "force-dynamic";

/**
 * Задачи. Сначала направление, внутри — срочность: так очередь
 * разделена по бизнес-контурам, а в каждом видно, что делать сейчас.
 */
export default async function Tasks() {
  let open: Task[];
  let awaiting: Task[];
  let people: Person[] = [];
  let agents: AgentCard[] = [];
  try {
    [open, awaiting, people, agents] = await Promise.all([
      core.taskBoard({ open: "1" }),
      // Второй список: `done` без отметки приёмки не показывает никто —
      // ни `/tasks` (там `open=1`), ни лента. Именно он требует решения
      // владельца прямо сейчас, поэтому блок стоит НАД группами срочности.
      core.taskBoard({ awaiting: "1" }),
      core.people(),
      core.agents(),
    ]);
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }

  const urgencyGroups = groupByUrgency(open);
  const directionGroups = groupTasksByDirection(open);
  // Имена исполнителей: в строке задачи должно быть видно «кто», а не id.
  const names = new Map<string, string>();
  for (const p of people) names.set(`human:${p.id}`, p.name);
  for (const a of agents) names.set(`agent:${a.name}`, a.name);

  const overdue = urgencyGroups.find((g) => g.key === "overdue")?.tasks.length ?? 0;

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

      {directionGroups.length === 0 ? (
        <div className="empty">
          <b>Пусто — и это нормально</b>
          Поставь задачу себе, сотруднику или агенту в строке выше.
        </div>
      ) : (
        directionGroups.map((direction) => (
          <section key={direction.key} className="group-block">
            <h2 className="section-title task-direction-title">
              {direction.label}
              <span className="group-count">{direction.tasks.length}</span>
            </h2>
            {groupByUrgency(direction.tasks).map((urgency) => (
              <div key={urgency.key} className="task-urgency-group">
                <h3 className="section-title task-urgency-title">
                  {urgency.title}
                  <span className="group-count">{urgency.tasks.length}</span>
                </h3>
                {urgency.hint && <p className="group-hint">{urgency.hint}</p>}
                <div className="rows">
                  {urgency.tasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      ownerName={
                        names.get(`${task.ownerKind}:${task.ownerRef ?? ""}`) ??
                        task.ownerRef ??
                        "—"
                      }
                      urgent={urgency.key === "overdue"}
                    />
                  ))}
                </div>
              </div>
            ))}
          </section>
        ))
      )}
    </>
  );
}
