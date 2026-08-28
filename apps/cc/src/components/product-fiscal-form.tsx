"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { MARKING, PACKAGE_CODES, VAT_RATES, fiscalFlaws, type ProductFiscal } from "@mydon/shared";
import { saveVendingProductFiscal } from "../app/vending/actions";
import type { VendingProductRow } from "../lib/core";

const FIELD_LABEL: Record<keyof ProductFiscal, string> = {
  ikpu: "ИКПУ",
  mxik: "МХИК",
  vatPct: "Ставка НДС",
  barcode: "Штрихкод",
  packageCode: "Код упаковки",
  marked: "Маркировка",
};

export function ProductFiscalForm({
  domain,
  row,
  onDone,
}: {
  domain: string;
  row: VendingProductRow;
  onDone: (saved?: string | null) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const flaws = fiscalFlaws(row.fiscal);

  return (
    <form
      className="form card"
      style={{ marginTop: 10 }}
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        start(async () => {
          const res = await saveVendingProductFiscal(domain, form);
          if (res.ok) {
            setError(null);
            onDone(res.message ?? null);
            router.refresh();
          } else {
            setError(res.message ?? "Не получилось");
          }
        });
      }}
    >
      <div className="section-title">Фискальные данные — {row.name}</div>
      <input type="hidden" name="productId" value={row.id} />
      <label>
        <span>ИКПУ</span>
        <input name="ikpu" inputMode="numeric" defaultValue={row.fiscal.ikpu ?? ""} />
      </label>
      <label>
        <span>МХИК</span>
        <input name="mxik" inputMode="numeric" defaultValue={row.fiscal.mxik ?? ""} />
      </label>
      <label>
        <span>Штрихкод (EAN)</span>
        <input name="barcode" inputMode="numeric" defaultValue={row.fiscal.barcode ?? ""} />
      </label>
      <label>
        <span>Ставка НДС</span>
        <select name="vatPct" defaultValue={String(row.fiscal.vatPct)}>
          {VAT_RATES.map((rate) => (
            <option key={rate.code} value={rate.code}>{rate.label}</option>
          ))}
        </select>
      </label>
      <label>
        <span>Код упаковки (ОКЕИ)</span>
        <select name="packageCode" defaultValue={row.fiscal.packageCode}>
          {PACKAGE_CODES.map((item) => (
            <option key={item.code} value={item.code}>{item.code} — {item.label}</option>
          ))}
        </select>
      </label>
      <small className="hint">единица измерения, не идентификатор каталога</small>
      <label>
        <span>Маркировка (КИЗ)</span>
        <select name="marked" defaultValue={row.fiscal.marked ? "1" : "0"}>
          {MARKING.map((item) => (
            <option key={item.code} value={item.code}>{item.label}</option>
          ))}
        </select>
      </label>
      {flaws.length > 0 && (
        <div className="hint" aria-label="Дыры фискальных данных">
          {flaws.map((flaw) => (
            <div key={flaw.field}>{FIELD_LABEL[flaw.field]}: {flaw.why}</div>
          ))}
        </div>
      )}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={pending}>
          {pending ? "…" : "Сохранить фискальные данные"}
        </button>
        <button type="button" className="btn" onClick={() => onDone()}>
          Отмена
        </button>
        {error && <span className="err-text">{error}</span>}
      </div>
    </form>
  );
}
