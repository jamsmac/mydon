"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createPerson } from "../app/team/actions";

/** Добавление сотрудника: минимум полей, остальное — в карточке. */
export function NewPersonForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onSubmit(form: FormData) {
    start(async () => {
      const res = await createPerson(form);
      if (res.ok) {
        setOpen(false);
        setError(null);
        router.refresh();
      } else {
        setError(res.error ?? "Не удалось добавить");
      }
    });
  }

  if (!open) {
    return (
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        + Сотрудник
      </button>
    );
  }

  return (
    <form action={onSubmit} className="form card">
      <label>
        <span>Имя</span>
        <input name="name" placeholder="Рустам" autoFocus />
      </label>
      <label>
        <span>Кто он</span>
        <input name="role" placeholder="оператор автоматов" />
      </label>
      <label>
        <span>Направление</span>
        <select name="domain" defaultValue="">
          <option value="">без направления</option>
          <option value="globerent">GLOBERENT</option>
          <option value="vendhub">VendHub</option>
          <option value="personal">Личный контур</option>
        </select>
      </label>
      <label>
        <span>Телефон</span>
        <input name="phone" placeholder="+998 90 123-45-67" inputMode="tel" />
      </label>
      <label>
        <span>Telegram</span>
        <input name="tgUsername" placeholder="@rustam" />
        <small className="hint">
          Чтобы задачи доходили, сотрудник должен один раз написать боту «Старт» — после этого
          связь установится сама.
        </small>
      </label>
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={pending}>
          {pending ? "…" : "Добавить"}
        </button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          Отмена
        </button>
        {error && <span className="err-text">{error}</span>}
      </div>
    </form>
  );
}
