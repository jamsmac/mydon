"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { cancelCollection, receiveCollection } from "../app/collections/actions";

/**
 * Приём инкассации: пересчитал наличные — ввёл сумму — принял.
 * Отмена — для ошибочных нажатий оператора (след остаётся в журнале).
 */
export function CollectionReceive({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);

  function act(fn: () => Promise<{ ok: boolean; error?: string }>) {
    start(async () => {
      const res = await fn();
      if (res.ok) router.refresh();
      else setError(res.error ?? "Не получилось");
    });
  }

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <input
        className="close-note"
        style={{ width: 130, flex: "none", textAlign: "right" }}
        placeholder="сумма, сум"
        inputMode="numeric"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && amount.trim()) act(() => receiveCollection(id, amount));
        }}
      />
      <button
        type="button"
        className="btn sm ok"
        disabled={pending || amount.trim().length === 0}
        onClick={() => act(() => receiveCollection(id, amount))}
      >
        Принять
      </button>
      <button type="button" className="btn sm ghost" disabled={pending} onClick={() => act(() => cancelCollection(id))}>
        Отмена
      </button>
      {error && <span className="err-text">{error}</span>}
    </div>
  );
}
