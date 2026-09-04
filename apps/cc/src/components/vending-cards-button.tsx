"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ensureVendingCards } from "../app/stock/actions";

type Report = { linked: string[]; created: string[]; ambiguous: string[]; already: number };

/** Связать/завести карточки реестра для товаров прайса — сначала план, потом запись. */
export function VendingCardsButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [plan, setPlan] = useState<Report | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const text = (r: Report) =>
    `связать по имени: ${r.linked.length}, завести новых: ${r.created.length}, уже связано: ${r.already}` +
    (r.ambiguous.length ? `, двусмысленных (две карточки одного имени): ${r.ambiguous.join(", ")}` : "");
  return (
    <div className="form-actions" style={{ flexWrap: "wrap", gap: 8 }}>
      {!plan ? (
        <button
          type="button"
          className="btn"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const res = await ensureVendingCards(true);
              if (!res.ok || !res.report) return setMsg({ kind: "err", text: res.error ?? "Ошибка" });
              setPlan(res.report);
              setMsg(null);
            })
          }
        >
          {pending ? "Смотрю прайс…" : "Карточки для товаров: план"}
        </button>
      ) : (
        <>
          <span className="hint">План: {text(plan)}.</span>
          <button
            type="button"
            className="btn primary"
            disabled={pending || (plan.linked.length === 0 && plan.created.length === 0)}
            onClick={() =>
              start(async () => {
                const res = await ensureVendingCards(false);
                if (!res.ok || !res.report) return setMsg({ kind: "err", text: res.error ?? "Ошибка" });
                setMsg({ kind: "ok", text: `Готово: ${text(res.report)}` });
                setPlan(null);
                router.refresh();
              })
            }
          >
            {pending ? "Завожу…" : "Связать и завести"}
          </button>
          <button type="button" className="btn" onClick={() => setPlan(null)}>
            Отмена
          </button>
        </>
      )}
      {msg && <span className={msg.kind === "ok" ? "ok-text" : "err-text"}>{msg.text}</span>}
    </div>
  );
}
