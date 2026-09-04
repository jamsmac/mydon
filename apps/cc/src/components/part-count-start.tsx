"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { startPartCount } from "../app/parts/actions";

const PLACES: { value: string; label: string }[] = [
  { value: "warehouse", label: "Склад" },
  { value: "washing", label: "Мойка" },
  { value: "drying", label: "Сушка" },
  { value: "repair", label: "Ремонт" },
];

/** Открыть сессию с панели: считать можно и без бота — строки добавит бот или следующая версия панели. */
export function StartCountForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [location, setLocation] = useState("warehouse");
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="form-actions">
      <select value={location} onChange={(e) => setLocation(e.target.value)} disabled={pending}>
        {PLACES.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await startPartCount(location);
            if (!res.ok || !res.id) return setErr(res.error ?? "Ошибка");
            router.push(`/parts/count/${res.id}`);
          })
        }
      >
        {pending ? "Открываю…" : "Открыть сессию"}
      </button>
      <span className="hint">Если по этому месту сессия уже идёт — откроется она, а не вторая.</span>
      {err && <span className="err-text">{err}</span>}
    </div>
  );
}
