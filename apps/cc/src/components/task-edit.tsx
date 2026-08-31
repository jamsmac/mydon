"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { editTask } from "../app/tasks/actions";
import type { Task } from "../lib/core";
import { DOMAIN_LABELS, DOMAINS, dueLabel } from "@mydon/shared";

const PRIORITIES: { value: Task["priority"]; label: string }[] = [
  { value: "low", label: "низкий" },
  { value: "normal", label: "обычный" },
  { value: "high", label: "высокий" },
  { value: "urgent", label: "срочный" },
];

export interface OwnerOption {
  value: string; // "human:<id>" | "agent:<name>"
  label: string;
}

/**
 * Правка полей задачи владельцем: направление, исполнитель, приоритет, срок,
 * заголовок, описание. Свёрнута по умолчанию — карточка не должна пугать формой.
 * Отправляем только изменённые поля; срок трогаем лишь если владелец его ввёл
 * или явно снял (иначе пустое поле стёрло бы существующий срок).
 */
export function TaskEdit({ task, owners }: { task: Task; owners: OwnerOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const currentOwner = task.ownerRef ? `${task.ownerKind}:${task.ownerRef}` : "";
  const currentDomain = DOMAINS.find((candidate) => candidate === task.domain) ?? "";
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [domain, setDomain] = useState(currentDomain);
  const [owner, setOwner] = useState(currentOwner);
  const [priority, setPriority] = useState<Task["priority"]>(task.priority);
  const [due, setDue] = useState("");

  function run(patch: Parameters<typeof editTask>[1], after?: () => void) {
    start(async () => {
      const res = await editTask(task.id, patch);
      setMsg(res.ok ? { kind: "ok", text: "Сохранено" } : { kind: "err", text: res.error ?? "Ошибка" });
      if (res.ok) {
        after?.();
        router.refresh();
      }
    });
  }

  function onSave() {
    const patch: Parameters<typeof editTask>[1] = {};
    if (title.trim() !== task.title) patch.title = title;
    if (description.trim() !== (task.description ?? "")) patch.description = description;
    if (domain !== currentDomain && domain !== "") patch.domain = domain;
    if (owner !== currentOwner) patch.owner = owner;
    if (priority !== task.priority) patch.priority = priority;
    if (due.trim() !== "") patch.due = due; // срок меняем только если введён
    if (Object.keys(patch).length === 0) {
      setMsg({ kind: "err", text: "Нечего сохранять" });
      return;
    }
    run(patch, () => setDue(""));
  }

  if (!open) {
    return (
      <div className="form-actions">
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          Изменить задачу
        </button>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="section-title">Правка задачи</div>
      <div className="form">
        <label>
          <span>Заголовок</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={512} />
        </label>

        <label>
          <span>Описание</span>
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} />
        </label>

        <label>
          <span>Направление</span>
          <select value={domain} onChange={(event) => setDomain(event.target.value)}>
            {currentDomain === "" && (
              <option value="" disabled>
                — без направления —
              </option>
            )}
            {DOMAINS.map((value) => (
              <option key={value} value={value}>
                {DOMAIN_LABELS[value]}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Исполнитель</span>
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">— не назначен —</option>
            {owners.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Приоритет</span>
          <select value={priority} onChange={(e) => setPriority(e.target.value as Task["priority"])}>
            {PRIORITIES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Срок</span>
          <input
            value={due}
            onChange={(e) => setDue(e.target.value)}
            placeholder={`сейчас: ${dueLabel(task.due)} — впиши «завтра», «через 3 дня» или дату`}
          />
          {task.due && (
            <button
              type="button"
              className="btn"
              disabled={pending}
              onClick={() => run({ due: "" })}
              style={{ marginTop: 6, alignSelf: "flex-start" }}
            >
              Снять срок
            </button>
          )}
        </label>

        <div className="form-actions">
          <button type="button" className="btn primary" onClick={onSave} disabled={pending}>
            {pending ? "Сохраняю…" : "Сохранить"}
          </button>
          <button type="button" className="btn" onClick={() => setOpen(false)} disabled={pending}>
            Закрыть
          </button>
          {msg && <span className={msg.kind === "ok" ? "ok-text" : "err-text"}>{msg.text}</span>}
        </div>
      </div>
    </div>
  );
}
