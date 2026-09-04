"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { PartCountSummary } from "../lib/core";
import { applyPartCount, removePartCountLine, reversePartCount } from "../app/parts/actions";

/**
 * Кнопки сессии инвентаризации: «Применить» (с явным пересказом того, что
 * произойдёт) и «Откатить». Применение необратимо в смысле «не удалить, а
 * только обратной сессией» — поэтому подтверждение в два нажатия.
 */
export function PartCountActions({ summary }: { summary: PartCountSummary }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState<"apply" | "reverse" | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const s = summary.session;
  const applied = !!s.appliedAt;
  const isReverse = !!s.reversesId;

  function show(kind: "ok" | "err", text: string) {
    setMsg({ kind, text });
    setConfirm(null);
    if (kind === "ok") router.refresh();
  }

  if (isReverse) return <p className="hint">Обратная сессия — применена при создании, откатывать нечего.</p>;

  return (
    <div className="form-actions" style={{ flexWrap: "wrap", gap: 8 }}>
      {!applied && confirm !== "apply" && (
        <button type="button" className="btn primary" disabled={pending || summary.lines.length === 0} onClick={() => setConfirm("apply")}>
          Применить сессию
        </button>
      )}
      {!applied && confirm === "apply" && (
        <>
          <span className="hint">
            Найденных подтвердить: {summary.found}
            {summary.moved ? ` (из них перевести сюда: ${summary.moved})` : ""} · завести новых: {summary.fresh} · не найденных перевести в
            «неизвестно где»: {summary.missing.length}. Точно?
          </span>
          <button
            type="button"
            className="btn primary"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await applyPartCount(s.id);
                if (!res.ok) return show("err", res.error ?? "Ошибка");
                const r = res.report!;
                show("ok", `Применено: найдено ${r.found}, новых ${r.created.length}, перемещено ${r.moved.length}, не найдено ${r.missing.length}`);
              })
            }
          >
            {pending ? "Применяю…" : "Да, применить"}
          </button>
          <button type="button" className="btn" onClick={() => setConfirm(null)}>
            Отмена
          </button>
        </>
      )}
      {applied && confirm !== "reverse" && (
        <button type="button" className="btn" disabled={pending} onClick={() => setConfirm("reverse")}>
          Откатить обратной сессией
        </button>
      )}
      {applied && confirm === "reverse" && (
        <>
          <span className="hint">Не найденные вернутся на место, перемещённые — туда, где числились. Новые карточки останутся. Точно?</span>
          <button
            type="button"
            className="btn danger-btn"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await reversePartCount(s.id);
                if (!res.ok) return show("err", res.error ?? "Ошибка");
                show("ok", `Откачено: вернулось ${res.restored?.length ?? 0}${res.skipped?.length ? `, пропущено ${res.skipped.length}: ${res.skipped.join("; ")}` : ""}`);
              })
            }
          >
            {pending ? "Откатываю…" : "Да, откатить"}
          </button>
          <button type="button" className="btn" onClick={() => setConfirm(null)}>
            Отмена
          </button>
        </>
      )}
      {msg && <span className={msg.kind === "ok" ? "ok-text" : "err-text"}>{msg.text}</span>}
    </div>
  );
}

/** Убрать строку черновика (до применения). */
export function RemoveLineButton({ sessionId, lineId }: { sessionId: string; lineId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="btn sm ghost"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await removePartCountLine(sessionId, lineId);
            if (!res.ok) setErr(res.error ?? "Ошибка");
            else router.refresh();
          })
        }
      >
        убрать
      </button>
      {err && <span className="err-text">{err}</span>}
    </>
  );
}
