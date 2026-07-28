"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createAgent } from "../app/agents/actions";

/**
 * Заведение агента. Спрашиваем только необходимое — остальное настраивается
 * в карточке. Новый агент создаётся ВЫКЛЮЧЕННЫМ: включение — осознанный шаг.
 */
export function NewAgentForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onSubmit(form: FormData) {
    start(async () => {
      const res = await createAgent(form);
      if (res.ok && res.goTo) router.push(res.goTo);
      else setError(res.error ?? "Не удалось создать");
    });
  }

  if (!open) {
    return (
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        + Новый агент
      </button>
    );
  }

  return (
    <form action={onSubmit} className="form card">
      <label>
        <span>Имя (машинное)</span>
        <input name="name" placeholder="trent-ops" autoFocus />
        <small className="hint">
          Латиница, цифры и дефис. По этому имени агент виден в журнале — потом не меняется.
        </small>
      </label>

      <label>
        <span>Направление</span>
        <select name="business" defaultValue="shared">
          <option value="shared">Общий</option>
          <option value="globerent">GLOBERENT</option>
          <option value="vendhub">VendHub</option>
          <option value="trent">TRent</option>
          <option value="personal">Личное</option>
          <option value="mydon">MYDON</option>
        </select>
      </label>

      <label>
        <span>Короткое описание</span>
        <input name="description" placeholder="Контроль аренды техники" />
      </label>

      <label>
        <span>Зачем нужен (миссия)</span>
        <textarea name="mission" rows={2} placeholder="Следить за возвратами и простоем" />
      </label>

      <label>
        <span>Самостоятельность</span>
        <select name="autonomyDefault" defaultValue="T1">
          <option value="T0">T0 — только спрашивает</option>
          <option value="T1">T1 — предлагает, решаешь ты</option>
          <option value="T2">T2 — мелкое делает сам</option>
          <option value="T3">T3 — многое делает сам</option>
          <option value="T4">T4 — почти всё сам</option>
        </select>
      </label>

      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={pending}>
          {pending ? "Создаю…" : "Создать"}
        </button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          Отмена
        </button>
        {error && <span className="err-text">{error}</span>}
      </div>
      <small className="hint">Агент создастся выключенным — включишь, когда настроишь.</small>
    </form>
  );
}
