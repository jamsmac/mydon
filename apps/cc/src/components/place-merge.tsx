"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { MERGE_BASES, MERGE_BASIS_LABELS, MERGE_REASON_MIN, type MergeBasis } from "@mydon/shared";
import { mergePlaces, previewPlaceMerge } from "../app/card/actions";
import type { PlaceMergePreview } from "../lib/core";

/** Подпись переносимой таблицы словами — читает владелец, не программист. */
const MOVE_LABELS: Record<string, string> = {
  "machine_placement.location_id": "периоды размещения автоматов",
  "coffee_refill.location_id": "заливки бункеров",
  "coffee_consumable.location_id": "дни расходников",
  "coffee_consumable_log.location_id": "записи ввода расходников",
  "coffee_wash_log.location_id": "мойки",
  "coffee_wash_schedule.location_id": "график мойки",
  "coffee_sale.location_id": "продажи кофе",
  "stock_movement.warehouse_id": "движения склада",
  "stock_movement.counterparty_id": "перемещения на этот склад",
  "stock_batch.warehouse_id": "партии на складе",
  "part_count_session.warehouse_id": "инвентаризации узлов",
  "task.entity_id": "задачи",
  "maintenance_log.entity_id": "записи обслуживания",
  "maintenance_plan.entity_id": "нормативы ТО",
  "entity_draft.entity_id": "предложенные правки",
  "raw_link.entity_id": "связи с источниками",
  "note.entity_id": "заметки",
  "document.entity_id": "документы",
  "money_flow.entity_id": "деньги",
  "attachment.owner_id": "фото и вложения",
};

/**
 * «Слить с другой карточкой этого же места» (М-9, М-10).
 *
 * Шаги раздельно: цель → предпросмотр (что переедет, что мешает) → основание и
 * причина → подтверждение вторым нажатием. Слияние не отменяется кнопкой, а
 * одно место, заведённое дважды, — редкость: лишний шаг дешевле ошибки.
 * Совпадения адреса среди оснований нет — у KIUT четыре места по одному адресу.
 */
export function PlaceMerge({
  sourceId,
  sourceName,
  candidates,
}: {
  sourceId: string;
  sourceName: string;
  /** Карточки того же вида, не слитые, кроме этой. */
  candidates: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [targetId, setTargetId] = useState("");
  const [preview, setPreview] = useState<PlaceMergePreview | null>(null);
  const [basis, setBasis] = useState<MergeBasis | "">("");
  const [reason, setReason] = useState("");
  const [armed, setArmed] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const target = candidates.find((c) => c.id === targetId) ?? null;

  const check = (id: string) => {
    setTargetId(id);
    setPreview(null);
    setArmed(false);
    setMsg(null);
    if (id === "") return;
    start(async () => {
      const res = await previewPlaceMerge(sourceId, id);
      if (res.ok) setPreview(res.preview);
      else setMsg({ ok: false, text: res.error });
    });
  };

  const run = () =>
    start(async () => {
      setMsg(null);
      const res = await mergePlaces(sourceId, targetId, basis, reason);
      if (res.ok) {
        setMsg({ ok: true, text: `Слито в «${target?.name ?? ""}»` });
        router.refresh();
      } else {
        setArmed(false);
        setMsg({ ok: false, text: res.error ?? "Не получилось" });
      }
    });

  const ready = preview !== null && preview.blockers.length === 0 && basis !== "" && reason.trim().length >= MERGE_REASON_MIN;
  const moves = preview ? Object.entries(preview.moves) : [];

  return (
    <div className="form">
      <p className="hint">
        Одно место заведено дважды? Всё, что висит на «{sourceName}», переедет на выбранную карточку, а эта
        закроется с пометкой «слита в …». Сливать можно только по подтверждённому совпадению места — не по
        адресу: у одного адреса бывает несколько мест.
      </p>
      <label>
        Слить в
        <select value={targetId} onChange={(e) => check(e.target.value)} disabled={pending}>
          <option value="">— выберите карточку этого же места —</option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      {preview && (
        <div className="card" style={{ margin: "8px 0" }}>
          {moves.length === 0 ? (
            <p className="hint">На этой карточке ничего не висит — переносить нечего.</p>
          ) : (
            <p>
              Переедет:{" "}
              {moves.map(([k, v], i) => (
                <span key={k}>
                  {i > 0 && ", "}
                  {MOVE_LABELS[k] ?? k} — {v}
                </span>
              ))}
              .
            </p>
          )}
          <p className="hint">
            {preview.geo === "target_keeps"
              ? "Координаты остаются у выбранной карточки."
              : preview.geo === "moved_from_source"
                ? "Координаты переедут с этой карточки."
                : "Координат нет ни у одной."}
          </p>
          {preview.blockers.length > 0 && (
            <div className="err-text">
              Слить нельзя, пока не разобрано:
              <ul>
                {preview.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {preview && preview.blockers.length === 0 && (
        <>
          <label>
            Основание
            <select value={basis} onChange={(e) => setBasis(e.target.value as MergeBasis | "")} disabled={pending}>
              <option value="">— почему это одно место —</option>
              {MERGE_BASES.map((b) => (
                <option key={b} value={b}>
                  {MERGE_BASIS_LABELS[b]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Причина словами
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="«кардиология 4 корпус» и «4 корпус кардиология» — один автомат, слово владельца 10.09"
              rows={2}
              disabled={pending}
            />
          </label>
          <div className="form-actions">
            {armed ? (
              <>
                <button type="button" className="btn pri" onClick={run} disabled={pending || !ready}>
                  {pending ? "Сливаю…" : `Да, слить в «${target?.name ?? ""}»`}
                </button>
                <button type="button" className="btn ghost" onClick={() => setArmed(false)} disabled={pending}>
                  Не сливать
                </button>
              </>
            ) : (
              <button type="button" className="btn" onClick={() => setArmed(true)} disabled={pending || !ready}>
                Слить…
              </button>
            )}
          </div>
        </>
      )}
      {msg && <p className={msg.ok ? "ok-text" : "err-text"}>{msg.text}</p>}
    </div>
  );
}
