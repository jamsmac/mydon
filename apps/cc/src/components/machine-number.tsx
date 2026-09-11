"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { machineNoProblem, machineSeriesOf } from "@mydon/shared";
import { setMachineNumber } from "../app/card/actions";

/**
 * Инвентарный номер автомата (волна 3, М-6…М-8, М-12). Номер присваивает
 * система, наклейка догоняет: пока сотрудник не подтвердил, что номер на
 * автомате, он висит в очереди «наклеить номер». Вписать свой — если на
 * автомате уже другая наклейка: тогда наклейка есть по определению.
 */
export function MachineNumber({
  machineId,
  kind,
  inventoryNo,
  labelPending,
}: {
  machineId: string;
  kind: string | null;
  inventoryNo: string | null;
  labelPending: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [edit, setEdit] = useState(false);
  const [value, setValue] = useState(inventoryNo ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const series = machineSeriesOf(kind);

  const run = (input: { inventoryNo?: string | null; confirmLabel?: boolean }, done: string) =>
    start(async () => {
      setMsg(null);
      const res = await setMachineNumber(machineId, input);
      if (res.ok) {
        setMsg({ ok: true, text: done });
        setEdit(false);
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error ?? "Не получилось" });
      }
    });

  const save = () => {
    const problem = machineNoProblem(kind ?? "", value);
    if (problem) {
      setMsg({ ok: false, text: problem });
      return;
    }
    run({ inventoryNo: value }, "Номер сохранён");
  };

  if (!series) {
    return <p className="hint">Вид автомата не назван или «прочее» — номер не присваивается. Назовите вид.</p>;
  }

  return (
    <div className="form">
      <p>
        {inventoryNo ? (
          <>
            Номер: <b className="mono">{inventoryNo}</b>{" "}
            {labelPending ? <span className="chip h">не наклеен</span> : <span className="chip">наклеен</span>}
          </>
        ) : (
          <span className="hint">Номер ещё не присвоен — присвоение идёт списком в «Автоматах».</span>
        )}
      </p>
      {edit ? (
        <div className="form-actions">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={`${series}-001`}
            className="mono"
            disabled={pending}
            aria-label="Номер автомата"
          />
          <button type="button" className="btn pri" onClick={save} disabled={pending}>
            {pending ? "…" : "Сохранить"}
          </button>
          <button type="button" className="btn ghost" onClick={() => setEdit(false)} disabled={pending}>
            Отмена
          </button>
        </div>
      ) : (
        <div className="form-actions">
          {inventoryNo && labelPending && (
            <button type="button" className="btn pri" onClick={() => run({ confirmLabel: true }, "Наклейка подтверждена")} disabled={pending}>
              Номер наклеен
            </button>
          )}
          <button type="button" className="btn ghost" onClick={() => setEdit(true)} disabled={pending}>
            {inventoryNo ? "На автомате другой номер" : "Вписать номер"}
          </button>
        </div>
      )}
      {msg && <span className={msg.ok ? "ok-text" : "err-text"}>{msg.text}</span>}
    </div>
  );
}
