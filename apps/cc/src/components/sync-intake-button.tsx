"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { syncIntake } from "../app/card/actions";

/**
 * Свести приход из mydon-stock в ленту склада по кнопке.
 *
 * Синк идёт и сам (раз в 10 минут), но кнопка нужна для первого раза и после
 * заведения карточек ингредиентов. Итог показываем словами: что завелось, что
 * пропущено и почему.
 */
export function SyncIntakeButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function run() {
    start(async () => {
      const res = await syncIntake();
      if (!res.ok || !res.summary) {
        setMsg({ ok: false, text: res.error ?? "Ошибка" });
        return;
      }
      const s = res.summary;
      if (s.noWarehouse === "нет") {
        setMsg({ ok: false, text: "Нет склада — заведи карточку с типом «склад»." });
        return;
      }
      if (s.noWarehouse === "неоднозначно") {
        setMsg({
          ok: false,
          text: "Складов несколько — пометь один полем «приём по умолчанию».",
        });
        return;
      }
      const parts = [`завёл ${s.created}`];
      if (s.alreadySynced > 0) parts.push(`уже было ${s.alreadySynced}`);
      if (s.noCard > 0) parts.push(`без карточки ${s.noCard}`);
      if (s.badUnit > 0) parts.push(`единица не сводится ${s.badUnit}`);
      setMsg({ ok: true, text: `Склад «${s.warehouse}»: ${parts.join(", ")}.` });
      router.refresh();
    });
  }

  return (
    <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
      <button type="button" className="btn pri" onClick={run} disabled={pending}>
        {pending ? "Свожу…" : "Свести приход в склад"}
      </button>
      {msg && <span className={msg.ok ? "ok-text" : "err-text"}>{msg.text}</span>}
    </div>
  );
}
