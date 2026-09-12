"use client";

import { useState } from "react";
import { backdateLabel, parseOccurred, tashkentLocalInput } from "@mydon/shared";

/**
 * «Когда произошло» в форме полевой операции (волна 5, R-H-1…R-H-4, R-H-12).
 *
 * По умолчанию — сейчас (R-H-3): обычный ввод не требует лишнего движения,
 * поле свёрнуто в строку «сегодня, 14:05 · изменить». Разворачивается, только
 * когда человек вводит прошлое.
 *
 * Время ташкентское (`tashkentLocalInput`), а не UTC: `toISOString()` в поле
 * открыл бы форму на пять часов назад. Будущее отбивается сразу — та же
 * проверка, что на сервере, чтобы отказ не приезжал кругом.
 *
 * Дата события раньше сегодняшней — запись пойдёт на одобрение владельцу
 * (R-H-12). Об этом сказано ДО отправки: «уйдёт на одобрение» — не сюрприз
 * после нажатия.
 */
export function OccurredAtField({
  value,
  onChange,
  now = new Date(),
  label = "Когда произошло",
}: {
  /** Ташкентские настенные часы, `YYYY-MM-DDTHH:mm`; пусто — «сейчас». */
  value: string;
  onChange: (value: string) => void;
  now?: Date;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = value === "" ? tashkentLocalInput(now) : value;
  const parsed = parseOccurred(current, now);
  const problem = "problem" in parsed ? parsed.problem : null;
  const gap = "at" in parsed ? backdateLabel(parsed.at, now) : null;

  if (!open) {
    return (
      <p className="hint">
        {label}: <b>{current.replace("T", ", ")}</b> (сейчас){" "}
        <button type="button" className="btn ghost" onClick={() => setOpen(true)}>
          изменить
        </button>
      </p>
    );
  }

  return (
    <label>
      <span>{label}</span>
      <input
        type="datetime-local"
        value={current}
        max={tashkentLocalInput(now)}
        onChange={(e) => onChange(e.target.value)}
      />
      {problem ? (
        <small className="err-text">{problem}</small>
      ) : gap ? (
        <small className="hint">{gap} — запись уйдёт владельцу на одобрение и до решения считается как есть.</small>
      ) : (
        <small className="hint">Сегодняшнее событие одобрения не требует.</small>
      )}
    </label>
  );
}
