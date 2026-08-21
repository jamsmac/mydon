"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { UNITS } from "@mydon/shared";
import { addIntake, addIntakeBatch, removeMovement } from "../app/card/actions";
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
 * Число из ввода: «1,5», «10 600», «12» — запятая и пробелы разряда (обычный,
 * неразрывный, узкий) читаются как один и тот же разделитель. Пусто/мусор →
 * null — количество НЕЛЬЗЯ округлять до целого через parseInt.
 */
function parseNum(raw: string): number | null {
  const t = raw.trim().replace(/[\s\u00A0\u202F]/g, "").replace(",", ".");
  if (t.length === 0) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

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

  // Партия (§4.3 + документ Р3/Р4) — свёрнута по умолчанию, чтобы не утяжелять
  // быстрый приход. Все поля необязательны: приход без партии остаётся
  // возможен, если блок не раскрывать (submit тогда идёт через addIntake).
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchCode, setBatchCode] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [manufactureDate, setManufactureDate] = useState("");
  const [invoiceNo, setInvoiceNo] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [unitPriceNet, setUnitPriceNet] = useState("");
  const [vatRate, setVatRate] = useState("");
  // Ключ идемпотентности этой заполненной формы: один на попытку записи, новый
  // после успеха. Двойной клик, обогнавший блокировку кнопки, иначе завёл бы
  // две партии — остаток вырос бы вдвое.
  const [batchKey, setBatchKey] = useState(() => crypto.randomUUID());

  const noWarehouses = warehouses.length === 0;

  // Цена с НДС на глазах — та же формула, что применит Core
  // (unitPriceNet × (1 + ставка/100)); показываем, а не сохраняем молча,
  // чтобы владелец сверил с карточкой, где цена уже с НДС.
  const netNum = parseNum(unitPriceNet);
  const vatNum = parseNum(vatRate);
  const grossPreview = netNum !== null && vatNum !== null ? netNum * (1 + vatNum / 100) : null;

  function submit() {
    start(async () => {
      const qtyNum = parseNum(qty) ?? NaN;
      const res = batchOpen
        ? await addIntakeBatch(ingredientId, {
            warehouseId: wh,
            qty: qtyNum,
            unit,
            dt: dt.trim() || undefined,
            supplier: supplier.trim() || undefined,
            batchCode: batchCode.trim() || undefined,
            expiryDate: expiryDate.trim() || undefined,
            manufactureDate: manufactureDate.trim() || undefined,
            invoiceNo: invoiceNo.trim() || undefined,
            invoiceDate: invoiceDate.trim() || undefined,
            unitPriceNet: netNum ?? undefined,
            vatRate: vatNum ?? undefined,
            clientKey: batchKey,
          })
        : await addIntake(ingredientId, {
            warehouseId: wh,
            qty: qtyNum,
            unit,
            unitPrice: parseNum(price) ?? undefined,
            dt: dt.trim() || undefined,
            supplier: supplier.trim() || undefined,
          });
      setMsg(res.ok ? { ok: true, text: "Приход заведён" } : { ok: false, text: res.error ?? "Ошибка" });
      if (res.ok) {
        setOpen(false);
        setQty("");
        setPrice("");
        setSupplier("");
        setBatchOpen(false);
        setBatchCode("");
        setExpiryDate("");
        setManufactureDate("");
        setInvoiceNo("");
        setInvoiceDate("");
        setUnitPriceNet("");
        setVatRate("");
        setBatchKey(crypto.randomUUID());
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
          {!batchOpen ? (
            <div style={{ display: "flex", gap: 8 }}>
              <label style={{ flex: 1 }}>
                <span>Цена за единицу</span>
                <input value={price} inputMode="decimal" onChange={(e) => setPrice(e.target.value)} placeholder="80000" />
              </label>
              <label style={{ flex: 1 }}>
                <span>Дата</span>
                <input value={dt} type="date" onChange={(e) => setDt(e.target.value)} />
              </label>
            </div>
          ) : (
            <label>
              <span>Дата прихода</span>
              <input value={dt} type="date" onChange={(e) => setDt(e.target.value)} />
            </label>
          )}
          <label>
            <span>Поставщик</span>
            <input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="необязательно" />
          </label>

          <button
            type="button"
            className="btn ghost"
            onClick={() => setBatchOpen((v) => !v)}
            aria-expanded={batchOpen}
            style={{ alignSelf: "flex-start" }}
          >
            {batchOpen ? "▾ Партия" : "▸ Партия (срок, документ, цена)"}
          </button>

          {batchOpen && (
            <div className="pass" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", gap: 8 }}>
                <label style={{ flex: 1 }}>
                  <span>Код партии</span>
                  <input value={batchCode} onChange={(e) => setBatchCode(e.target.value)} placeholder="необязательно" />
                </label>
                <label style={{ flex: 1 }}>
                  <span>Срок годности</span>
                  <input value={expiryDate} type="date" onChange={(e) => setExpiryDate(e.target.value)} />
                </label>
                <label style={{ flex: 1 }}>
                  <span>Дата производства</span>
                  <input value={manufactureDate} type="date" onChange={(e) => setManufactureDate(e.target.value)} />
                </label>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <label style={{ flex: 1 }}>
                  <span>№ счёта-фактуры</span>
                  <input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} placeholder="необязательно" />
                </label>
                <label style={{ flex: 1 }}>
                  <span>Дата счёта-фактуры</span>
                  <input value={invoiceDate} type="date" onChange={(e) => setInvoiceDate(e.target.value)} />
                </label>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <label style={{ flex: 1 }}>
                  <span>Цена без НДС</span>
                  <input
                    value={unitPriceNet}
                    inputMode="decimal"
                    onChange={(e) => setUnitPriceNet(e.target.value)}
                    placeholder="162500"
                  />
                </label>
                <label style={{ flex: 1 }}>
                  <span>Ставка НДС, %</span>
                  <input value={vatRate} inputMode="decimal" onChange={(e) => setVatRate(e.target.value)} placeholder="12" />
                </label>
              </div>
              <p className="hint" style={{ margin: 0 }}>
                {grossPreview !== null
                  ? `С НДС за единицу: ${sum(grossPreview)}${unit ? `/${unit}` : ""} — сверь с ценой в карточке.`
                  : "Впиши цену без НДС и ставку — посчитаю цену с НДС для сверки с карточкой."}
              </p>
            </div>
          )}

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
