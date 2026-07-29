"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createEntity } from "../app/card/actions";

/**
 * Добавление записи руками — прямо из вкладки: товар, аппарат, код справочника.
 * Минимум полей; остальное дополняется в карточке после создания.
 */
export function NewEntityForm({
  domain,
  type,
  label,
}: {
  domain: string;
  type: string;
  /** Название типа в единственном числе: «товар», «аппарат». */
  label: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onSubmit(form: FormData) {
    start(async () => {
      const res = await createEntity(domain, type, form);
      if (res.ok) {
        setOpen(false);
        setError(null);
        router.refresh();
      } else {
        setError(res.error ?? "Не удалось создать");
      }
    });
  }

  if (!open) {
    return (
      <button type="button" className="btn" style={{ marginTop: 10 }} onClick={() => setOpen(true)}>
        + {label}
      </button>
    );
  }

  return (
    <form action={onSubmit} className="form card" style={{ marginTop: 10 }}>
      <label>
        <span>Название</span>
        <input name="name" autoFocus />
      </label>
      <label>
        <span>Номер или код (серийник, штрих-код) — можно позже</span>
        <input name="externalRef" />
      </label>
      {type === "product" && (
        <label>
          <span>Цена, сум</span>
          <input name="price" inputMode="numeric" placeholder="20000" />
        </label>
      )}
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
