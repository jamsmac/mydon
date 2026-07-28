"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { completeTask } from "../app/tasks/actions";
import type { Task } from "../lib/core";
import { dueLabel, priorityLabel } from "@mydon/shared";

/**
 * Строка задачи. Закрытие — в один шаг прямо из списка, но с отчётом:
 * «сделано» без объяснения ничего не значит владельцу через неделю.
 */
export function TaskRow({
  task,
  ownerName,
  urgent = false,
}: {
  task: Task;
  ownerName: string;
  urgent?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [closing, setClosing] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const prio = priorityLabel(task.priority);

  function onDone() {
    start(async () => {
      const res = await completeTask(task.id, note);
      if (res.ok) {
        setClosing(false);
        setNote("");
        setError(null);
        router.refresh();
      } else {
        setError(res.error ?? "Не удалось закрыть");
      }
    });
  }

  return (
    <div className={`row taskrow ${urgent ? "urgent" : ""}`}>
      <button
        type="button"
        className="tick"
        onClick={() => setClosing((v) => !v)}
        aria-label="Отметить выполненной"
        disabled={pending}
      >
        {closing ? "×" : "○"}
      </button>

      <div className="t">
        <Link href={`/tasks/${task.id}`} className="tasklink">
          <b>{task.title}</b>
        </Link>
        <small>
          {ownerName}
          {task.ownerKind === "agent" ? " · агент" : ""} · {dueLabel(task.due)}
          {prio ? ` · ${prio}` : ""}
          {task.status === "in_progress" ? " · в работе" : ""}
        </small>

        {closing && (
          <div className="close-box">
            <input
              className="close-note"
              placeholder="Что сделано? (коротко — это отчёт)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") onDone();
                if (e.key === "Escape") setClosing(false);
              }}
            />
            <button type="button" className="btn primary" onClick={onDone} disabled={pending}>
              {pending ? "…" : "Готово"}
            </button>
            {error && <span className="err-text">{error}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
