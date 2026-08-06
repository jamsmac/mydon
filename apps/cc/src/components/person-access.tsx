"use client";

import { useState, useTransition } from "react";
import { ROLE_LABELS, STAFF_ROLES, rolesLabel, type StaffRole } from "@mydon/shared";
import { invitePerson, revokePerson, setPersonRoles } from "../app/team/actions";

/**
 * Доступ сотрудника: роли, приглашение, отзыв.
 *
 * Клиентский компонент, потому что мультивыбор ролей — это состояние до
 * сохранения, а ссылка-приглашение показывается ровно один раз и никуда
 * не сохраняется: в базе лежит только отпечаток кода.
 *
 * Роль «владелец» из списка исключена: владелец опознаётся по allowlist
 * Telegram, а не по строке в карточке, и кнопка «Владелец» здесь была бы
 * способом выдать себе всё через панель.
 */
export function PersonAccess({
  id,
  linked,
  roles,
}: {
  id: string;
  linked: boolean;
  roles: string[];
}) {
  const [selected, setSelected] = useState<string[]>(roles);
  const [link, setLink] = useState<string | null>(null);
  const [expires, setExpires] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const assignable = STAFF_ROLES.filter((r) => r !== "owner");
  const toggle = (r: StaffRole) =>
    setSelected((cur) => (cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]));

  const changed =
    selected.length !== roles.length || selected.some((r) => !roles.includes(r));

  return (
    <section className="group-block">
      <div className="section-title">Доступ</div>

      <p className="group-hint">
        {linked
          ? `Telegram привязан. Права: ${rolesLabel(roles)}.`
          : "Telegram не привязан — задачи и напоминания до него не дойдут."}
      </p>

      <div className="chips">
        {assignable.map((r) => (
          <button
            key={r}
            type="button"
            className={`chip ${selected.includes(r) ? "active" : ""}`}
            onClick={() => toggle(r)}
            disabled={pending}
          >
            {selected.includes(r) ? "✓ " : ""}
            {ROLE_LABELS[r]}
          </button>
        ))}
      </div>

      <div className="row-actions">
        {changed && (
          <button
            type="button"
            className="btn"
            disabled={pending}
            onClick={() =>
              start(async () => {
                setError(null);
                const res = await setPersonRoles(id, selected);
                if (!res.ok) setError(res.error ?? "Не сохранилось");
              })
            }
          >
            Сохранить роли
          </button>
        )}

        <button
          type="button"
          className="btn"
          disabled={pending}
          onClick={() =>
            start(async () => {
              setError(null);
              setLink(null);
              const res = await invitePerson(id, selected);
              if (!res.ok) {
                setError(res.error ?? "Не получилось");
                return;
              }
              setLink(res.link ?? null);
              setExpires(res.expiresAt ?? null);
            })
          }
        >
          {linked ? "Выдать новую ссылку" : "Выдать ссылку для входа"}
        </button>

        {linked && (
          <button
            type="button"
            className="btn danger"
            disabled={pending}
            onClick={() =>
              start(async () => {
                setError(null);
                const res = await revokePerson(id);
                if (!res.ok) setError(res.error ?? "Не получилось");
              })
            }
          >
            Отозвать доступ
          </button>
        )}
      </div>

      {link && (
        <div className="empty">
          <b>Ссылка одноразовая, показываю один раз</b>
          {/* Отдельной строкой без обрамления — чтобы выделить и переслать
              целиком, не вычищая лишнее. */}
          <code className="mono">{link}</code>
          {expires && (
            <span>
              Действует до{" "}
              {new Date(expires).toLocaleString("ru-RU", {
                timeZone: "Asia/Tashkent",
                day: "2-digit",
                month: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })}
              . В базе хранится только отпечаток кода — повторить показ нельзя.
            </span>
          )}
        </div>
      )}

      {error && <p className="err">{error}</p>}
    </section>
  );
}
