"use client";

import { useState, useTransition } from "react";
import { bindSaleAlias, unbindSaleAlias } from "../app/card/actions";

/**
 * Склейка имён продаж: привязать «как товар назван в источнике» к карточке.
 *
 * Продажи приходят из mydon-stock текстом, и часть имён не совпадает с
 * карточками — эти продажи карточка не видит. Привязка — решение владельца
 * (автомату нельзя: «похожее» имя рано или поздно склеит 330ml с 450ml).
 * Список кандидатов отсортирован по деньгам ещё в Core: сначала привязывается
 * то, что дороже оставлять невидимым.
 */
export function SaleAliasBinder({
  entityId,
  aliases,
  unmatched,
}: {
  entityId: string;
  aliases: { id: string; name: string }[];
  unmatched: { name: string; qty: number; amount: number }[];
}) {
  const [picked, setPicked] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const привязать = () =>
    start(async () => {
      const res = await bindSaleAlias(entityId, picked);
      setMsg(res.ok ? { ok: true, text: `Привязано: ${picked}` } : { ok: false, text: res.error ?? "Не сохранилось" });
      if (res.ok) setPicked("");
    });

  const отвязать = (id: string, name: string) =>
    start(async () => {
      const res = await unbindSaleAlias(entityId, id);
      setMsg(res.ok ? { ok: true, text: `Отвязано: ${name}` } : { ok: false, text: res.error ?? "Не сохранилось" });
    });

  return (
    <div style={{ marginTop: 12 }}>
      {aliases.length > 0 && (
        <div className="rows">
          {aliases.map((a) => (
            <div className="row" key={a.id}>
              <div className="t">
                <span className="mono">{a.name}</span>
                <span className="pill">алиас</span>
              </div>
              <button type="button" className="btn sm ghost" onClick={() => отвязать(a.id, a.name)} disabled={pending}>
                Отвязать
              </button>
            </div>
          ))}
        </div>
      )}

      {unmatched.length > 0 && (
        <div className="form" style={{ marginTop: 8 }}>
          <label>
            Привязать имя из продаж
            <select value={picked} onChange={(e) => setPicked(e.target.value)} disabled={pending}>
              <option value="">— несвязанные имена ({unmatched.length}) —</option>
              {unmatched.map((u) => (
                <option key={u.name} value={u.name}>
                  {u.name} · {u.qty.toLocaleString("ru-RU")} шт · {Math.round(u.amount).toLocaleString("ru-RU")} сум
                </option>
              ))}
            </select>
          </label>
          <div className="form-actions">
            <button type="button" className="btn pri sm" onClick={привязать} disabled={pending || picked === ""}>
              {pending ? "Сохраняю…" : "Привязать к этой карточке"}
            </button>
          </div>
        </div>
      )}

      {msg && (
        <p className={msg.ok ? "ok-text" : "err-text"} style={{ marginTop: 8 }}>
          {msg.text}
        </p>
      )}
    </div>
  );
}
