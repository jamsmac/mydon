"use client";

import { useEffect, useState } from "react";
import { isWeighBasis, WEIGH_BASES, WEIGH_BASIS_LABELS, type WeighBasis } from "@mydon/shared";

const STORE = "mydon.weigh.basis";

/**
 * Последний выбор «с крышкой / без крышки» — на этом устройстве.
 *
 * Смена обычно мерит подряд одинаково: где стоят весы, там и снимают крышку
 * (или не снимают). Спрашивать одно и то же двадцать раз за день — верный
 * способ получить нажатие не глядя, а значит вранье в данных. Память ЛОКАЛЬНАЯ
 * (не на сервере и не в куке): это привычка конкретного телефона, а не
 * свойство человека или записи.
 *
 * Инициализатор `useState` не читает хранилище намеренно: на сервере его нет,
 * и React отдал бы разную разметку (тот же урок, что в `machines-browser`).
 */
export function useRememberedBasis(): [WeighBasis, (b: WeighBasis) => void] {
  const [basis, setBasis] = useState<WeighBasis>("with_lid");
  useEffect(() => {
    try {
      const v = localStorage.getItem(STORE);
      if (isWeighBasis(v)) setBasis(v);
    } catch {
      // приватный режим — просто не помним
    }
  }, []);
  return [
    basis,
    (b: WeighBasis) => {
      setBasis(b);
      try {
        localStorage.setItem(STORE, b);
      } catch {
        // приватный режим — просто не помним
      }
    },
  ];
}

/** Состояние замера: часть самого замера, а не инструкция технику. */
export function WeighBasisPicker({
  value,
  onChange,
  label = "Взвешено",
  hint,
}: {
  value: WeighBasis;
  onChange: (b: WeighBasis) => void;
  label?: string;
  hint?: string;
}) {
  return (
    <label>
      {label}
      <div className="mb-seg" role="group" aria-label={label}>
        {WEIGH_BASES.map((b) => (
          <button key={b} type="button" className={value === b ? "on" : ""} onClick={() => onChange(b)}>
            {WEIGH_BASIS_LABELS[b]}
          </button>
        ))}
      </div>
      {hint !== undefined && <small className="hint">{hint}</small>}
    </label>
  );
}
