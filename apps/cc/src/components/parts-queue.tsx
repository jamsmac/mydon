"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { partAttentionLabel, partLabel, partLocationLabel } from "@mydon/shared";
import type { PartUnit, PartsQueue as Queue } from "../lib/core";
import { retirePartUnit, setPartNumber } from "../app/parts/actions";

/**
 * Очередь «Наклеить номер» — по одному узлу на экран (R-PU-4), как квиз ревизии.
 *
 * Действия: «Наклеил — подтвердить» (номер системный, наклейка сделана),
 * «Другой номер» (на детали уже есть свой), «Пропустить» (следующему покажут
 * снова — пропуск не запоминается намеренно), «Списан». Решённое исчезает.
 */
export function PartsQueue({ queue }: { queue: Queue }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [custom, setCustom] = useState("");
  const [mode, setMode] = useState<"idle" | "number" | "retire">("idle");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const items = queue.items.filter((it: PartUnit) => !skipped.has(it.id));
  const it = items[0];
  const total = queue.items.length;

  function done(res: { ok: boolean; error?: string }) {
    if (res.ok) {
      setMsg({ kind: "ok", text: "Сохранено" });
      setCustom("");
      setReason("");
      setMode("idle");
      router.refresh();
    } else setMsg({ kind: "err", text: res.error ?? "Ошибка" });
  }

  if (!it) {
    return (
      <div className="empty">
        <b>{total === 0 ? "Очередь пуста" : "Всё, что можно, решено"}</b>
        {total === 0
          ? "Все узлы учтены: номера наклеены, местонахождение известно, тара и фото есть."
          : "Пропущенные вернутся при следующем открытии — так и задумано."}
      </div>
    );
  }

  const where = it.where
    ? it.where.machineName
      ? `${it.where.machineName}${it.where.slot !== null ? ` · слот ${it.where.slot}` : ""}`
      : partLocationLabel(it.where.location)
    : "местонахождение неизвестно";

  return (
    <div className="card">
      <div className="card-top">
        <span className="eyebrow">
          {partLabel(it.partKind)} · {where}
        </span>
        <span className="pill">
          {total - items.length + 1} из {total}
        </span>
      </div>
      <h2 style={{ marginTop: 6 }}>{it.inventoryNo ?? "Номер не присвоен"}</h2>
      <p className="hint">
        {it.attention.map((a) => (
          <span key={a} className="pill act" style={{ marginRight: 6 }}>
            {partAttentionLabel(a)}
          </span>
        ))}
        {it.serialNumber && <span className="pill mono">S/N {it.serialNumber}</span>}
      </p>
      {it.note && <p className="hint">{it.note}</p>}

      {mode === "number" && (
        <div className="form">
          <label>
            <span>Номер, который уже есть на детали</span>
            <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="например M-017 или H-27-3" autoFocus />
          </label>
        </div>
      )}
      {mode === "retire" && (
        <div className="form">
          <label>
            <span>Почему списан</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="трещина, потерян, продан…" autoFocus />
          </label>
        </div>
      )}

      <div className="form-actions" style={{ flexWrap: "wrap", gap: 8 }}>
        {mode === "idle" && (
          <>
            {it.inventoryNo && it.labelPending && (
              <button
                type="button"
                className="btn primary"
                disabled={pending}
                onClick={() => start(async () => done(await setPartNumber(it.id, "", true)))}
              >
                Наклеил {it.inventoryNo} — подтвердить
              </button>
            )}
            {!it.inventoryNo && (
              <button
                type="button"
                className="btn primary"
                disabled={pending}
                onClick={() => start(async () => done(await setPartNumber(it.id, "", false)))}
              >
                Присвоить номер
              </button>
            )}
            <button type="button" className="btn" disabled={pending} onClick={() => setMode("number")}>
              Другой номер
            </button>
            <a className="btn ghost" href={`/parts/${it.id}`}>
              Карточка
            </a>
            <button
              type="button"
              className="btn ghost"
              disabled={pending}
              onClick={() => {
                setSkipped(new Set([...skipped, it.id]));
                setMsg(null);
              }}
            >
              Пропустить
            </button>
            <button type="button" className="btn ghost" disabled={pending} onClick={() => setMode("retire")}>
              Списан
            </button>
          </>
        )}
        {mode === "number" && (
          <>
            <button
              type="button"
              className="btn primary"
              disabled={pending || custom.trim() === ""}
              onClick={() => start(async () => done(await setPartNumber(it.id, custom, true)))}
            >
              Сохранить номер
            </button>
            <button type="button" className="btn ghost" onClick={() => setMode("idle")}>
              Отмена
            </button>
          </>
        )}
        {mode === "retire" && (
          <>
            <button
              type="button"
              className="btn danger-btn"
              disabled={pending}
              onClick={() => start(async () => done(await retirePartUnit(it.id, reason)))}
            >
              Да, списать
            </button>
            <button type="button" className="btn ghost" onClick={() => setMode("idle")}>
              Отмена
            </button>
          </>
        )}
        {msg && <span className={msg.kind === "ok" ? "ok-text" : "err-text"}>{msg.text}</span>}
      </div>
    </div>
  );
}
