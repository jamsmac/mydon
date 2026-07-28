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
      setResult(await decideApproval(item.id, decision));
    });
  }

  return (
    <article className="card attention">
      <div className="who">
        {item.agent} · уровень {item.tier}
      </div>
      <div className="what">{item.action}</div>

      {result ? (
        <p style={{ marginTop: 12, marginBottom: 0, fontSize: 14 }}>
          <span className={`pill ${result.ok ? "ok" : "bad"}`}>{result.ok ? "готово" : "не принято"}</span>{" "}
          <span style={{ color: "var(--steel)" }}>{result.message}</span>
        </p>
      ) : (
        <div className="btns">
          <button className="btn yes" onClick={() => decide("approved")} disabled={pending}>
            ✅ Одобрить
          </button>
          <button className="btn no" onClick={() => decide("rejected")} disabled={pending}>
            ❌ Отклонить
          </button>
          <button className="btn" onClick={() => decide("clarify")} disabled={pending}>
            ❓ Уточнить
          </button>
        </div>
      )}
    </article>
  );
}
