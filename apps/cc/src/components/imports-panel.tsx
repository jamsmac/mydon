"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { IMPORT_LIFECYCLE_LABELS, type ImportLifecycle } from "@mydon/shared";
import type { FinanceCounterparty, GrImport } from "../lib/core";
import { createImport } from "../app/imports/actions";

/**
 * Импортные контракты GLOBERENT — список и создание (перенос
 * ImportContractsModule PROMACH, односторонний контур без портала завода).
 */

const nfmt = (v: string | number): string => Number(v).toLocaleString("ru-RU");

interface DraftItem {
  name: string;
  qty: string;
  price: string;
}

export function ImportsPanel({
  imports,
  suppliers,
}: {
  imports: GrImport[];
  suppliers: FinanceCounterparty[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<DraftItem[]>([{ name: "", qty: "1", price: "" }]);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const parsed = items
    .filter((i) => i.name.trim() !== "")
    .map((i) => ({
      name: i.name.trim(),
      qty: Math.round(Number(i.qty.replace(/\s/g, ""))) || 0,
      price: Number(i.price.replace(/\s/g, "").replace(",", ".")) || 0,
    }));
  const total = parsed.reduce((s, i) => s + i.qty * i.price, 0);

  const setItem = (idx: number, patch: Partial<DraftItem>) =>
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));

  return (
    <>
      {imports.length === 0 ? (
        <div className="empty">
          <b>Импортных контрактов пока нет</b>
          Заведи контракт с заводом: подписание материализует единицы на склад,
          график оплат станет обязательствами со сроками.
        </div>
      ) : (
        imports.map((c) => {
          const lc = IMPORT_LIFECYCLE_LABELS[c.lifecycleStatus as ImportLifecycle] ?? c.lifecycleStatus;
          const hot = c.status === "in_progress" && c.lifecycleStatus !== "closed";
          return (
            <Link href={`/imports/${c.id}`} className={`trow ${hot ? "hot" : ""}`} key={c.id}>
              <div className="tb">
                <div className="tt">
                  № {c.contractNo} · {c.supplierName ?? "поставщик не указан"}
                </div>
                <div className="tm">
                  {nfmt(c.totalAmount)} {c.currency} · {lc}
                  {c.unitsActive > 0 ? ` · единиц ${c.unitsActive}` : ""}
                  {c.prepaymentAmount !== null
                    ? ` · предоплата ${c.prepaymentPaidAt !== null ? "оплачена" : "ждёт"}`
                    : ""}
                </div>
              </div>
              <span className={`due ${hot ? "hot" : ""}`}>{c.contractDate}</span>
            </Link>
          );
        })
      )}

      {!open ? (
        <button type="button" className="btn" style={{ marginTop: 10 }} onClick={() => setOpen(true)}>
          + Импортный контракт
        </button>
      ) : (
        <form
          className="form card"
          style={{ marginTop: 10 }}
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            form.set("items", JSON.stringify(parsed));
            start(async () => {
              const res = await createImport(form);
              if (res.ok) {
                setOpen(false);
                setItems([{ name: "", qty: "1", price: "" }]);
                setError(null);
                if (res.id !== undefined) router.push(`/imports/${res.id}`);
                else router.refresh();
              } else {
                setError(res.message ?? "Не получилось");
              }
            });
          }}
        >
          <label>
            <span>Номер контракта</span>
            <input name="contractNo" placeholder="HL-2026-001" autoFocus />
          </label>
          <label>
            <span>Дата</span>
            <input name="contractDate" type="date" defaultValue={new Date().toLocaleDateString("en-CA")} />
          </label>
          <label>
            <span>Завод-поставщик (контрагент с ролью «поставщик»)</span>
            <select name="supplierId" defaultValue="">
              <option value="">— не привязывать —</option>
              {suppliers.map((s) => (
                <option value={s.id} key={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Валюта контракта</span>
            <select name="currency" defaultValue="USD">
              <option value="USD">USD</option>
              <option value="CNY">CNY</option>
            </select>
          </label>

          <div>
            <span style={{ fontSize: 12, color: "var(--tx-3)" }}>Спецификация (цена за единицу в валюте контракта)</span>
            {items.map((it, idx) => (
              <div key={idx} style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <input placeholder="HELI CPCD30" value={it.name} onChange={(e) => setItem(idx, { name: e.target.value })} style={{ flex: 3 }} />
                <input placeholder="шт" inputMode="numeric" value={it.qty} onChange={(e) => setItem(idx, { qty: e.target.value })} style={{ flex: 1, minWidth: 52 }} />
                <input placeholder="цена" inputMode="decimal" value={it.price} onChange={(e) => setItem(idx, { price: e.target.value })} style={{ flex: 2 }} />
                {items.length > 1 && (
                  <button type="button" className="btn sm" onClick={() => setItems((prev) => prev.filter((_, i) => i !== idx))}>
                    ✕
                  </button>
                )}
              </div>
            ))}
            <button type="button" className="btn sm" style={{ marginTop: 6 }} onClick={() => setItems((prev) => [...prev, { name: "", qty: "1", price: "" }])}>
              + позиция
            </button>
            {total > 0 && <p className="hint" style={{ marginTop: 6 }}>Итого: {nfmt(total)}</p>}
          </div>

          <label>
            <span>Предоплата заводу (сумма и срок) — станет обязательством</span>
            <span style={{ display: "flex", gap: 8 }}>
              <input name="prepaymentAmount" inputMode="decimal" placeholder="сумма" />
              <input name="prepaymentDueDate" type="date" />
            </span>
          </label>
          <label>
            <span>Балансовый платёж (сумма и срок)</span>
            <span style={{ display: "flex", gap: 8 }}>
              <input name="balanceAmount" inputMode="decimal" placeholder="сумма" />
              <input name="balanceDueDate" type="date" />
            </span>
          </label>

          <div className="form-actions">
            <button type="submit" className="btn primary" disabled={pending || parsed.length === 0}>
              {pending ? "…" : "Создать контракт"}
            </button>
            <button type="button" className="btn" onClick={() => setOpen(false)}>
              Отмена
            </button>
            {error && <span className="err-text">{error}</span>}
          </div>
          <p className="hint">
            После «Подписан» каждая единица спецификации станет строкой склада
            (CONTRACT_SIGNED), а график оплат — обязательствами в финконтуре.
          </p>
        </form>
      )}
    </>
  );
}
