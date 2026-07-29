"use client";

import { useState, useTransition } from "react";
import { decideApproval } from "../app/actions";
import type { Approval } from "../lib/core";

/** Карточка согласования с теми же тремя кнопками, что и в Telegram. */
export function ApprovalCard({ item }: { item: Approval }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  function decide(decision: "approved" | "rejected" | "clarify") {
    startTransition(async () => {
      try {
        setResult(await decideApproval(item.id, decision));
      } catch {
        // Сервер мог перезапускаться в момент нажатия: молчание выглядит как
        // «кнопки не работают». Говорим честно и предлагаем повторить.
        setResult({ ok: false, message: "Сервер не ответил — обнови страницу и нажми ещё раз" });
      }
    });
  }

  return (
    <article className={result ? "card" : "dec"}>
      <div className="dt">{item.action}</div>
      <div className="dby">просит {item.agent} · уровень {item.tier}</div>

      {result ? (
        <div
          className="res"
          style={{ color: result.ok ? "var(--ok)" : "var(--err)", background: "var(--bg)" }}
        >
          {result.ok ? "Решение записано" : result.message}
        </div>
      ) : (
        <div className="acts">
          <button className="btn ok" onClick={() => decide("approved")} disabled={pending}>
            Одобрить
          </button>
          <button className="btn no" onClick={() => decide("rejected")} disabled={pending}>
            Отклонить
          </button>
          <button className="btn ghost" onClick={() => decide("clarify")} disabled={pending}>
            Уточнить
          </button>
        </div>
      )}
    </article>
  );
}
