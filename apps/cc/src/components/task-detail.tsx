"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { addComment, changeStatus, completeTask, rateTask } from "../app/tasks/actions";
import type { Task, TaskComment } from "../lib/core";
import { when } from "../lib/format";

const QUALITY_LABEL = {
  excellent: "⭐ отлично",
  accepted: "принято",
  redo: "возвращена на доработку",
} as const;

const STATUS_LABEL: Record<Task["status"], string> = {
  todo: "не начата",
  in_progress: "в работе",
  done: "сделана",
  cancelled: "отменена",
};

/** Кто написал: «owner» → «ты», «person:<id>» → сотрудник, «agent:<имя>» → агент. */
function authorLabel(ref: string, people: Record<string, string>): string {
  if (ref === "owner") return "ты";
  if (ref.startsWith("agent:")) return ref.slice(6);
  // Имя вместо обезличенного «исполнитель»: владелец должен видеть, кто пишет.
  if (ref.startsWith("person:")) return people[ref.slice("person:".length)] ?? "исполнитель";
  return ref;
}

export function TaskDetail({
  task,
  comments,
  peopleById = {},
}: {
  task: Task;
  comments: TaskComment[];
  peopleById?: Record<string, string>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState<string | null>(null);

  const closed = task.status === "done" || task.status === "cancelled";

  function act(fn: () => Promise<{ ok: boolean; error?: string }>) {
    start(async () => {
      const res = await fn();
      if (res.ok) {
        setError(null);
        setNote("");
        setMsg("");
        router.refresh();
      } else {
        setError(res.error ?? "Не получилось");
      }
    });
  }

  return (
    <>
      <div className="card">
        <div className="card-top">
          <span className={`pill ${task.status === "done" ? "ok" : ""}`}>
            {STATUS_LABEL[task.status]}
          </span>
          {!closed && task.status !== "in_progress" && (
            <button
              type="button"
              className="btn"
              onClick={() => act(() => changeStatus(task.id, "in_progress"))}
              disabled={pending}
            >
              Взять в работу
            </button>
          )}
          {!closed && (
            <button
              type="button"
              className="btn"
              onClick={() => act(() => changeStatus(task.id, "cancelled"))}
              disabled={pending}
            >
              Отменить
            </button>
          )}
        </div>

        {task.description && <p className="task-desc">{task.description}</p>}

        {task.resultNote ? (
          <div className="result-box">
            <div className="result-title">Отчёт о выполнении</div>
            <p>{task.resultNote}</p>
            {task.completedAt && <small>Закрыта {when(task.completedAt)}</small>}
            {task.status === "done" &&
              (task.quality ? (
                <div className="form-actions">
                  <span className={`pill ${task.quality === "redo" ? "bad" : "ok"}`}>
                    {QUALITY_LABEL[task.quality]}
                  </span>
                </div>
              ) : (
                <div className="form-actions">
                  <button type="button" className="btn" disabled={pending}
                    onClick={() => act(() => rateTask(task.id, "excellent"))}>
                    ⭐ Отлично
                  </button>
                  <button type="button" className="btn" disabled={pending}
                    onClick={() => act(() => rateTask(task.id, "accepted"))}>
                    Принято
                  </button>
                  <button type="button" className="btn" disabled={pending}
                    onClick={() => act(() => rateTask(task.id, "redo"))}>
                    ↩ Переделать
                  </button>
                </div>
              ))}
          </div>
        ) : (
          !closed && (
            <div className="form">
              <label>
                <span>Закрыть с отчётом</span>
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Что сделано? Коротко."
                />
                <small className="hint">
                  Без отчёта закрыть нельзя: через неделю «сделано» само по себе ничего не скажет.
                </small>
              </label>
              <div className="form-actions">
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => act(() => completeTask(task.id, note))}
                  disabled={pending}
                >
                  {pending ? "…" : "Сделано"}
                </button>
                {error && <span className="err-text">{error}</span>}
              </div>
            </div>
          )
        )}
      </div>

      <div className="section-title">Переписка</div>
      {comments.length === 0 ? (
        <div className="empty">
          <b>Пока тихо</b>
          Здесь появятся уточнения и вопросы по задаче.
        </div>
      ) : (
        <div className="rows">
          {comments.map((c) => (
            <div className="row" key={c.id}>
              <div className="t">
                <b>{c.body}</b>
                <small>{authorLabel(c.authorRef, peopleById)}</small>
              </div>
              <span className="when">{when(c.createdAt)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="form card">
        <label>
          <span>Добавить сообщение</span>
          <input
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            placeholder="Уточнение или вопрос"
            onKeyDown={(e) => {
              if (e.key === "Enter" && msg.trim().length > 0) act(() => addComment(task.id, msg));
            }}
          />
        </label>
        <div className="form-actions">
          <button
            type="button"
            className="btn"
            onClick={() => act(() => addComment(task.id, msg))}
            disabled={pending || msg.trim().length === 0}
          >
            Отправить
          </button>
        </div>
      </div>
    </>
  );
}
