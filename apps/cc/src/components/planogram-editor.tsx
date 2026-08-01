"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { PlanogramEntry } from "@mydon/shared";
import { savePlanogram } from "../app/card/actions";

/** Товар, который можно поставить в слот. */
export interface ProductOption {
  id: string;
  name: string;
  /** Карточка утверждена владельцем. false — заведена не им, ждёт слова. */
  approved: boolean;
}

interface Line {
  slot: string;
  productId: string;
}

/**
 * Планограмма автомата: какой товар в каком слоте.
 *
 * Слот — метка ячейки, как её пишет владелец («A1», «12»): сетку не навязываем,
 * порядок и формат — за автоматом. Правка уходит отдельным сохранением и не
 * трогает прочие поля карточки. Пустой слот или без товара не сохраняется;
 * повторный слот отбрасывается — в ячейке один товар.
 */
export function PlanogramEditor({
  entity,
  products,
  planogram,
}: {
  entity: { id: string };
  products: ProductOption[];
  planogram: PlanogramEntry[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [lines, setLines] = useState<Line[]>(
    planogram.map((e) => ({ slot: e.slot, productId: e.productId })),
  );

  const nameOf = new Map(products.map((p) => [p.id, p.name]));

  const set = (i: number, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const add = () => setLines((prev) => [...prev, { slot: "", productId: "" }]);
  const remove = (i: number) => setLines((prev) => prev.filter((_, j) => j !== i));

  const save = () => {
    setMsg(null);
    start(async () => {
      const res = await savePlanogram(entity.id, lines);
      if (res.ok) {
        setMsg({ ok: true, text: "Раскладка сохранена" });
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error ?? "Не получилось" });
      }
    });
  };

  const filled = lines.filter((l) => l.slot.trim() && l.productId);

  return (
    <div className="sect" id="planogram" data-toc="Раскладка">
      <div className="sect-h">
        <h3 className="h2">Раскладка</h3>
        <span className="chip">
          {filled.length} {filled.length === 1 ? "слот" : "слотов"}
        </span>
      </div>

      {products.length === 0 ? (
        <p className="hint">
          Товаров этого направления пока нет — сначала заведи их, потом расставишь по слотам.
        </p>
      ) : (
        <>
          {/* Компактная карта занятых слотов — что где стоит, с одного взгляда. */}
          {filled.length > 0 && (
            <div className="planogrid" style={{ marginBottom: 12 }}>
              {filled.map((l) => (
                <span className="pslot" key={l.slot}>
                  <span className="pslot-k">{l.slot}</span>
                  <span className="pslot-n">{nameOf.get(l.productId) ?? "?"}</span>
                </span>
              ))}
            </div>
          )}

          <div className="form">
            {lines.map((l, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                <label style={{ flex: "0 0 92px" }}>
                  <span>Слот</span>
                  <input
                    value={l.slot}
                    placeholder="A1"
                    onChange={(e) => set(i, { slot: e.target.value })}
                  />
                </label>
                <label style={{ flex: 1, minWidth: 0 }}>
                  <span>Товар</span>
                  <select value={l.productId} onChange={(e) => set(i, { productId: e.target.value })}>
                    <option value="">— выбери —</option>
                    {/* Удалённый из справочника товар всё равно показываем, чтобы
                        строку не подменило молча. */}
                    {l.productId && !nameOf.has(l.productId) && (
                      <option value={l.productId}>товар удалён</option>
                    )}
                    {products.map((p) => (
                      <option value={p.id} key={p.id}>
                        {p.name}
                        {p.approved ? "" : " (ждёт утверждения)"}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => remove(i)}
                  disabled={pending}
                  aria-label="Убрать слот"
                >
                  ✕
                </button>
              </div>
            ))}

            <div className="form-actions">
              <button type="button" className="btn ghost" onClick={add} disabled={pending}>
                + слот
              </button>
              <button type="button" className="btn" onClick={save} disabled={pending}>
                Сохранить раскладку
              </button>
              {msg && <span className={msg.ok ? "ok-text" : "err-text"}>{msg.text}</span>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
