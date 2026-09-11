"use client";

import { useState, useTransition } from "react";
import {
  MACHINE_KINDS,
  MACHINE_KIND_LABELS,
  machineIsOperational,
  machineStatusLabel,
  type MachineKind,
} from "@mydon/shared";
import { setMachineKind } from "../app/card/actions";

/**
 * Карточка автомата: ВИД.
 *
 * До этого экрана вид проставлял только массовый прогон, а состояние — вообще
 * ничего: автомат уезжал в ремонт, и система об этом не узнавала, продолжая
 * слать технику работы по графику.
 *
 * СОСТОЯНИЕ И МЕСТО ОТСЮДА УБРАНЫ (решение владельца 09.09.2026). Они
 * записывались здесь ОДНОЙ кнопкой — пилюлей состояния, которая тащила с собой
 * поле «Куда ставим». У этого было три следствия, и все плохие: поле «Куда
 * ставим» само по себе не сохранялось (владелец выбирал место, уходил, и
 * ничего не происходило); переставить работающий автомат с точки на точку было
 * нельзя вовсе — пилюля текущего состояния отключена, а другой кнопки нет; и
 * наоборот, смена состояния без выбора места молча закрывала период
 * размещения, оставляя «локация не записана» у полностью заполненной карточки.
 *
 * Теперь «где стоит» — одна форма на вкладке «Локация»: место, состояние и
 * причина сохраняются вместе, как они и лежат в данных (одна транзакция
 * `setMachineStatus` в Core). Здесь остался вид: его называют один раз при
 * заведении, и от места он не зависит.
 */
export function MachineCardPanel({
  id,
  kind,
  status,
  statusNote,
  statusChangedAt,
  updatedBy,
}: {
  id: string;
  kind: string | null;
  status: string | null;
  statusNote: string | null;
  statusChangedAt: string | null;
  updatedBy: string | null;
}) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const вРаботе = machineIsOperational(status);
  const since = statusChangedAt
    ? new Date(statusChangedAt).toLocaleDateString("ru-RU", { timeZone: "Asia/Tashkent" })
    : null;

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

      {/* Состояние живёт вместе с местом — одной формой на вкладке «Локация».
          Здесь на него только ссылка: два входа в одни данные и дали ту самую
          рассинхронизацию «стоит на точке, но в ремонте». */}
      <div className="row mc-attn" data-mc-tab="place" role="button" tabIndex={0}>
        <div className="t">
          <b>Состояние и место</b>
          <small>
            {machineStatusLabel(status)}
            {statusNote ? ` · ${statusNote}` : ""} — меняются вместе на вкладке «Локация»
          </small>
        </div>
        <span className="pill">изменить →</span>
      </div>

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

      {msg && (
        <p className={msg.ok ? "ok-text" : "err-text"} style={{ marginTop: 10 }}>
          {msg.text}
        </p>
      )}
    </div>
  );
}
