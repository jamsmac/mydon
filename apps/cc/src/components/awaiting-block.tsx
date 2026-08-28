"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { confirmTask, rateTask } from "../app/tasks/actions";
import { when } from "../lib/format";
import type { Task } from "../lib/core";

/**
 * Блок «Ждут подтверждения»: то, что требует решения СЕЙЧАС, поэтому рисуется
 * над группами срочности. Показывается ВСЕГДА, включая пусто — исчезнувший
 * блок неотличим от «ещё не выкатили».
 */
export function AwaitingBlock({ tasks, names }: { tasks: Task[]; names: Map<string, string> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function closerName(task: Task): string {
    const id = task.closedBy?.startsWith("person:") ? task.closedBy.slice("person:".length) : task.ownerRef;
    return (id ? names.get(id) : null) ?? "сотрудник";
  }

  function onConfirm(id: string) {
    setError(null);
    start(async () => {
      const res = await confirmTask(id);
      if (res.ok) {
        router.refresh();
      } else {
        setError(res.error ?? "Не удалось принять");
      }
    });
  }

  function onRedo(id: string) {
    setError(null);
    start(async () => {
      const res = await rateTask(id, "redo");
      if (res.ok) {
        router.refresh();
      } else {
        setError(res.error ?? "Не удалось вернуть в работу");
      }
    });
  }

  return (
    <div className="awaiting-block">
      <h3>Ждут подтверждения{tasks.length > 0 ? ` (${tasks.length})` : ""}</h3>
      {tasks.length === 0 ? (
        <div className="empty">
          <b>Ничего не ждёт приёмки</b>
          {"Как только кто-то закроет задачу, она появится здесь."}
        </div>
      ) : (
        <div className="awaiting-rows">
          {tasks.map((task) => (
            <div key={task.id} className="awaiting-row">
              <div className="tt">{task.title}</div>
              <div className="tm">
                Закрыл: {closerName(task)} · {task.completedAt ? when(task.completedAt) : "—"}
              </div>
              {task.resultNote ? <div className="report">{task.resultNote}</div> : null}
              <div className="actions">
                <button type="button" className="btn primary" onClick={() => onConfirm(task.id)} disabled={pending}>
                  Принять
                </button>
                <button type="button" className="btn" onClick={() => onRedo(task.id)} disabled={pending}>
                  Переделать
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {error && <span className="err-text">{error}</span>}
    </div>
  );
}
