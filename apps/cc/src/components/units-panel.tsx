"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  SALES_STAGE_LABELS,
  SALES_STAGES,
  UNIT_GROUPS,
  UNIT_STATUS_LABELS,
  UNIT_TRANSITIONS,
  type SalesStage,
  type UnitStatus,
} from "@mydon/shared";
import type { FinanceCounterparty, GrUnit } from "../lib/core";
import {
  cancelUnitReserve,
  createUnit,
  reserveUnit,
  setUnitSalesStage,
  setUnitVin,
  unitAction,
} from "../app/units/actions";

/**
 * Склад техники GLOBERENT — конвейер 17 статусов (перенос WarehouseModule
 * PROMACH). Кнопки действий строятся из единой матрицы переходов shared:
 * невозможных кнопок просто нет, а Core всё равно перепроверит.
 */

const nfmt = (v: string | number): string => Number(v).toLocaleString("ru-RU");

/** Действия, доступные из данного статуса — прямо из матрицы. */
function actionsFor(status: string): { action: string; label: string }[] {
  return Object.entries(UNIT_TRANSITIONS)
    .filter(([, t]) => (t.from as readonly string[]).includes(status))
    .map(([action, t]) => ({ action, label: t.label }));
}

function UnitRow({ unit, clients }: { unit: GrUnit; clients: FinanceCounterparty[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<string | null>(null); // action, требующее доп. полей

  const run = (fn: () => Promise<{ ok: boolean; message?: string }>) =>
    start(async () => {
      const res = await fn();
      setError(res.ok ? null : (res.message ?? "Не получилось"));
      if (res.ok) {
        setAsk(null);
        router.refresh();
      }
    });

  const acts = actionsFor(unit.status);
  const needsExtra = (a: string): boolean =>
    a === "mark-in-transit" || a === "mark-customs-im74" || a === "mark-customs-im40";

  return (
    <div className="trow" style={{ flexWrap: "wrap" }}>
      <div className="tb" style={{ minWidth: 220 }}>
        <div className="tt">
          {unit.code} · {unit.name}
          {unit.year !== null ? `, ${unit.year} г.` : ""}
        </div>
        <div className="tm">
          {UNIT_STATUS_LABELS[unit.status as UnitStatus] ?? unit.status}
          {unit.vin !== null ? ` · VIN ${unit.vin}` : " · VIN не привязан"}
          {unit.salesPrice !== null ? ` · цена ${nfmt(unit.salesPrice)} сум` : ""}
          {unit.costUzs > 0 ? ` · себестоимость ≈ ${nfmt(unit.costUzs)} сум` : ""}
          {unit.costUzs > 0 && unit.salesPrice !== null && Number(unit.salesPrice) > 0
            ? ` · маржа ${Math.round(((Number(unit.salesPrice) - unit.costUzs) / Number(unit.salesPrice)) * 100)}%`
            : ""}
          {unit.salesStage !== null
            ? ` · продажа: ${SALES_STAGE_LABELS[unit.salesStage as SalesStage] ?? unit.salesStage}`
            : ""}
          {unit.activeReserve !== null ? ` · резерв до ${unit.activeReserve.endDate}` : ""}
          {unit.clientName !== null ? ` · ${unit.clientName}` : ""}
        </div>
        {error !== null && <div className="err-text" style={{ marginTop: 4 }}>{error}</div>}
      </div>
      <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {acts.map(({ action, label }) => (
          <button
            key={action}
            type="button"
            className="btn sm"
            disabled={pending}
            onClick={() => {
              if (needsExtra(action)) setAsk(ask === action ? null : action);
              else run(() => unitAction(unit.id, action));
            }}
          >
            {label}
          </button>
        ))}
        {unit.vin === null && unit.status !== "CANCELLED" && (
          <button
            type="button"
            className="btn sm"
            disabled={pending}
            onClick={() => {
              const vin = window.prompt("VIN:");
              if (vin !== null && vin.trim() !== "") run(() => setUnitVin(unit.id, vin.trim()));
            }}
          >
            + VIN
          </button>
        )}
        {(unit.status === "IN_STOCK" || unit.status === "DELIVERED_TO_WH") && (
          <button type="button" className="btn sm" disabled={pending} onClick={() => setAsk(ask === "reserve" ? null : "reserve")}>
            резерв
          </button>
        )}
        {unit.status === "RESERVED" && (
          <button type="button" className="btn sm" disabled={pending} onClick={() => run(() => cancelUnitReserve(unit.id))}>
            снять резерв
          </button>
        )}
        {unit.salesStage === null &&
          ["IN_STOCK", "DELIVERED_TO_WH", "RESERVED"].includes(unit.status) && (
            <button
              type="button"
              className="btn sm"
              disabled={pending}
              onClick={() => run(() => setUnitSalesStage(unit.id, "NEW_LEAD"))}
            >
              начать продажу
            </button>
          )}
        {unit.salesStage !== null && unit.salesStage !== "CLOSED" && unit.salesStage !== "LOST" && (
          <select
            className="btn sm"
            disabled={pending}
            value={unit.salesStage}
            onChange={(e) => {
              const stage = e.target.value;
              if (stage === "LOST") {
                const reason = window.prompt("Причина потери сделки:");
                if (reason !== null && reason.trim() !== "") {
                  run(() => setUnitSalesStage(unit.id, stage, { lostReason: reason.trim() }));
                }
              } else {
                run(() => setUnitSalesStage(unit.id, stage));
              }
            }}
          >
            {SALES_STAGES.map((s) => (
              <option value={s} key={s}>{SALES_STAGE_LABELS[s]}</option>
            ))}
          </select>
        )}
      </span>

      {/* Доп. поля перехода: перевозчик или ГТД */}
      {ask !== null && ask !== "reserve" && (
        <form
          className="form"
          style={{ width: "100%", display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", marginTop: 8 }}
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const extra: Record<string, string> = {};
            for (const key of ["transportCompany", "declarationNumber", "declarationDate"]) {
              const v = String(form.get(key) ?? "").trim();
              if (v !== "") extra[key] = v;
            }
            run(() => unitAction(unit.id, ask, extra));
          }}
        >
          {ask === "mark-in-transit" ? (
            <label style={{ margin: 0 }}>
              <span>Перевозчик</span>
              <input name="transportCompany" autoFocus />
            </label>
          ) : (
            <>
              <label style={{ margin: 0 }}>
                <span>Номер ГТД</span>
                <input name="declarationNumber" autoFocus />
              </label>
              <label style={{ margin: 0 }}>
                <span>Дата ГТД</span>
                <input name="declarationDate" type="date" />
              </label>
            </>
          )}
          <button type="submit" className="btn sm" disabled={pending}>Подтвердить</button>
        </form>
      )}

      {/* Резерв: до какой даты и под кого */}
      {ask === "reserve" && (
        <form
          className="form"
          style={{ width: "100%", display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", marginTop: 8 }}
          onSubmit={(event) => {
            event.preventDefault();
            run(() => reserveUnit(unit.id, new FormData(event.currentTarget)));
          }}
        >
          <label style={{ margin: 0 }}>
            <span>Держим до</span>
            <input name="endDate" type="date" autoFocus />
          </label>
          <label style={{ margin: 0 }}>
            <span>Клиент</span>
            <select name="clientId" defaultValue="">
              <option value="">—</option>
              {clients.map((c) => (
                <option value={c.id} key={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <label style={{ margin: 0 }}>
            <span>Заметка</span>
            <input name="note" />
          </label>
          <button type="submit" className="btn sm" disabled={pending}>Поставить резерв</button>
        </form>
      )}
    </div>
  );
}

export function UnitsPanel({
  units,
  summary,
  clients,
}: {
  units: GrUnit[];
  summary: { key: string; label: string; n: number }[];
  clients: FinanceCounterparty[];
}) {
  const router = useRouter();
  const [group, setGroup] = useState<string>("all");
  const [openNew, setOpenNew] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const groupDef = UNIT_GROUPS.find((g) => g.key === group);
  const visible =
    groupDef === undefined
      ? units
      : units.filter((u) => (groupDef.statuses as readonly string[]).includes(u.status));

  return (
    <>
      <div className="subtabs">
        <button type="button" className={`subtab ${group === "all" ? "active" : ""}`} onClick={() => setGroup("all")}>
          Все ×{units.length}
        </button>
        {summary.map((s) => (
          <button
            key={s.key}
            type="button"
            className={`subtab ${group === s.key ? "active" : ""} ${s.n === 0 ? "dim" : ""}`}
            onClick={() => setGroup(s.key)}
          >
            {s.label}
            {s.n > 0 ? ` ×${s.n}` : ""}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="empty">
          <b>В этой группе пусто</b>
          Заведи заявку или поставь свою технику на склад кнопкой ниже. Единицы из
          импортных контрактов появятся здесь сами, когда переедет импортный контур.
        </div>
      ) : (
        <div>{visible.map((u) => <UnitRow unit={u} clients={clients} key={u.id} />)}</div>
      )}

      {!openNew ? (
        <button type="button" className="btn" style={{ marginTop: 10 }} onClick={() => setOpenNew(true)}>
          + Единица техники
        </button>
      ) : (
        <form
          className="form card"
          style={{ marginTop: 10 }}
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            start(async () => {
              const res = await createUnit(form);
              setError(res.ok ? null : (res.message ?? "Не получилось"));
              if (res.ok) {
                setOpenNew(false);
                router.refresh();
              }
            });
          }}
        >
          <label>
            <span>Название (модель, комплектация)</span>
            <input name="name" placeholder="HELI CPCD30, вилы 1.2 м" autoFocus />
          </label>
          <label>
            <span>Год выпуска</span>
            <input name="year" inputMode="numeric" placeholder="2026" />
          </label>
          <label>
            <span>VIN — если уже известен</span>
            <input name="vin" />
          </label>
          <label>
            <span>Цена продажи, сум — можно позже</span>
            <input name="salesPrice" inputMode="numeric" />
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" name="inStock" defaultChecked />
            <span>уже на складе (иначе — заявка в конвейер импорта)</span>
          </label>
          <div className="form-actions">
            <button type="submit" className="btn primary" disabled={pending}>
              {pending ? "…" : "Добавить"}
            </button>
            <button type="button" className="btn" onClick={() => setOpenNew(false)}>
              Отмена
            </button>
            {error && <span className="err-text">{error}</span>}
          </div>
        </form>
      )}
      <p className="hint" style={{ marginTop: 10 }}>
        Кнопки действий строятся из матрицы переходов донора (fromStatuses): невозможных
        переходов в интерфейсе нет, а Core перепроверяет матрицу и гонки на записи.
      </p>
    </>
  );
}
