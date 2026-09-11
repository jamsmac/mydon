"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setPlaceContractor } from "../app/card/actions";

export interface OwnerOption {
  id: string;
  name: string;
  type: "contractor" | "own_company";
  approved: boolean;
}

/**
 * «Чьё место» (волна 2б, М-1, М-2, М-11): контрагент, у которого стоит
 * место, или наша компания — для складов и мастерской. Пусто — «не знаем, чьё
 * помещение», и это видно словами, а не пустой строкой: дыра в данных и
 * осознанный выбор не должны выглядеть одинаково.
 */
export function PlaceOwnership({
  placeId,
  placeName,
  current,
  options,
}: {
  placeId: string;
  placeName: string;
  current: { id: string; name: string } | null;
  options: OwnerOption[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [value, setValue] = useState(current?.id ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = () =>
    start(async () => {
      setMsg(null);
      const res = await setPlaceContractor(placeId, value === "" ? null : value);
      if (res.ok) {
        setMsg({ ok: true, text: "Сохранено" });
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error ?? "Не получилось" });
      }
    });

  const ours = options.filter((o) => o.type === "own_company");
  const theirs = options.filter((o) => o.type === "contractor");

  return (
    <div className="form">
      <p>
        {current ? (
          <>
            Полное имя: <b>{current.name} · {placeName}</b> — <Link href={`/card/${current.id}`}>карточка владельца</Link>
          </>
        ) : (
          <span className="hint">Чьё помещение — не записано. Пусто значит «не знаем», а не «наше».</span>
        )}
      </p>
      <label>
        Владелец места
        <select value={value} onChange={(e) => setValue(e.target.value)} disabled={pending}>
          <option value="">— не знаем, чьё помещение —</option>
          {ours.length > 0 && (
            <optgroup label="Наша компания (склады, мастерская)">
              {ours.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </optgroup>
          )}
          {theirs.length > 0 && (
            <optgroup label="Контрагенты">
              {theirs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                  {o.approved ? "" : " (ждёт утверждения)"}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      <div className="form-actions">
        <button type="button" className="btn pri" onClick={save} disabled={pending || value === (current?.id ?? "")}>
          {pending ? "Сохраняю…" : "Сохранить"}
        </button>
        {msg && <span className={msg.ok ? "ok-text" : "err-text"}>{msg.text}</span>}
      </div>
    </div>
  );
}
