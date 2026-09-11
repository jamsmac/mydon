"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { applyMachineNumberPlan, setMachineNumber } from "../app/card/actions";

/**
 * «Номера автоматов» над списком парка (волна 3, М-12). Номер в системе
 * ставится сразу всем, наклейка догоняет — как у узлов, где номера стоят, а
 * очередь «наклеить» идёт своим ходом. Здесь и присвоение по плану (порядок —
 * по дате заведения, при совпадении — по серийнику), и очередь наклейки.
 */
export function MachineNumbersBlock({
  plan,
  toLabel,
}: {
  plan: { id: string; name: string; inventoryNo: string }[];
  toLabel: { id: string; displayName: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const assign = () =>
    start(async () => {
      setMsg(null);
      const res = await applyMachineNumberPlan();
      if (res.ok) {
        setMsg({ ok: true, text: `Присвоено номеров: ${res.assigned}` });
        router.refresh();
      } else setMsg({ ok: false, text: res.error });
    });

  const confirm = (id: string) =>
    start(async () => {
      setMsg(null);
      const res = await setMachineNumber(id, { confirmLabel: true });
      if (res.ok) router.refresh();
      else setMsg({ ok: false, text: res.error ?? "Не получилось" });
    });

  if (plan.length === 0 && toLabel.length === 0) return null;

  return (
    <section className="group-block">
      <div className="section-title">Номера автоматов</div>
      {plan.length > 0 && (
        <>
          <p className="hint">
            {plan.length} автоматам номер ещё не присвоен. Порядок — по дате заведения карточки, при совпадении —
            по серийнику; имя карточки не меняется, номер ставится впереди: «K-014 · место».
          </p>
          <p className="mono" style={{ fontSize: 12 }}>
            {plan
              .slice(0, 8)
              .map((p) => `${p.inventoryNo} ← ${p.name}`)
              .join(" · ")}
            {plan.length > 8 ? ` · и ещё ${plan.length - 8}` : ""}
          </p>
          <div className="form-actions">
            <button type="button" className="btn pri" onClick={assign} disabled={pending}>
              {pending ? "Присваиваю…" : `Присвоить номера ${plan.length} автоматам`}
            </button>
          </div>
        </>
      )}
      {toLabel.length > 0 && (
        <>
          <p className="hint">Наклеить номер ({toLabel.length}): номер в системе есть, на автомате — ещё нет.</p>
          <ul>
            {toLabel.map((m) => (
              <li key={m.id}>
                <Link href={`/card/${m.id}`}>{m.displayName}</Link>
                {m.displayName !== m.name && <span className="hint"> · карточка «{m.name}»</span>}{" "}
                <button type="button" className="btn ghost" onClick={() => confirm(m.id)} disabled={pending}>
                  наклеен
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {msg && <p className={msg.ok ? "ok-text" : "err-text"}>{msg.text}</p>}
    </section>
  );
}
