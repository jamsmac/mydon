"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { linkRawValue } from "../app/sources/actions";
import type { RawMappingGroup, RawMappingValue } from "../lib/core";

export interface RawMappingProps {
  source: string;
  groups: RawMappingGroup[];
  /** Карточки реестра, к которым можно привязать значение источника. */
  cards: { machine: { id: string; name: string }[]; product: { id: string; name: string }[] };
}

/** Одно значение источника: узнали / не узнали / решили не заводить. */
function ValueRow({
  source,
  group,
  value,
  options,
}: {
  source: string;
  group: RawMappingGroup;
  value: RawMappingValue;
  options: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function bind(entityId: string): void {
    start(async () => {
      const res = await linkRawValue(source, group.kind, value.label, entityId);
      if (res.ok) router.refresh();
      else setError(res.error ?? "Не получилось");
    });
  }

  const unresolved = value.entityId === null && !value.dismissed;

  return (
    <div className={`maprow ${unresolved ? "hot" : ""}`}>
      <div className="mapv">
        <span className="mapl mono">{value.label}</span>
        <span className="mapc mono">×{value.count.toLocaleString("ru-RU")}</span>
      </div>
      <div className="mapt">
        {value.entityName ? (
          <>
            <span className="mapok">{value.entityName}</span>
            <span className="chip">{value.decidedBy === "auto" ? "совпало точно" : "связал ты"}</span>
          </>
        ) : value.dismissed ? (
          <span className="hint">карточка не нужна — твоё решение</span>
        ) : (
          <span className="warn">не узнано</span>
        )}
      </div>
      {group.bindable && (
        <select
          className="mapsel"
          disabled={pending}
          value={value.entityId ?? (value.dismissed ? "__none__" : "")}
          onChange={(e) => bind(e.target.value === "__none__" ? "" : e.target.value)}
        >
          <option value="" disabled>
            выбрать карточку…
          </option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
          <option value="__none__">карточка не нужна</option>
        </select>
      )}
      {error && <span className="err-text">{error}</span>}
    </div>
  );
}

/**
 * Сопоставление выгрузки с реестром.
 *
 * Показывает ровно три состояния и не смешивает их: совпало точно, связал
 * владелец, не узнано. Оранжевым — только последнее: это единственное, что
 * требует его решения.
 */
export function RawMapping({ source, groups, cards }: RawMappingProps) {
  const withColumn = groups.filter((g) => g.column !== null);
  if (withColumn.length === 0) {
    return (
      <div className="empty">
        <b>Связывать пока нечего</b>
        Для этого отчёта ещё не описано, какая колонка — автомат, какая — товар.
        Роли колонок задаются после первой выгрузки, когда виден их состав.
      </div>
    );
  }

  return (
    <>
      {withColumn.map((g) => {
        const options = g.kind === "machine" ? cards.machine : g.kind === "product" ? cards.product : [];
        return (
          <div className="sect" key={g.kind} style={{ marginTop: 18 }}>
            <div className="sect-h">
              <h3 className="h2">{g.label}</h3>
              <span className="chip">колонка «{g.column}»</span>
              {g.unmatched > 0 ? (
                <span className="chip h">не узнано · {g.unmatched}</span>
              ) : (
                <span className="chip g">всё узнано</span>
              )}
            </div>
            {g.values.length === 0 ? (
              <div className="empty">
                <b>В снимке нет значений этой колонки</b>
                Источник отдал её пустой — связывать нечего.
              </div>
            ) : (
              <>
                {!g.bindable && (
                  <p className="hint" style={{ marginBottom: 8 }}>
                    Точка узнаётся по карточке автомата: отдельных карточек точек в реестре пока нет.
                    Незнакомый адрес — повод дозаполнить «точку» в карточке автомата.
                  </p>
                )}
                <div className="maplist">
                  {g.values.map((v) => (
                    <ValueRow key={v.key} source={source} group={g} value={v} options={options} />
                  ))}
                </div>
              </>
            )}
          </div>
        );
      })}
    </>
  );
}
