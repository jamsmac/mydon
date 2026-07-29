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

  const initials = ownerName.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();

  return (
    <div className={`trow ${urgent ? "hot" : ""}`}>
      <button
        type="button"
        className="tick"
        onClick={() => setClosing((v) => !v)}
        aria-label="Отметить выполненной"
        disabled={pending}
        style={{ background: "none", border: "none", color: "var(--tx-3)", fontSize: 17, padding: 0 }}
      >
        {closing ? "×" : "○"}
      </button>

      <div className="tb">
        <Link href={`/tasks/${task.id}`} className="tt" style={{ display: "block" }}>
          {task.title}
        </Link>
        <div className="tm">
          <span className="who">
            <span className={`av ${task.ownerKind === "agent" ? "ag" : ""}`}>
              {task.ownerKind === "agent" ? "✦" : initials || "?"}
            </span>
            {ownerName}
          </span>
          {prio ? <span>{prio}</span> : null}
          {task.status === "in_progress" ? <span>в работе</span> : null}
        </div>

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
      <span className={`due ${urgent ? "hot" : ""}`}>{dueLabel(task.due)}</span>
    </div>
  );
}
