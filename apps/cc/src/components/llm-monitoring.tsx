import type { LlmLedgerMonitoring } from "../lib/core";

const TASHKENT_TZ = "Asia/Tashkent";

function formatUsd(value: number): string {
  const absolute = Math.abs(value);
  if (absolute > 0 && absolute < 0.000001) return value < 0 ? "> -$0.000001" : "< $0.000001";

  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  })}`;
}

function formatDateTime(value: string | null): string {
  if (value === null) return "время неизвестно";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "время неизвестно";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: TASHKENT_TZ,
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function latestStatus(status: "settled" | "failed"): string {
  return status === "settled" ? "завершён" : "ошибка";
}

function latestCost(latest: LlmLedgerMonitoring["latestCompleted"]): {
  value: string;
  detail: string;
} {
  if (latest === null) {
    return { value: "—", detail: "стоимость появится после первого завершённого вызова" };
  }
  if (latest.costUsd === null || latest.costBasis === "unknown") {
    return { value: "неизвестно", detail: "провайдер не вернул итоговую стоимость" };
  }
  if (latest.costBasis === "lower_bound") {
    const value = formatUsd(latest.costUsd);
    return { value: `≥ ${value}`, detail: `минимум ${value}, итог неизвестен` };
  }
  if (latest.costBasis === "upper_bound") {
    const value = formatUsd(latest.costUsd);
    return {
      value: `≤ ${value}`,
      detail: `не больше ${value}, разбивка cache 5m/1h неизвестна`,
    };
  }
  if (latest.costBasis === "estimate") {
    const value = formatUsd(latest.costUsd);
    return { value: `≈ ${value}`, detail: `оценка ${value}, точный итог неизвестен` };
  }
  return {
    value: formatUsd(latest.costUsd),
    detail: `итоговая стоимость · ${formatDateTime(latest.completedAt)}`,
  };
}

function lastFailureDetails(failures: LlmLedgerMonitoring["failuresToday"]): string {
  if (failures.last === null) return "За день ошибок не зафиксировано.";
  const model = failures.last.resolvedModel ?? failures.last.requestedModel;
  const reason = failures.last.reason?.trim();
  return [
    `Последняя: ${model}`,
    formatDateTime(failures.last.failedAt),
    reason && reason.length > 0 ? reason : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

export function LlmMonitoring({ monitoring }: { monitoring: LlmLedgerMonitoring | null }) {
  if (monitoring === null) {
    return (
      <section className="llm-monitoring" aria-labelledby="llm-monitoring-title">
        <h2 className="section-title" id="llm-monitoring-title">
          LLM-мониторинг
        </h2>
        <div className="notice llm-monitoring-unavailable" role="status">
          <b>LLM-мониторинг: не проверили</b>
          <span>
            Core не вернул снимок ledger. Настройки ниже доступны, но текущий расход и защитные
            ограничения нужно проверить позже.
          </span>
        </div>
      </section>
    );
  }

  const { budget, failuresToday, latestCompleted, openCircuits, stuckReservations } = monitoring;
  const model = latestCompleted?.resolvedModel ?? latestCompleted?.requestedModel ?? "—";
  const cost = latestCost(latestCompleted);
  const cap = budget.globalCapUsd;
  const exposure = budget.globalExposureUsd;
  const utilization = cap > 0 ? (exposure / cap) * 100 : null;
  const progressMax = cap > 0 ? cap : 1;
  const progressValue = cap > 0 ? Math.min(Math.max(exposure, 0), cap) : exposure > 0 ? 1 : 0;
  const budgetHot = cap > 0 ? exposure >= cap : exposure > 0;
  const utilizationLabel =
    utilization !== null && utilization > 0 && utilization < 1
      ? "<1%"
      : `${Math.round(utilization ?? 0)}%`;
  const railStatus = budget.configError
    ? "защита закрыта"
    : cap === 0
      ? "лимит $0.00"
      : utilizationLabel;

  return (
    <section className="llm-monitoring" aria-labelledby="llm-monitoring-title">
      <div className="llm-monitoring-head">
        <div>
          <h2 className="section-title" id="llm-monitoring-title">
            LLM-мониторинг
          </h2>
          <p>Единый ledger платных вызовов · сутки по Ташкенту</p>
        </div>
        <span className="llm-monitoring-day">{monitoring.day}</span>
      </div>

      <div className="tiles llm-monitoring-kpis">
        <div className={`tile mini${budgetHot ? " is-hot" : ""}`}>
          <div className="lab">Учтённый расход</div>
          <div className="v">{formatUsd(budget.knownCostUsd)}</div>
          <div className="foot">
            Факт/граница · экспозиция {formatUsd(exposure)} · резерв {formatUsd(budget.reservedUsd)}
          </div>
        </div>

        <div className={`tile mini${budget.configError ? " is-hot" : ""}`}>
          <div className="lab">Остаток на день</div>
          <div className="v">{formatUsd(budget.remainingUsd)}</div>
          <div className="foot">
            {budget.configError
              ? "лимит некорректен — новые расходы заблокированы"
              : `из лимита ${formatUsd(cap)}`}
          </div>
        </div>

        <div
          className={`tile mini llm-kpi-model${latestCompleted?.status === "failed" ? " is-hot" : ""}`}
        >
          <div className="lab">Последняя модель</div>
          <div className="v">{model}</div>
          <div className="foot">
            {latestCompleted === null
              ? "завершённых вызовов нет"
              : `${latestCompleted.provider} · ${latestStatus(latestCompleted.status)}`}
          </div>
        </div>

        <div className={`tile mini${latestCompleted?.status === "failed" ? " is-hot" : ""}`}>
          <div className="lab">Последняя стоимость</div>
          <div className="v">{cost.value}</div>
          <div className="foot">{cost.detail}</div>
        </div>
      </div>

      <div className={`llm-budget-rail${budgetHot ? " is-hot" : ""}`}>
        <div className="llm-budget-rail-copy">
          <span>Дневная экспозиция</span>
          <b>{railStatus}</b>
        </div>
        <progress
          aria-label="Дневная экспозиция LLM-бюджета"
          max={progressMax}
          value={progressValue}
        />
      </div>

      {budget.configError && (
        <div className="notice llm-monitoring-config-error" role="alert">
          <b>Бюджет закрыт защитой</b>
          {budget.configError}
        </div>
      )}

      <div className="rows llm-monitoring-diagnostics">
        <div className="row">
          <div className="t">
            <b>Зависшие резервы</b>
            <small>
              {stuckReservations.count === 0
                ? `Нет резервов старше ${stuckReservations.thresholdMinutes} мин.`
                : `Резерв ${formatUsd(stuckReservations.reservedUsd)} · старейший ${formatDateTime(
                    stuckReservations.oldestReservedAt,
                  )} · порог ${stuckReservations.thresholdMinutes} мин.`}
            </small>
          </div>
          <span className={`pill ${stuckReservations.count === 0 ? "ok" : "bad"}`}>
            {stuckReservations.count === 0 ? "нет" : stuckReservations.count}
          </span>
        </div>

        <div className="row">
          <div className="t">
            <b>Ошибки за день</b>
            <small>
              Провайдер: {failuresToday.providerErrorCount} · неизвестный исход:{" "}
              {failuresToday.unknownCount}
            </small>
            <small>{lastFailureDetails(failuresToday)}</small>
          </div>
          <span className={`pill ${failuresToday.count === 0 ? "ok" : "bad"}`}>
            {failuresToday.count === 0 ? "нет" : failuresToday.count}
          </span>
        </div>

        <div className="row llm-circuit-row">
          <div className="t">
            <b>Circuit</b>
            {openCircuits.length === 0 ? (
              <small>Открытых circuit нет.</small>
            ) : (
              <div className="llm-circuit-list">
                {openCircuits.map((circuit) => (
                  <div
                    className="llm-circuit-entry"
                    key={`${circuit.provider}-${circuit.openedAt}`}
                  >
                    <code>{circuit.provider}</code>
                    <span>{circuit.reason?.trim() || "Причина не указана"}</span>
                    <small>
                      открыт {formatDateTime(circuit.openedAt)} · повтор после{" "}
                      {formatDateTime(circuit.resetsAt)}
                    </small>
                  </div>
                ))}
              </div>
            )}
          </div>
          <span className={`pill ${openCircuits.length === 0 ? "ok" : "bad"}`}>
            {openCircuits.length === 0 ? "закрыт" : `открыт · ${openCircuits.length}`}
          </span>
        </div>
      </div>

      <p className="hint llm-monitoring-generated">
        Снимок Core: {formatDateTime(monitoring.generatedAt)}
      </p>
    </section>
  );
}
