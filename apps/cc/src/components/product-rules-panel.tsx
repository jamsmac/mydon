"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { VendingProductRow } from "../lib/core";
import { saveVendingProductRules } from "../app/vending/actions";

/**
 * Лист «Правила закупа» (П5a): блок, исключение из закупки, фикс-количество
 * при дефиците — по каждому товару вендинга. Цена читается из прайса
 * (`vending_product.purchase_price`), но правится ТОЛЬКО в боте: панель не
 * дублирует команду «цена <товар> <сум>», чтобы не завести два источника.
 */

const n = (v: number): string => v.toLocaleString("ru-RU");

const CATEGORY_LABEL: Record<VendingProductRow["category"], string> = {
  drink: "напиток",
  snack: "снек",
  other: "прочее",
};

function RuleForm({ domain, row, onDone }: { domain: string; row: VendingProductRow; onDone: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="form card"
      style={{ marginTop: 10 }}
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        start(async () => {
          const res = await saveVendingProductRules(domain, form);
          if (res.ok) {
            setError(null);
            onDone();
            router.refresh();
          } else {
            setError(res.message ?? "Не получилось");
          }
        });
      }}
    >
      <input type="hidden" name="product" value={row.name} />
      <label>
        <span>Блок, шт</span>
        <input name="packSize" inputMode="numeric" defaultValue={row.packSize} />
      </label>
      <label>
        <span>Фикс-количество при дефиците (пусто — снять)</span>
        <input name="fixedPurchaseQty" inputMode="numeric" defaultValue={row.fixedPurchaseQty ?? ""} />
      </label>
      <label className="check">
        <input type="checkbox" name="excludedFromPurchase" defaultChecked={row.excludedFromPurchase} />
        <span>Убрать из закупки (грузить только со склада)</span>
      </label>
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={pending}>
          {pending ? "…" : "Сохранить"}
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Отмена
        </button>
        {error && <span className="err-text">{error}</span>}
      </div>
    </form>
  );
}

export function ProductRulesPanel({ domain, products }: { domain: string; products: VendingProductRow[] }) {
  const [editing, setEditing] = useState<string | null>(null);
  const editingRow = editing === null ? null : (products.find((p) => p.id === editing) ?? null);

  return (
    <>
      {products.length === 0 ? (
        <div className="empty">
          <b>Товаров нет</b>
          Прайс вендинга ещё не заведён — правила закупа задавать не на чем.
        </div>
      ) : (
        <div className="rows">
          {products.map((p) => (
            <div className="row" key={p.id}>
              <div className="t">
                <b>{p.name}</b>
                <small>
                  {CATEGORY_LABEL[p.category]} · {p.purchasePrice === null ? "нет цены" : `${n(p.purchasePrice)} сум`} ·
                  блок {n(p.packSize)}
                </small>
              </div>
              {p.excludedFromPurchase && <span className="pill bad">исключён</span>}
              {p.fixedPurchaseQty !== null && <span className="pill">фикс {n(p.fixedPurchaseQty)}</span>}
              <button type="button" className="btn sm" onClick={() => setEditing(p.id)}>
                Править {p.name}
              </button>
            </div>
          ))}
        </div>
      )}
      {editingRow && <RuleForm domain={domain} row={editingRow} onDone={() => setEditing(null)} />}
      <p className="hint" style={{ marginTop: 8 }}>
        Цена — только чтение: правится в боте командой «цена &lt;товар&gt; &lt;сум&gt;».
      </p>
    </>
  );
}
