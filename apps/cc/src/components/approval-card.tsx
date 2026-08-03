"use client";

import { useState, useTransition } from "react";
import { decideApproval } from "../app/actions";
import type { Approval } from "../lib/core";
import type { CoffeeImportPart } from "../lib/coffee-import-summary";

/**
 * Карточка согласования с теми же тремя кнопками, что и в Telegram.
 * details — сводка «что внутри» для больших импортов: считается на сервере
 * (payload в браузер не едет), без неё карточка выглядит как раньше.
 */
export function ApprovalCard({ item, details }: { item: Approval; details?: CoffeeImportPart[] | null }) {
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

      {details && details.length > 0 && (
        <div className="rows" style={{ margin: "10px 0" }}>
          {details.map((p) => (
            <div className="row" key={p.label}>
              <div className="t">
                <b>
                  {p.label}: {p.count.toLocaleString("ru-RU")}
                </b>
                <small>
                  {p.from && p.to && (p.from === p.to ? p.from : `${p.from} — ${p.to}`)}
                  {p.notes.length > 0 ? ` · ${p.notes.join(" · ")}` : ""}
                </small>
              </div>
            </div>
          ))}
        </div>
      )}

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
