"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { provisionParts } from "../app/parts/actions";

interface Report {
  dryRun: boolean;
  machines: { machineName: string; created: string[]; existing: number; hopperSetsFound: number }[];
  createdTotal: number;
}

/**
 * Автозаведение узлов по составу (R-PU-3): сначала предпросмотр — что заведём
 * каждому автомату, потом заведение. Повтор безопасен: ничего не дублируется.
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
        {report?.dryRun && report.createdTotal > 0 && (
          <button type="button" className={compact ? "btn sm primary" : "btn primary"} disabled={pending} onClick={() => run(false)}>
            Завести {report.createdTotal} узлов
          </button>
        )}
      </span>
      {error && <span className="err-text">{error}</span>}
      {report && (
        <span className="hint">
          {report.dryRun ? "План: " : "Заведено: "}
          {report.createdTotal === 0
            ? "нечего заводить — состав полный"
            : report.machines
                .filter((m) => m.created.length > 0)
                .map((m) => `${m.machineName} — ${m.created.length}${m.hopperSetsFound ? ` (наборов найдено ${m.hopperSetsFound})` : ""}`)
                .join(" · ")}
        </span>
      )}
    </span>
  );
}
