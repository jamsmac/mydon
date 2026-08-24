"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { submitVendingPurchase } from "../app/vending/actions";

/**
 * «Оформить закуп» — заявка на утверждение по текущему плану (П5a).
 *
 * Форма без полей: вся входная информация — сам план, который Core считает
 * заново на отправке. Отказ показывается на месте, рядом с кнопкой: закуп —
 * решение владельца, и «ничего не произошло» здесь недопустимо.
 */
export function SubmitPurchaseButton({ domain }: { domain: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  return (
    <form
      className="form-actions"
      style={{ marginTop: 12 }}
      onSubmit={(event) => {
        event.preventDefault();
        start(async () => {
          const res = await submitVendingPurchase(domain);
          if (res.ok) {
            setError(null);
            setDone(res.message ?? "Отправлено");
            router.refresh();
          } else {
            setDone(null);
            setError(res.message ?? "Не получилось");
          }
        });
      }}
    >
      <button type="submit" className="btn primary" disabled={pending}>
        {pending ? "…" : "Оформить закуп"}
      </button>
      {error && <span className="err-text">{error}</span>}
      {done && <span className="muted">{done}</span>}
    </form>
  );
}
