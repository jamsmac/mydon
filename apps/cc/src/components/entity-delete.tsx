"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteEntity } from "../app/card/actions";

/** Удаление записи: с подтверждением, след остаётся в журнале. */
export function DeleteEntityButton({
  id,
  domain,
  type,
  name,
}: {
  id: string;
  domain: string | null;
  type: string;
  name: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onDelete() {
    // Подтверждение обязательно: удаление руками — не то действие,
    // которое можно совершить случайным касанием с телефона.
    if (!window.confirm(`Удалить «${name}»? Содержимое останется в журнале.`)) return;
    start(async () => {
      const res = await deleteEntity(id, domain);
      if (res.ok) {
        router.push(domain ? `/domain/${domain}?tab=catalog:${type}` : "/registry");
        router.refresh();
      } else {
        setError(res.error ?? "Не удалось удалить");
      }
    });
  }

  return (
    <div style={{ marginTop: 14 }}>
      <button type="button" className="btn" onClick={onDelete} disabled={pending}
        style={{ color: "var(--red)", borderColor: "var(--red)" }}>
        {pending ? "Удаляю…" : "Удалить запись"}
      </button>
      {error && <span className="err-text" style={{ marginLeft: 10 }}>{error}</span>}
    </div>
  );
}
