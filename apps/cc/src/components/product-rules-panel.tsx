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
 *
 * Эталон витрины (`sale_price`, П5b, R-P5b-6) живёт по тому же правилу и
 * ПОЭТОМУ показан без формы: единственный писатель — бот («цена продажи
 * <товар> <сум>»). Форма здесь завела бы второго писателя одного поля.
 */

/** Число без неразрывного пробела: скопированная цена должна находиться поиском. */
const n = (v: number): string => v.toLocaleString("ru-RU").replace(/\u00a0/g, " ");

const CATEGORY_LABEL: Record<VendingProductRow["category"], string> = {
  drink: "напиток",
  snack: "снек",
  other: "прочее",
};

function RuleForm({ domain, row, onDone }: { domain: string; row: VendingProductRow; onDone: (saved?: string | null) => void }) {
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
            // Что именно записано — строкой в панели: форма закрывается, и без
            // подтверждения владелец не знает, дошла ли правка (UX#25).
            onDone(res.message ?? null);
            router.refresh();
          } else {
            setError(res.message ?? "Не получилось");
          }
        });
      }}
    >
      {/* Форма открывается под списком, и без заголовка не было видно, какой
          товар правишь: строка «Править» уже уехала вверх (UX#14). */}
      <div className="section-title">Правила закупа — {row.name}</div>
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
        <button type="button" className="btn" onClick={() => onDone()}>
          Отмена
        </button>
        {error && <span className="err-text">{error}</span>}
      </div>
    </form>
  );
}

export function ProductRulesPanel({ domain, products }: { domain: string; products: VendingProductRow[] }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const editingRow = editing === null ? null : (products.find((p) => p.id === editing) ?? null);
  const close = (message?: string | null) => {
    setEditing(null);
    setSaved(message ?? null);
  };

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
                  блок {n(p.packSize)} ·{" "}
                  {/* «витрина 0» читалось бы как «продаём бесплатно»: эталона
                      просто нет, и сравнивать факт не с чем (R-P5b-6). */}
                  {p.salePrice === null ? "эталон не задан" : `витрина ${n(p.salePrice)}`}
                </small>
              </div>
              {p.excludedFromPurchase && <span className="pill bad">исключён</span>}
              {p.fixedPurchaseQty !== null && <span className="pill">фикс {n(p.fixedPurchaseQty)}</span>}
              {/* Имя товара — в aria-label, а не в подписи: в списке из 48
                  строк кнопка «Править Snickers 50gr» ломала колонку, но без
                  имени кнопка неотличима от 47 соседних для читалки (UX#24). */}
              <button type="button" className="btn sm" aria-label={`Править ${p.name}`} onClick={() => setEditing(p.id)}>
                Править
              </button>
            </div>
          ))}
        </div>
      )}
      {editingRow && (
        // key=id — переключение «Править» на другую строку без «Отмена» должно
        // ПЕРЕМОНТИРОВАТЬ форму: без key React переиспользует смонтированные
        // неуправляемые input'ы и не переприменяет defaultValue/defaultChecked,
        // и правки сохранились бы под чужим именем товара (ревью, находка 1).
        <RuleForm key={editingRow.id} domain={domain} row={editingRow} onDone={close} />
      )}
      {saved && editingRow === null && <p className="ok-text">{saved}</p>}
      <p className="hint" style={{ marginTop: 8 }}>
        Цена — только чтение: правится в боте командой «цена &lt;товар&gt; &lt;сум&gt;».
      </p>
      <p className="hint">
        {"Витрина (эталон) — только чтение: правится в боте командой «цена продажи <товар> <сум>»."}
      </p>
    </>
  );
}
