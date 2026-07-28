"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveEntity } from "../app/card/actions";
import type { Entity } from "../lib/core";
import { MONO_KEYS } from "../lib/labels";

const mono = { fontFamily: "'IBM Plex Mono', ui-monospace, monospace" } as const;

/**
 * Редактор карточки: как в ПО владельца — поля пополняются и меняются на месте.
 * Пустое значение убирает поле; внизу можно добавить новое.
 */
export function EntityEditor({ entity }: { entity: Entity }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [adding, setAdding] = useState(false);

  function onSave(form: FormData) {
    start(async () => {
      const res = await saveEntity(entity.id, form);
      setMsg(res.ok ? { ok: true, text: "Сохранено" } : { ok: false, text: res.error ?? "Ошибка" });
      if (res.ok) {
        setAdding(false);
        router.refresh();
      }
    });
  }

  const attrs = Object.entries(entity.attrs ?? {});

  return (
    <form action={onSave} className="form card">
      <label>
        <span>Название</span>
        <input name="name" defaultValue={entity.name} />
      </label>
      <label>
        <span>Номер (серийник, ИНН, штрих-код)</span>
        <input name="externalRef" defaultValue={entity.externalRef ?? ""} style={mono} />
      </label>

      {attrs.map(([key, value]) => (
        <label key={key}>
          <span>{key}</span>
          <input
            name={`attr:${key}`}
            defaultValue={String(value ?? "")}
            style={MONO_KEYS.has(key) ? mono : undefined}
          />
          <small className="hint">Очисти поле и сохрани — оно исчезнет из карточки.</small>
        </label>
      ))}

      {adding ? (
        <div style={{ display: "flex", gap: 8 }}>
          <label style={{ flex: 1 }}>
            <span>Новое поле</span>
            <input name="newKey" placeholder="например: объём" autoFocus />
          </label>
          <label style={{ flex: 1 }}>
            <span>Значение</span>
            <input name="newValue" placeholder="0.5 л" />
          </label>
        </div>
      ) : (
        <button type="button" className="btn" onClick={() => setAdding(true)}>
          + Поле
        </button>
      )}

      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={pending}>
          {pending ? "Сохраняю…" : "Сохранить"}
        </button>
        {msg && <span className={msg.ok ? "ok-text" : "err-text"}>{msg.text}</span>}
      </div>
    </form>
  );
}
