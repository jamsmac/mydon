"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  bulkImportAction,
  cancelImport,
  markImportPaid,
  signImport,
} from "../app/imports/actions";

/** Кнопки карточки импортного контракта: подписание, оплаты графика, массовые ГТД. */
export function ImportContractActions({
  id,
  status,
  prepaymentPaid,
  balancePaid,
  hasPrepayment,
  hasBalance,
}: {
  id: string;
  status: string;
  prepaymentPaid: boolean;
  balancePaid: boolean;
  hasPrepayment: boolean;
  hasBalance: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [ask, setAsk] = useState<string | null>(null);

  const run = (fn: () => Promise<{ ok: boolean; message?: string; moved?: number; skipped?: number }>) =>
    start(async () => {
      const res = await fn();
      if (res.ok) {
        setMsg(
          res.moved !== undefined
            ? `Продвинуто единиц: ${res.moved}${(res.skipped ?? 0) > 0 ? `, пропущено (уже дальше): ${res.skipped}` : ""}`
            : null,
        );
        setAsk(null);
        router.refresh();
      } else {
        setMsg(res.message ?? "Не получилось");
      }
    });

  const BULK: { action: string; label: string; needsGtd?: boolean; needsCarrier?: boolean }[] = [
    { action: "mark-ready-to-ship", label: "готовы к отгрузке" },
    { action: "mark-in-transit", label: "в пути", needsCarrier: true },
    { action: "mark-at-border", label: "на границе" },
    { action: "mark-customs-im74", label: "ГТД ИМ-74", needsGtd: true },
    { action: "mark-customs-im40", label: "ГТД ИМ-40", needsGtd: true },
    { action: "mark-delivered", label: "на склад" },
  ];

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {status === "draft" && (
          <button type="button" className="btn primary sm" disabled={pending} onClick={() => run(() => signImport(id))}>
            Подписан (материализовать единицы)
          </button>
        )}
        {status === "in_progress" && hasPrepayment && !prepaymentPaid && (
          <button type="button" className="btn sm" disabled={pending} onClick={() => run(() => markImportPaid(id, "prepayment"))}>
            предоплата оплачена
          </button>
        )}
        {status === "in_progress" && hasBalance && !balancePaid && (
          <button type="button" className="btn sm" disabled={pending} onClick={() => run(() => markImportPaid(id, "balance"))}>
            баланс оплачен
          </button>
        )}
        {status === "in_progress" &&
          BULK.map((b) => (
            <button
              key={b.action}
              type="button"
              className="btn sm"
              disabled={pending}
              onClick={() => {
                if (b.needsGtd === true || b.needsCarrier === true) setAsk(ask === b.action ? null : b.action);
                else run(() => bulkImportAction(id, b.action));
              }}
            >
              все: {b.label}
            </button>
          ))}
        {status !== "cancelled" && (
          <button
            type="button"
            className="btn sm"
            disabled={pending}
            onClick={() => {
              if (window.confirm("Отменить контракт? Возможно только без активных единиц.")) {
                run(() => cancelImport(id));
              }
            }}
          >
            отменить
          </button>
        )}
      </div>

      {ask !== null && (
        <form
          className="form"
          style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", marginTop: 8 }}
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const extra: Record<string, string> = {};
            for (const key of ["transportCompany", "declarationNumber", "declarationDate"]) {
              const v = String(form.get(key) ?? "").trim();
              if (v !== "") extra[key] = v;
            }
            run(() => bulkImportAction(id, ask, extra));
          }}
        >
          {ask === "mark-in-transit" ? (
            <label style={{ margin: 0 }}>
              <span>Перевозчик</span>
              <input name="transportCompany" autoFocus />
            </label>
          ) : (
            <>
              <label style={{ margin: 0 }}>
                <span>Номер ГТД</span>
                <input name="declarationNumber" autoFocus />
              </label>
              <label style={{ margin: 0 }}>
                <span>Дата ГТД</span>
                <input name="declarationDate" type="date" />
              </label>
            </>
          )}
          <button type="submit" className="btn sm" disabled={pending}>Применить ко всем</button>
        </form>
      )}
      {msg !== null && <p className="hint" style={{ marginTop: 8 }}>{msg}</p>}
    </div>
  );
}
