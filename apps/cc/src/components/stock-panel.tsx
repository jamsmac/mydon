"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { UNITS } from "@mydon/shared";
import { addIntake, removeMovement } from "../app/card/actions";
import type { IngredientStock } from "../lib/core";

/** Склад, куда можно завести приход. */
export interface WarehouseOption {
  id: string;
  name: string;
}

const KIND_LABEL: Record<string, string> = {
  intake: "приход",
  consumption: "расход",
  transfer: "перемещение",
};

const num = (n: number) => n.toLocaleString("ru-RU", { maximumFractionDigits: 3 });
const sum = (n: number) => `${Math.round(n).toLocaleString("ru-RU")} сум`;

/**
 * Склад ингредиента: остаток по складам и приход.
 *
 * Остаток считает Core на чтении из ленты движений (`stock`) — здесь мы его
 * показываем и заводим приход. Один приход — одна строка: склад, количество,
 * цена, дата, поставщик.
 */
export function StockPanel({
  ingredientId,
  baseUnitHint,
  stock,
  warehouses,
}: {
  ingredientId: string;
  /** Базовая единица ингредиента (из его цены покупки) — единица прихода по умолчанию. */
  baseUnitHint: string | null;
  stock: IngredientStock;
  warehouses: WarehouseOption[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [wh, setWh] = useState("");
  const [qty, setQty] = useState("");
  const [unit, setUnit] = useState(baseUnitHint ?? "");
  const [price, setPrice] = useState("");
  const [dt, setDt] = useState("");
  const [supplier, setSupplier] = useState("");

  const noWarehouses = warehouses.length === 0;

  function submit() {
    start(async () => {
      const res = await addIntake(ingredientId, {
        warehouseId: wh,
        qty: Number(qty),
        unit,
        unitPrice: price.trim() ? Number(price) : undefined,
        dt: dt.trim() || undefined,
        supplier: supplier.trim() || undefined,
      });
      setMsg(res.ok ? { ok: true, text: "Приход заведён" } : { ok: false, text: res.error ?? "Ошибка" });
      if (res.ok) {
        setOpen(false);
        setQty("");
        setPrice("");
        setSupplier("");
        router.refresh();
      }
    });
  }

  function onDelete(id: string) {
    start(async () => {
      const res = await removeMovement(id, ingredientId);
      setMsg(res.ok ? { ok: true, text: "Удалено" } : { ok: false, text: res.error ?? "Ошибка" });
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="sect">
      <div className="sect-h">
        <h3 className="h2">Склад</h3>
        {stock.baseUnit === null ? (
          <span className="chip b">нет единицы</span>
        ) : stock.total === null ? (
          <span className="chip">остаток не посчитан</span>
        ) : (
          <span className="chip">
            остаток: {num(stock.total)} {stock.baseUnit}
            {stock.unconvertible > 0 ? " (неполно)" : ""}
          </span>
        )}
      </div>

      {stock.baseUnit === null && (
        <p className="hint" style={{ marginBottom: 10 }}>
          У ингредиента не задана единица цены покупки — без неё остаток не свести к одной
          мере. Заполни «Единица цены» в блоке «Ингредиент» ниже.
        </p>
      )}

      {/* Остаток по складам — считается на чтении. */}
      {stock.warehouses.length > 0 && (
        <div className="pass" style={{ marginBottom: 12 }}>
          {stock.warehouses.map((w) => (
            <div className="f" key={w.warehouseId}>
              <div className="k">{w.warehouseName}</div>
              <div className="val">
                {num(w.qty)} {stock.baseUnit ?? ""}
                {w.unconvertible > 0 ? ` · не посчитано движений: ${w.unconvertible}` : ""}
              </div>
            </div>
          ))}
        </div>
      )}

      {noWarehouses ? (
        <p className="hint">
          Складов пока нет. Заведи карточку с типом «склад» — на него и заводится приход.
        </p>
      ) : open ? (
        <div className="form card" style={{ margin: 0 }}>
          <label>
            <span>Склад</span>
            <select value={wh} onChange={(e) => setWh(e.target.value)}>
              <option value="">— выбери —</option>
              {warehouses.map((w) => (
                <option value={w.id} key={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <label style={{ flex: 1 }}>
              <span>Количество</span>
              <input value={qty} inputMode="decimal" onChange={(e) => setQty(e.target.value)} placeholder="10" />
            </label>
            <label style={{ flex: 1 }}>
              <span>Единица</span>
              <select value={unit} onChange={(e) => setUnit(e.target.value)}>
                <option value="">—</option>
                {UNITS.map((u) => (
                  <option value={u} key={u}>
                    {u}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <label style={{ flex: 1 }}>
              <span>Цена за единицу</span>
              <input value={price} inputMode="numeric" onChange={(e) => setPrice(e.target.value)} placeholder="80000" />
            </label>
            <label style={{ flex: 1 }}>
              <span>Дата</span>
              <input value={dt} type="date" onChange={(e) => setDt(e.target.value)} />
            </label>
          </div>
          <label>
            <span>Поставщик</span>
            <input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="необязательно" />
          </label>
          <div className="form-actions">
            <button type="button" className="btn primary" onClick={submit} disabled={pending}>
              {pending ? "Завожу…" : "Завести приход"}
            </button>
            <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
              Отмена
            </button>
            {msg && <span className={msg.ok ? "ok-text" : "err-text"}>{msg.text}</span>}
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 9, flexWrap: "wrap", alignItems: "center" }}>
          <button type="button" className="btn pri" onClick={() => setOpen(true)}>
            + Приход
          </button>
          {msg && <span className={msg.ok ? "ok-text" : "err-text"}>{msg.text}</span>}
        </div>
      )}

      {/* Лента движений: приходы (и позже расход). */}
      {stock.movements.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="result-title">Движения</div>
          <div className="pass">
            {stock.movements.map((m) => (
              <div className="f" key={m.id}>
                <div className="k">
                  {m.dt} · {KIND_LABEL[m.kind] ?? m.kind}
                </div>
                <div className="val" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span>
                    {num(m.qty)} {m.unit}
                    {m.warehouseName ? ` → ${m.warehouseName}` : ""}
                    {m.unitPrice != null ? ` · ${sum(m.unitPrice)}/${m.unit}` : ""}
                    {m.total != null ? ` · ${sum(m.total)}` : ""}
                    {m.supplier ? ` · ${m.supplier}` : ""}
                  </span>
                  {m.source === "owner" && (
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={() => onDelete(m.id)}
                      disabled={pending}
                      aria-label="Удалить движение"
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="hint" style={{ marginTop: 8 }}>
        Остаток считается из движений: приход прибавляет, расход по продажам будет убавлять.
        Количество приводится к единице цены покупки — завёл 2&nbsp;кг, рецепт спишет граммы.
      </p>
    </div>
  );
}
