"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { clearAgent, declareAgent } from "../app/actor/actions";

/**
 * Объявление агента в этом браузере (R-H-9). Объявлен — одна кнопка «вернуть
 * себе»; не объявлен — поле имени с подсказкой. Поле неуправляемое: при
 * ошибке введённое остаётся на месте.
 */
export function ActorDeclare({ declared }: { declared: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(action: () => Promise<{ ok: boolean; message?: string }>) {
    start(async () => {
      try {
        const res = await action();
        if (res.ok) {
          setError(null);
          router.refresh();
        } else {
          setError(res.message ?? "Не удалось");
        }
      } catch {
        setError("Сервер не ответил — обнови страницу и попробуй ещё раз");
      }
    });
  }

  if (declared !== null) {
    return (
      <div className="form-actions">
        <button type="button" className="btn primary" disabled={pending} onClick={() => run(clearAgent)}>
          {pending ? "…" : "Вернуть авторство себе"}
        </button>
        {error && <span className="err-text">{error}</span>}
      </div>
    );
  }

  return (
    <form
      className="form card"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        run(() => declareAgent(form));
      }}
    >
      <label>
        <span>Имя агента</span>
        <input name="agent" defaultValue="claude-code" autoComplete="off" spellCheck={false} />
        <small className="hint">
          Латиница, цифры и дефис. Объявление живёт 8 часов в этом браузере — забытое не подпишет
          завтрашние решения владельца агентом.
        </small>
      </label>
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={pending}>
          {pending ? "…" : "Объявить агента"}
        </button>
        {error && <span className="err-text">{error}</span>}
      </div>
    </form>
  );
}
