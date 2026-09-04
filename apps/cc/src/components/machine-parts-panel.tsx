"use client";

import { useState, useTransition } from "react";
import {
  COMMON_PART_KINDS,
  PART_KINDS,
  PART_OFF_LOCATIONS,
  PART_SWAP_REASONS,
  SWAP_REASON_LABELS,
  partLabel,
  partLocationLabel,
} from "@mydon/shared";
import { installPart, removePart, swapPart } from "../app/card/actions";

/**
 * Узлы автомата: что стоит сейчас, что стояло раньше, и три операции —
 * установить · снять · заменить.
 *
 * До этой панели узлы жили только в API (`core.machineParts` не звал никто) и
 * в боте у полевого мастера была одна операция — замена. Снятый узел при этом
 * исчезал из учёта; теперь снятие открывает период «на мойке/в ремонте», и
 * узел можно поставить обратно со склада — историю экземпляра держит серийник.
 *
 * Клиентский компонент по той же причине, что MachineCardPanel: серийник и
 * примечание набирают ДО нажатия, спросить их надо в момент операции.
 */

/** Строка machine_part, как её отдаёт Core (сериализована в JSON). */
export interface PartRow {
  id: string;
  machineId: string | null;
  location: string;
  partKind: string;
  slot: number | null;
  serialNumber: string | null;
  model: string | null;
  installedOn: string;
  removedOn: string | null;
  note: string | null;
  /** Карточка узла: номер и наклейка (R-PU-1). */
  unit?: { id: string; inventoryNo: string | null; labelPending: boolean; retiredAt: string | null } | null;
}

type Mode =
  | { t: "install" }
  | { t: "remove"; part: PartRow }
  | { t: "swap"; part: PartRow }
  | null;

const дата = (d: string | null): string => (d ? d.split("-").reverse().join(".") : "—");

const место = (p: PartRow): string =>
  `${partLabel(p.partKind)}${p.slot !== null ? ` №${p.slot}` : ""}`;

/**
 * Инвентарный номер узла и состояние наклейки (R-PU-2, R-PU-4). Карточка узла —
 * по ссылке; «наклеить» и «без номера» — оранжевым, потому что это действие
 * сотрудника, а не справка.
 */
function НомерУзла({ p }: { p: PartRow }) {
  const u = p.unit;
  if (!u) return null;
  const href = `/parts/${u.id}`;
  if (!u.inventoryNo) {
    return (
      <a className="pill act" href={href}>
        без номера
      </a>
    );
  }
  return (
    <>
      <a className="pill mono" href={href}>
        {u.inventoryNo}
      </a>
      {u.labelPending && (
        <a className="pill act" href={href} title="Номер присвоен системой — наклейте его на деталь и подтвердите">
          наклеить
        </a>
      )}
    </>
  );
}

