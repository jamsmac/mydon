"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { PartUnit } from "../lib/core";
import { retirePartUnit, savePartUnit, setPartNumber } from "../app/parts/actions";

/**
 * Паспорт узла и номер. Номер отдельно от паспорта: подтверждение наклейки —
 * самое частое действие, и ему не нужна форма (R-PU-2, R-PU-4).
 */
export function PartUnitEditor({ unit }: { unit: PartUnit }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [number, setNumber] = useState(unit.inventoryNo ?? "");
  const [confirmRetire, setConfirmRetire] = useState(false);
  const [reason, setReason] = useState("");

  function done(res: { ok: boolean; error?: string }, okText = "Сохранено") {
    setMsg(res.ok ? { kind: "ok", text: okText } : { kind: "err", text: res.error ?? "Ошибка" });
    if (res.ok) router.refresh();
  }

  const hopper = unit.partKind === "hopper";

  return (
    <div className="card">
      <div className="card-top">
        <span className={`pill ${unit.retiredAt ? "bad" : unit.labelPending || !unit.inventoryNo ? "act" : "ok"}`}>
          {unit.retiredAt ? "списан" : !unit.inventoryNo ? "без номера" : unit.labelPending ? "наклеить номер" : "номер наклеен"}
        </span>
        {!unit.retiredAt && unit.inventoryNo && unit.labelPending && (
          <button
            type="button"
            className="btn primary"
            disabled={pending}
            onClick={() => start(async () => done(await setPartNumber(unit.id, "", true), "Наклейка подтверждена"))}
          >
            Наклеил {unit.inventoryNo} — подтвердить
          </button>
        )}
      </div>

      {!unit.retiredAt && (
        <div className="form">
          <label>
            <span>Инвентарный номер (с наклейки)</span>
            <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="M-017 · G-004 · H-27-3" maxLength={32} />
            <small className="hint">
              Система предложила {unit.inventoryNo ?? "ещё ничего"}; если на детали уже есть свой номер — впиши его.
            </small>
          </label>
          <div className="form-actions">
            <button
              type="button"
              className="btn"
              disabled={pending || number.trim() === "" || number.trim() === unit.inventoryNo}
              onClick={() => start(async () => done(await setPartNumber(unit.id, number, true), "Номер сохранён"))}
            >
              Сохранить номер
            </button>
          </div>
        </div>
      )}

      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          start(async () => done(await savePartUnit(unit.id, form)));
        }}
      >
        <label>
          <span>Серийный номер (с шильдика)</span>
          <input name="serialNumber" defaultValue={unit.serialNumber ?? ""} maxLength={128} />
        </label>
        <label>
          <span>Модель</span>
          <input name="model" defaultValue={unit.model ?? ""} maxLength={128} />
        </label>
        <label>
          <span>Производитель</span>
          <input name="manufacturer" defaultValue={unit.manufacturer ?? ""} maxLength={128} />
        </label>
        {hopper && (
          <>
            <label>
              <span>Набор (1–27)</span>
              <input name="setNumber" defaultValue={unit.setNumber ?? ""} inputMode="numeric" />
            </label>
            <label>
              <span>Позиция бункера (1–8)</span>
              <input name="hopperPosition" defaultValue={unit.hopperPosition ?? ""} inputMode="numeric" />
            </label>
            <label>
              <span>Тара, г</span>
              <input name="tareWeight" defaultValue={unit.tareWeight ?? ""} inputMode="numeric" placeholder="пустой контейнер на весах" />
              <small className="hint">Без тары возврат бункера не приходуется на склад: нетто = брутто − тара.</small>
            </label>
          </>
        )}
        {!hopper && <input type="hidden" name="tareWeight" value="" />}
        <label>
          <span>Примечание</span>
          <textarea name="note" rows={2} defaultValue={unit.note ?? ""} />
        </label>
        <div className="form-actions">
          <button type="submit" className="btn primary" disabled={pending || !!unit.retiredAt}>
            {pending ? "Сохраняю…" : "Сохранить паспорт"}
          </button>
          {msg && <span className={msg.kind === "ok" ? "ok-text" : "err-text"}>{msg.text}</span>}
        </div>
      </form>

      {!unit.retiredAt && (
        <div className="danger">
          {confirmRetire ? (
            <>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="причина списания" />
              <button
                type="button"
                className="btn danger-btn"
                disabled={pending}
                onClick={() => start(async () => done(await retirePartUnit(unit.id, reason), "Списан"))}
              >
                Да, списать
              </button>
              <button type="button" className="btn" onClick={() => setConfirmRetire(false)}>
                Отмена
              </button>
            </>
          ) : (
            <button type="button" className="btn" onClick={() => setConfirmRetire(true)} disabled={!!unit.where?.machineId}>
              {unit.where?.machineId ? "Списать нельзя: узел стоит на автомате" : "Списать узел"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
