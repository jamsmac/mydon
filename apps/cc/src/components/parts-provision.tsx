"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { provisionParts } from "../app/parts/actions";

interface Report {
  dryRun: boolean;
  machines: { machineName: string; created: string[]; existing: number; hopperSetsFound: number; numbered?: string[] }[];
  createdTotal: number;
  numberedTotal?: number;
}

/**
 * Автозаведение узлов по составу (R-PU-3): сначала предпросмотр — что заведём
 * каждому автомату, потом заведение. Повтор безопасен: ничего не дублируется.
 *
 * Работы у прогона ДВЕ: завести недостающие узлы и присвоить номер стоящим без
 * номера (узлы из бэкфилла журнала). Кнопка и текст считают обе: на полном
 * парке заводить нечего, а номеров может ждать полторы сотни узлов — «состав
 * полный» без второй половины было бы неправдой.
 */
export function ProvisionButton({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run(dryRun: boolean) {
    start(async () => {
      const res = await provisionParts(dryRun);
      if (!res.ok) {
        setError(res.error ?? "Ошибка");
        return;
      }
      setError(null);
      setReport(res.report as Report);
      if (!dryRun) router.refresh();
    });
  }

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 8 }}>
      <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className={compact ? "btn sm" : "btn"} disabled={pending} onClick={() => run(true)}>
          {pending ? "Считаю…" : "Посмотреть, что заведётся"}
        </button>
        {report?.dryRun && report.createdTotal + (report.numberedTotal ?? 0) > 0 && (
          <button type="button" className={compact ? "btn sm primary" : "btn primary"} disabled={pending} onClick={() => run(false)}>
            {[
              report.createdTotal > 0 ? `Завести ${report.createdTotal} узлов` : null,
              (report.numberedTotal ?? 0) > 0 ? `присвоить ${report.numberedTotal} номеров` : null,
            ]
              .filter(Boolean)
              .join(" и ")}
          </button>
        )}
      </span>
      {error && <span className="err-text">{error}</span>}
      {report && (
        <span className="hint">
          {report.dryRun ? "План: " : "Сделано: "}
          {report.createdTotal + (report.numberedTotal ?? 0) === 0
            ? "нечего заводить и нумеровать — состав полный, номера у всех"
            : report.machines
                .filter((m) => m.created.length > 0 || (m.numbered?.length ?? 0) > 0)
                .map((m) =>
                  [
                    m.machineName,
                    [
                      m.created.length > 0 ? `${m.created.length} завести` : null,
                      (m.numbered?.length ?? 0) > 0 ? `${m.numbered!.length} номеров` : null,
                    ]
                      .filter(Boolean)
                      .join(", ") + (m.hopperSetsFound ? ` (наборов найдено ${m.hopperSetsFound})` : ""),
                  ].join(" — "),
                )
                .join(" · ")}
        </span>
      )}
    </span>
  );
}
