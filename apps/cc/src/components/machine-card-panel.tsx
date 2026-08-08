"use client";

import { useState, useTransition } from "react";
import {
  MACHINE_KINDS,
  MACHINE_KIND_LABELS,
  MACHINE_STATUSES,
  MACHINE_STATUS_LABELS,
  machineIsOperational,
  machineStatusLabel,
  placeTypeLabel,
  type MachineKind,
  type MachineStatus,
} from "@mydon/shared";
import { setMachineKind, setMachineStatus } from "../app/card/actions";

/**
 * Карточка автомата: вид и состояние.
 *
 * До этого экрана оба поля задавались только запросом к API. Вид проставлял
 * массовый прогон, состояние — вообще ничего: автомат уезжал в ремонт, и
 * система об этом не узнавала, продолжая слать технику работы по графику.
 *
 * Клиентский компонент, потому что причина простоя — текст, который набирают
 * ДО нажатия («заявка №12», «ждём плату»). Отправить состояние без причины
 * можно, но спросить её надо в тот же момент — иначе она не появится никогда.
 */
export function MachineCardPanel({
  id,
  kind,
  status,
  statusNote,
  statusChangedAt,
  updatedBy,
  places = [],
}: {
  id: string;
  kind: string | null;
  status: string | null;
  statusNote: string | null;
  statusChangedAt: string | null;
  updatedBy: string | null;
  /** Куда можно поставить автомат: точки продаж, склады, мастерские. */
  places?: { id: string; name: string; type: string }[];
}) {
  const [note, setNote] = useState(statusNote ?? "");
  const [placeId, setPlaceId] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const текущее = (status ?? "in_service") as MachineStatus;
  const вРаботе = machineIsOperational(status);
  const since = statusChangedAt
    ? new Date(statusChangedAt).toLocaleDateString("ru-RU", { timeZone: "Asia/Tashkent" })
    : null;

  const применить = (next: MachineStatus) =>
    start(async () => {
      const res = await setMachineStatus(id, next, note.trim() || undefined, placeId || undefined);
      const место = places.find((p) => p.id === placeId);
      setMsg(
        res.ok
          ? {
              ok: true,
              text:
                `Состояние: ${machineStatusLabel(next).toLowerCase()}` +
                (место ? ` · ${место.name}` : ""),
            }
          : { ok: false, text: res.error ?? "Не сохранилось" },
      );
    });

  const сменитьВид = (next: MachineKind) =>
    start(async () => {
      const res = await setMachineKind(id, next);
      setMsg(
        res.ok
          ? { ok: true, text: `Вид: ${MACHINE_KIND_LABELS[next].toLowerCase()}` }
          : { ok: false, text: res.error ?? "Не сохранилось" },
      );
    });

  return (
    <div className="sect" id="machine-card" data-toc="Автомат">
      <div className="sect-h">
        <h3 className="h2">Автомат</h3>
        <span className={`chip ${вРаботе ? "" : "h"}`}>{machineStatusLabel(status)}</span>
        <span className="sp" />
      </div>

      <p className="hint">
        {вРаботе
          ? "В эксплуатации: работы по графику ставятся, техник видит их в боте."
          : `Не в эксплуатации${since ? ` с ${since}` : ""}. Задачи по графику не создаются, ` +
            "и техник таких строк не видит — а сроки остаются в разделе «Обслуживание», " +
            "чтобы долг не пропал из виду."}
        {updatedBy ? ` Последняя правка: ${updatedBy}.` : ""}
      </p>

      <p className="eyebrow" style={{ marginTop: 14 }}>
        Вид
      </p>
      <div className="chips">
        {MACHINE_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            className={`chip ${kind === k ? "active" : ""}`}
            onClick={() => сменитьВид(k)}
            disabled={pending || kind === k}
          >
            {MACHINE_KIND_LABELS[k]}
          </button>
        ))}
      </div>

      <p className="eyebrow" style={{ marginTop: 14 }}>
        Состояние
      </p>
      <div className="chips">
        {MACHINE_STATUSES.map((st) => (
          <button
            key={st}
            type="button"
            className={`chip ${текущее === st ? "active" : ""}`}
            onClick={() => применить(st)}
            disabled={pending || текущее === st}
          >
            {MACHINE_STATUS_LABELS[st]}
          </button>
        ))}
      </div>

      <div className="form" style={{ marginTop: 12 }}>
        {places.length > 0 && (
          <label>
            Куда ставим
            <select value={placeId} onChange={(e) => setPlaceId(e.target.value)} disabled={pending}>
              {/*
                Пусто — не «никуда», а «не записано». Уход из эксплуатации
                снимает автомат с точки в любом случае: «в ремонте» и «стоит на
                точке продаж» разом не бывает. Место указывают, когда знают —
                мастерская, свой склад, слово владельца: «места ремонта могут
                быть разные».
              */}
              <option value="">— место не указывать —</option>
              {places.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {placeTypeLabel(p.type).toLowerCase()}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Причина / примечание
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="заявка №12, ждём плату"
            disabled={pending}
          />
        </label>
      </div>

      {!вРаботе && (
        <p className="hint" style={{ marginTop: 10 }}>
          При возврате в эксплуатацию сроки нормативов пересчитаются от сегодня:
          пока автомат стоял, срок капал впустую, и без пересчёта он вернулся бы
          сразу просроченным.
        </p>
      )}

      {msg && (
        <p className={msg.ok ? "ok-text" : "err-text"} style={{ marginTop: 10 }}>
          {msg.text}
        </p>
      )}
    </div>
  );
}
