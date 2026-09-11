"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { AdoptionPlan } from "@mydon/shared";
import { applyCoordAdoption } from "../app/card/actions";

/**
 * «Координаты с автоматов» на экране «Места» (волна 2, М-4). До волны 2
 * координаты вводили у автомата; у части мест своих нет, хотя автомат, что там
 * стоит, их знает. Кнопка переносит их на место с пометкой источника.
 * Конфликты (разные координаты у автоматов одного места, перепутанные
 * широта/долгота) не переносятся — они перечислены для решения человеком.
 */
export function CoordAdoption({ plan }: { plan: AdoptionPlan }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const run = () =>
    start(async () => {
      const res = await applyCoordAdoption();
      if (res.ok) {
        setMsg({ ok: true, text: `Перенесено мест: ${res.applied}` });
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error });
      }
    });

  return (
    <section className="group-block">
      <div className="section-title">Координаты с автоматов</div>
      {plan.adopt.length > 0 && (
        <>
          <p className="hint">
            У {plan.adopt.length} мест своих координат нет, но их знает автомат, который там стоит. Перенос
            ставит их месту с пометкой «перенесено с автомата» — проверьте и поправьте в карточке места.
          </p>
          <ul>
            {plan.adopt.map((a) => (
              <li key={a.placeId}>
                <Link href={`/card/${a.placeId}`}>{a.placeName}</Link> ← {a.fromMachineName} ({a.lat.toFixed(5)},{" "}
                {a.lng.toFixed(5)})
              </li>
            ))}
          </ul>
          <div className="form-actions">
            <button type="button" className="btn pri" onClick={run} disabled={pending}>
              {pending ? "Переношу…" : `Перенести на ${plan.adopt.length} мест`}
            </button>
            {msg && <span className={msg.ok ? "ok-text" : "err-text"}>{msg.text}</span>}
          </div>
        </>
      )}
      {plan.conflicts.length > 0 && (
        <>
          <p className="hint">Не переносится — решить в карточке места:</p>
          <ul>
            {plan.conflicts.map((c) => (
              <li key={c.placeId}>
                <Link href={`/card/${c.placeId}`}>{c.placeName}</Link>: {c.reason}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
