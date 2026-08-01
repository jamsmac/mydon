"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { runStocktake, type StocktakeResult } from "../app/card/actions";
import type { WarehouseStock } from "../lib/core";

/** Число из ввода: «8», «8.5», «8,5» — одно и то же. Пусто/мусор → null. */
function num(s: string): number | null {
  const t = s.trim().replace(/\s/g, "").replace(",", ".");
  if (t.length === 0) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
const fmt = (n: number) => n.toLocaleString("ru-RU", { maximumFractionDigits: 3 });

/**
 * Сессия пересчёта склада (инвентаризация «заголовком»).
 *
 * Владелец вписывает фактические остатки по позициям сразу, всем списком.
 * Дельту от книжного остатка и корректировку по КАЖДОЙ считает сервер — здесь
 * дельта только для предпросмотра. Пустое поле не трогается (позицию не считали).
 * Позиции без базовой единицы в пересчёт не входят: их остаток не сведён.
 */
export function StocktakeSession({
  warehouseId,
  items,
}: {
  warehouseId: string;
  items: WarehouseStock["items"];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [actual, setActual] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  if (items.length === 0) return null;
  const countable = items.filter((it) => it.baseUnit && it.qty !== null);

  const run = () => {
    setMsg(null);
    const lines = countable
      .map((it) => ({ it, a: num(actual[it.ingredientId] ?? "") }))
      .filter((x) => x.a !== null)
      .map((x) => ({ ingredientId: x.it.ingredientId, actual: x.a as number, unit: x.it.baseUnit as string }));
    if (lines.length === 0) {
      setMsg({ ok: false, text: "Впиши фактический остаток хотя бы по одной позиции" });
      return;
    }
    start(async () => {
      const res: StocktakeResult = await runStocktake(warehouseId, lines);
      if (res.ok) {
        setMsg({
          ok: true,
          text: `Проведено: корректировок ${res.changed}, совпало ${res.matched}${
            res.failed ? `, не проведено ${res.failed}` : ""
          }`,
        });
        setActual({});
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error ?? "Не получилось" });
      }
    });
  };

  return (
    <div className="sect" id="stocktake" data-toc="Пересчёт">
      <div className="sect-h">
        <h3 className="h2">Пересчёт склада</h3>
        <span className="chip">
          {countable.length} {countable.length === 1 ? "позиция" : "позиций"}
        </span>
      </div>
      <p className="hint" style={{ marginBottom: 10 }}>
        Впиши фактический остаток — дельту от книжного и корректировку посчитает сервер. Пустое
        поле не трогается.
      </p>

      <div className="form">
        <div className="strows">
          {countable.map((it) => {
            const a = num(actual[it.ingredientId] ?? "");
            const book = it.qty ?? 0;
            const delta = a === null ? null : a - book;
            return (
              <div className="strow" key={it.ingredientId}>
                <span className="stname">{it.ingredientName}</span>
                <span className="stbook mono">
                  {fmt(book)} {it.baseUnit}
                </span>
                <input
                  className="stin"
                  inputMode="decimal"
                  placeholder="факт"
                  value={actual[it.ingredientId] ?? ""}
                  onChange={(e) =>
                    setActual((p) => ({ ...p, [it.ingredientId]: e.target.value }))
                  }
                  aria-label={`Фактический остаток: ${it.ingredientName}`}
                />
                {delta === null ? (
                  <span className="chip">—</span>
                ) : Math.abs(delta) < 1e-9 ? (
                  <span className="chip g">совпало</span>
                ) : (
                  <span className={`chip ${delta < 0 ? "h" : "b"}`}>
                    {delta > 0 ? "+" : ""}
                    {fmt(delta)} {it.baseUnit}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {items.length > countable.length && (
          <p className="hint">
            Без базовой единицы в пересчёт не входят: {items.length - countable.length}.
          </p>
        )}

        <div className="form-actions">
          <button type="button" className="btn" onClick={run} disabled={pending}>
            Провести пересчёт
          </button>
          {msg && <span className={msg.ok ? "ok-text" : "err-text"}>{msg.text}</span>}
        </div>
      </div>
    </div>
  );
}