export function MachinePartsPanel({
  machineId,
  parts,
  storage,
}: {
  machineId: string;
  parts: PartRow[];
  /** Узлы вне автоматов — кандидаты на установку со склада. */
  storage: PartRow[];
}) {
  const [mode, setMode] = useState<Mode>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  // Поля форм. Один набор на все режимы — открытие режима их сбрасывает.
  const [kind, setKind] = useState<string>(COMMON_PART_KINDS[0] ?? "brewer");
  const [slot, setSlot] = useState("");
  const [partId, setPartId] = useState("");
  const [serial, setSerial] = useState("");
  const [model, setModel] = useState("");
  const [toLocation, setToLocation] = useState("washing");
  const [reason, setReason] = useState("preventive");
  const [note, setNote] = useState("");

  const открытые = parts.filter((p) => p.removedOn === null);
  const история = parts.filter((p) => p.removedOn !== null);
  const соСклада = storage.filter((s) => s.partKind === kind);

  function открыть(next: Mode) {
    setMode(next);
    setMsg(null);
    setPartId("");
    setSerial("");
    setModel("");
    setNote("");
    setToLocation("washing");
    setReason("preventive");
    if (next?.t === "remove" || next?.t === "swap") {
      setKind(next.part.partKind);
      setSlot(next.part.slot !== null ? String(next.part.slot) : "");
    } else {
      setSlot("");
    }
  }

  const done = (ok: boolean, text: string) => {
    setMsg({ ok, text });
    if (ok) setMode(null);
  };

  const выполнить = () =>
    start(async () => {
      const slotNum = /^\d+$/.test(slot.trim()) ? Number(slot.trim()) : undefined;
      if (mode?.t === "install") {
        const res = await installPart(machineId, {
          partKind: kind,
          ...(slotNum !== undefined ? { slot: slotNum } : {}),
          ...(partId ? { partId } : {}),
          ...(serial.trim() ? { serialNumber: serial.trim() } : {}),
          ...(model.trim() ? { model: model.trim() } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        });
        done(res.ok, res.ok ? "Узел установлен" : (res.error ?? "Не сохранилось"));
      } else if (mode?.t === "remove") {
        const res = await removePart(machineId, {
          partKind: mode.part.partKind,
          ...(mode.part.slot !== null ? { slot: mode.part.slot } : {}),
          toLocation,
          ...(note.trim() ? { note: note.trim() } : {}),
        });
        done(
          res.ok,
          res.ok
            ? `Снят: ${место(mode.part).toLowerCase()} → ${partLocationLabel(toLocation).toLowerCase()}`
            : (res.error ?? "Не сохранилось"),
        );
      } else if (mode?.t === "swap") {
        const res = await swapPart(machineId, {
          partKind: mode.part.partKind,
          ...(mode.part.slot !== null ? { slot: mode.part.slot } : {}),
          ...(serial.trim() ? { newSerial: serial.trim() } : {}),
          ...(model.trim() ? { model: model.trim() } : {}),
          reason,
          ...(note.trim() ? { note: note.trim() } : {}),
        });
        done(res.ok, res.ok ? `Заменён: ${место(mode.part).toLowerCase()}` : (res.error ?? "Не сохранилось"));
      }
    });

  return (
    <div className="sect" id="parts" data-toc="Узлы">
      <div className="sect-h">
        <h3 className="h2">Узлы</h3>
        <span className="chip">{открытые.length}</span>
        <span className="sp" />
        <button
          type="button"
          className="btn sm"
          onClick={() => открыть(mode?.t === "install" ? null : { t: "install" })}
          disabled={pending}
        >
          + Установить
        </button>
      </div>

      {открытые.length === 0 && (
        <div className="empty">
          <b>Узлы не заведены</b>
          Что стоит в автомате — купюроприёмник, кофемолка, бункеры — появится здесь после
          первой установки или замены.
        </div>
      )}

      {открытые.length > 0 && (
        <div className="rows">
          {открытые.map((p) => (
            <div className="row" key={p.id}>
              <div className="t">
                {место(p)}
                <НомерУзла p={p} />
                {p.serialNumber && <span className="pill mono"> {p.serialNumber}</span>}
                {p.model && <span className="pill">{p.model}</span>}
              </div>
              <span className="when">с {дата(p.installedOn)}</span>
              <button type="button" className="btn sm" onClick={() => открыть({ t: "swap", part: p })} disabled={pending}>
                Заменить
              </button>
              <button type="button" className="btn sm ghost" onClick={() => открыть({ t: "remove", part: p })} disabled={pending}>
                Снять
              </button>
            </div>
          ))}
        </div>
      )}

      {mode && (
        <div className="form" style={{ marginTop: 12 }}>
          {mode.t === "install" && (
            <>
              <label>
                Вид узла
                <select value={kind} onChange={(e) => { setKind(e.target.value); setPartId(""); }} disabled={pending}>
                  {/* Частые — первыми, как в боте у полевого мастера. */}
                  {[...COMMON_PART_KINDS, ...PART_KINDS.filter((k) => !COMMON_PART_KINDS.includes(k))].map((k) => (
                    <option key={k} value={k}>
                      {partLabel(k)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Слот (если узлов несколько: бункер 1..8)
                <input value={slot} onChange={(e) => setSlot(e.target.value)} placeholder="пусто — без слота" disabled={pending} />
              </label>
              <label>
                Со склада
                <select value={partId} onChange={(e) => setPartId(e.target.value)} disabled={pending}>
                  <option value="">— новый узел, не из учтённых —</option>
                  {соСклада.map((s) => (
                    <option key={s.id} value={s.id}>
                      {partLabel(s.partKind)}
                      {s.serialNumber ? ` · ${s.serialNumber}` : " · без серийника"}
                      {` · ${partLocationLabel(s.location).toLowerCase()}`}
                    </option>
                  ))}
                </select>
              </label>
              {partId === "" && (
                <>
                  <label>
                    Серийный номер
                    <input value={serial} onChange={(e) => setSerial(e.target.value)} placeholder="с шильдика; пусто — не переписан" disabled={pending} />
                  </label>
                  <label>
                    Модель
                    <input value={model} onChange={(e) => setModel(e.target.value)} disabled={pending} />
                  </label>
                </>
              )}
            </>
          )}

          {mode.t === "remove" && (
            <>
              <p className="hint">
                Снимаем: <b>{место(mode.part)}</b>
                {mode.part.serialNumber ? ` · ${mode.part.serialNumber}` : ""}. Узел не исчезает — он
                продолжит числиться там, куда его увезли, и его можно будет поставить обратно.
              </p>
              <label>
                Куда
                <select value={toLocation} onChange={(e) => setToLocation(e.target.value)} disabled={pending}>
                  {PART_OFF_LOCATIONS.map((l) => (
                    <option key={l} value={l}>
                      {partLocationLabel(l)}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}

          {mode.t === "swap" && (
            <>
              <p className="hint">
                Меняем: <b>{место(mode.part)}</b>
                {mode.part.serialNumber ? ` · ${mode.part.serialNumber}` : ""}. Старый период закроется,
                новый узел встанет на то же место одной операцией.
              </p>
              <label>
                Серийный номер нового узла
                <input value={serial} onChange={(e) => setSerial(e.target.value)} placeholder="пусто — не переписан" disabled={pending} />
              </label>
              <label>
                Модель
                <input value={model} onChange={(e) => setModel(e.target.value)} disabled={pending} />
              </label>
              <label>
                Причина
                <select value={reason} onChange={(e) => setReason(e.target.value)} disabled={pending}>
                  {PART_SWAP_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {SWAP_REASON_LABELS[r]}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}

          <label>
            Примечание
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="необязательно" disabled={pending} />
          </label>
          <div className="form-actions">
            <button type="button" className="btn pri" onClick={выполнить} disabled={pending}>
              {pending ? "Сохраняю…" : mode.t === "install" ? "Установить" : mode.t === "remove" ? "Снять" : "Заменить"}
            </button>
            <button type="button" className="btn ghost" onClick={() => setMode(null)} disabled={pending}>
              Отмена
            </button>
          </div>
        </div>
      )}

      {msg && (
        <p className={msg.ok ? "ok-text" : "err-text"} style={{ marginTop: 10 }}>
          {msg.text}
        </p>
      )}

      {история.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary className="hint">История узлов · {история.length}</summary>
          <div className="rows">
            {история.map((p) => (
              <div className="row" key={p.id}>
                <div className="t">
                  {место(p)}
                  {p.serialNumber && <span className="pill mono"> {p.serialNumber}</span>}
                </div>
                <span className="when">
                  {дата(p.installedOn)} → {дата(p.removedOn)}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
