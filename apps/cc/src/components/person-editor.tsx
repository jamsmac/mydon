"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { savePerson, setPersonActive } from "../app/team/actions";
import type { Person } from "../lib/core";

export function PersonEditor({ person }: { person: Person }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const linked = person.tgChatId !== null;
  const active = person.active === "yes";

  function onSave(form: FormData) {
    start(async () => {
      const res = await savePerson(person.id, form);
      setMsg(res.ok ? { kind: "ok", text: "Сохранено" } : { kind: "err", text: res.error ?? "Ошибка" });
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="card">
      <div className="card-top">
        <span className={`pill ${linked ? "ok" : ""}`}>
          {linked ? "в Telegram" : "не подключён"}
        </span>
        <span className={`pill ${active ? "" : "bad"}`}>{active ? "работает" : "не работает"}</span>
        <button
          type="button"
          className="btn"
          onClick={() =>
            start(async () => {
              const res = await setPersonActive(person.id, !active);
              if (res.ok) router.refresh();
            })
          }
          disabled={pending}
        >
          {active ? "Больше не работает" : "Вернуть в работу"}
        </button>
      </div>

      {!linked && (
        <p className="hint">
          Чтобы задачи доходили: сотрудник открывает бота MYDON и отправляет «Старт». Связь
          установится сама — по указанному ниже Telegram.
        </p>
      )}

      <form action={onSave} className="form">
        <label>
          <span>Имя</span>
          <input name="name" defaultValue={person.name} />
        </label>
        <label>
          <span>Кто он</span>
          <input name="role" defaultValue={person.role ?? ""} placeholder="оператор автоматов" />
        </label>
        <label>
          <span>Направление</span>
          <select name="domain" defaultValue={person.domain ?? ""}>
            <option value="">без направления</option>
            <option value="globerent">GLOBERENT</option>
            <option value="vendhub">VendHub</option>
            <option value="personal">Личный контур</option>
          </select>
          <small className="hint">Куда нанят: задачи и качество видны внутри этого дела.</small>
        </label>
        <label>
          <span>Телефон</span>
          <input name="phone" defaultValue={person.phone ?? ""} inputMode="tel" />
        </label>
        <label>
          <span>Почта</span>
          <input name="email" defaultValue={person.email ?? ""} inputMode="email" />
        </label>
        <label>
          <span>Telegram</span>
          <input name="tgUsername" defaultValue={person.tgUsername ?? ""} placeholder="@rustam" />
        </label>
        <div className="form-actions">
          <button type="submit" className="btn primary" disabled={pending}>
            {pending ? "Сохраняю…" : "Сохранить"}
          </button>
          {msg && <span className={msg.kind === "ok" ? "ok-text" : "err-text"}>{msg.text}</span>}
        </div>
      </form>
    </div>
  );
}
