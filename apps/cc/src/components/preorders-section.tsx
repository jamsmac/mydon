"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  PREORDER_ACTIONS,
  PREORDER_STATUS_LABELS,
  type PreorderStatus,
} from "@mydon/shared";
import type { FinanceCounterparty, GrPreorder } from "../lib/core";
import { cancelPreorder, createPreorder, preorderAction } from "../app/preorders/actions";

/**
 * Предзаказы (перенос pre_orders PROMACH): очередь «что заказать заводу»
 * до появления импортного контракта. Кнопки — из матрицы ALLOWED_TRANSITIONS.
 */

function actionsFor(status: string): { action: string; label: string }[] {
  return Object.entries(PREORDER_ACTIONS)
    .filter(([, t]) => (t.from as readonly string[]).includes(status))
    .map(([action, t]) => ({ action, label: t.label }));
}

export function PreordersSection({
  preorders,
  clients,
}: {
  preorders: GrPreorder[];
  clients: FinanceCounterparty[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [askOrder, setAskOrder] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<{ ok: boolean; message?: string }>) =>
    start(async () => {
      const res = await fn();
      setError(res.ok ? null : (res.message ?? "Не получилось"));
      if (res.ok) {
        setAskOrder(null);
        setOpen(false);
        router.refresh();
      }
    });

  const active = preorders.filter((p) => p.status !== "closed" && p.status !== "cancelled");
  const terminal = preorders.length - active.length;

  return (
    <div className="sect" style={{ marginTop: 0 }}>
      <div className="sect-h">
        <h3 className="h2">Предзаказы</h3>
        {active.length > 0 && <span className="chip">{active.length}</span>}
        {terminal > 0 && <span className="chip">закрытых · {terminal}</span>}
      </div>
      {active.map((p) => (
        <div className="trow" key={p.id} style={{ flexWrap: "wrap" }}>
          <div className="tb">
            <div className="tt">{p.code} · {p.name} ×{p.qty}</div>
            <div className="tm">
              {PREORDER_STATUS_LABELS[p.status as PreorderStatus] ?? p.status}
              {p.clientName !== null ? ` · под ${p.clientName}` : " · на склад"}
              {p.contractRef !== null ? ` · контракт ${p.contractRef}` : ""}
              {p.promisedDeliveryDate !== null ? ` · обещано ${p.promisedDeliveryDate}` : ""}
            </div>
          </div>
          <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
            {actionsFor(p.status).map(({ action, label }) => (
              <button
                key={action}
                type="button"
                className="btn sm"
                disabled={pending}
                onClick={() => {
                  if (action === "order") setAskOrder(askOrder === p.id ? null : p.id);
                  else run(() => preorderAction(p.id, action));
                }}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              className="btn sm"
              disabled={pending}
              onClick={() => {
                const reason = window.prompt("Причина отмены (обязательна):");
                if (reason !== null && reason.trim() !== "") run(() => cancelPreorder(p.id, reason.trim()));
              }}
            >
              ✕
            </button>
          </span>
          {askOrder === p.id && (
            <form
              className="form"
              style={{ width: "100%", display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", marginTop: 8 }}
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                const extra: Record<string, string> = {
                  contractRef: String(form.get("contractRef") ?? "").trim(),
                };
                const d = String(form.get("promisedDeliveryDate") ?? "").trim();
                if (d !== "") extra["promisedDeliveryDate"] = d;
                run(() => preorderAction(p.id, "order", extra));
              }}
            >
              <label style={{ margin: 0 }}>
                <span>Контракт завода (обязателен)</span>
                <input name="contractRef" autoFocus />
              </label>
              <label style={{ margin: 0 }}>
                <span>Обещанная поставка</span>
                <input name="promisedDeliveryDate" type="date" />
              </label>
              <button type="submit" className="btn sm" disabled={pending}>Заказан</button>
            </form>
          )}
        </div>
      ))}
      {error !== null && <p className="err-text">{error}</p>}

      {!open ? (
        <button type="button" className="btn sm" style={{ marginTop: 8 }} onClick={() => setOpen(true)}>
          + Предзаказ
        </button>
      ) : (
        <form
          className="form card"
          style={{ marginTop: 8 }}
          onSubmit={(event) => {
            event.preventDefault();
            run(() => createPreorder(new FormData(event.currentTarget)));
          }}
        >
          <label>
            <span>Что заказываем</span>
            <input name="name" placeholder="HELI CPD25 (электро)" autoFocus />
          </label>
          <label>
            <span>Количество</span>
            <input name="qty" inputMode="numeric" defaultValue="1" />
          </label>
          <label>
            <span>Под клиента (пусто — на склад)</span>
            <select name="clientId" defaultValue="">
              <option value="">— на склад —</option>
              {clients.map((c) => (
                <option value={c.id} key={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" name="submitImmediately" defaultChecked />
            <span>сразу запросить (минуя черновик)</span>
          </label>
          <div className="form-actions">
            <button type="submit" className="btn primary" disabled={pending}>
              {pending ? "…" : "Создать"}
            </button>
            <button type="button" className="btn" onClick={() => setOpen(false)}>
              Отмена
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
