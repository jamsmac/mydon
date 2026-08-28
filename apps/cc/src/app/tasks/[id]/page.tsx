import Link from "next/link";
import { core, CoreUnavailable, type Attachment, type Person, type Task, type TaskComment } from "../../../lib/core";
import { CoreDown } from "../../../components/core-down";
import { PhotoGallery } from "../../../components/photo-gallery";
import { TaskDetail } from "../../../components/task-detail";
import { TaskEdit, type OwnerOption } from "../../../components/task-edit";
import { when } from "../../../lib/format";
import { dueLabel } from "@mydon/shared";

export const dynamic = "force-dynamic";

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let task: Task;
  let comments: TaskComment[] = [];
  let ownerName = "—";
  let owners: OwnerOption[] = [];
  let peopleById: Record<string, string> = {};
  let photos: Attachment[] = [];
  try {
    task = await core.task(id);
    // Фото-отчёты (до/после/поломка) — сотрудники шлют их из бота, и до сих
    // пор владелец их в карточке задачи не видел вовсе.
    try {
      photos = await core.attachments("task", id);
    } catch {
      photos = [];
    }
    // Переписка не критична для карточки: не загрузилась — не повод падать.
    try {
      comments = await core.taskComments(id);
    } catch {
      comments = [];
    }
    // Списки для переназначения. Не критичны — не загрузились, редактор просто
    // покажет текущего исполнителя.
    try {
      // Отдельные страховки: сбой агентов не должен лишать переписку имён
      // людей, а people(true) даёт имена и уволенным авторам старых записей.
      const [people, agents] = await Promise.all([
        core.people(true).catch(() => [] as Person[]),
        core.agents().catch(() => []),
      ]);
      owners = [
        ...people.filter((p) => p.active === "yes").map((p) => ({ value: `human:${p.id}`, label: p.name })),
        ...agents.map((a) => ({ value: `agent:${a.name}`, label: `${a.name} · агент` })),
      ];
      // Имена для подписи переписки: комментарий сотрудника должен носить
      // имя, а не обезличенное «исполнитель».
      peopleById = Object.fromEntries(people.map((p) => [p.id, p.name]));
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
        {task.confirmedAt !== null && (
          <p>
            Принято:{" "}
            {task.confirmedBy === "owner"
              ? "владелец"
              : (peopleById[task.confirmedBy?.startsWith("person:") ? task.confirmedBy.slice("person:".length) : ""] ??
                "сотрудник")}
            , {when(task.confirmedAt)}
          </p>
        )}
      </div>

      {photos.length > 0 && <PhotoGallery attachments={photos} />}

      <TaskDetail task={task} comments={comments} peopleById={peopleById} />
      <TaskEdit task={task} owners={owners} />
    </>
  );
}
