import Link from "next/link";
import { core, CoreUnavailable, type Task, type TaskComment } from "../../../lib/core";
import { CoreDown } from "../../../components/core-down";
import { TaskDetail } from "../../../components/task-detail";
import { TaskEdit, type OwnerOption } from "../../../components/task-edit";
import { dueLabel } from "@mydon/shared";

export const dynamic = "force-dynamic";

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let task: Task;
  let comments: TaskComment[] = [];
  let ownerName = "—";
  let owners: OwnerOption[] = [];
  try {
    task = await core.task(id);
    // Переписка не критична для карточки: не загрузилась — не повод падать.
    try {
      comments = await core.taskComments(id);
    } catch {
      comments = [];
    }
    // Списки для переназначения. Не критичны — не загрузились, редактор просто
    // покажет текущего исполнителя.
    try {
      const [people, agents] = await Promise.all([core.people(), core.agents()]);
      owners = [
        ...people.map((p) => ({ value: `human:${p.id}`, label: p.name })),
        ...agents.map((a) => ({ value: `agent:${a.name}`, label: `${a.name} · агент` })),
      ];
    } catch {
      owners = [];
    }
    if (task.ownerKind === "human" && task.ownerRef) {
      try {
        ownerName = (await core.person(task.ownerRef)).name;
      } catch {
        ownerName = "сотрудник удалён";
      }
    } else if (task.ownerRef) {
      ownerName = task.ownerRef;
    }
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }

  return (
    <>
      <div className="page-head">
        <Link href="/tasks" className="back">
          ← Все задачи
        </Link>
        <h1>{task.title}</h1>
        <p>
          {ownerName}
          {task.ownerKind === "agent" ? " · агент" : ""} · {dueLabel(task.due)}
        </p>
      </div>

      <TaskDetail task={task} comments={comments} />
      <TaskEdit task={task} owners={owners} />
    </>
  );
}
