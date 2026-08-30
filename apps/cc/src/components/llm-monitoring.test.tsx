import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LlmLedgerMonitoring } from "../lib/core";
import { LlmMonitoring } from "./llm-monitoring";

const monitoring: LlmLedgerMonitoring = {
  generatedAt: "2026-08-30T06:35:00.000Z",
  day: "2026-08-30",
  budget: {
    globalCapUsd: 10,
    knownCostUsd: 0.000123,
    globalExposureUsd: 0.0045,
    reservedUsd: 0.0034,
    remainingUsd: 9.9955,
  },
  latestCompleted: {
    provider: "openai",
    consumer: "agents",
    feature: "daily-briefing",
    requestedModel: "gpt-5.6-sol",
    resolvedModel: "gpt-5.6-luna",
    status: "settled",
    outcome: "success",
    costUsd: 0.000456,
    costBasis: "actual",
    completedAt: "2026-08-30T06:34:00.000Z",
  },
  stuckReservations: {
    thresholdMinutes: 5,
    count: 2,
    reservedUsd: 0.0034,
    oldestReservedAt: "2026-08-30T06:20:00.000Z",
  },
  failuresToday: {
    count: 3,
    providerErrorCount: 2,
    unknownCount: 1,
    last: {
      failedAt: "2026-08-30T06:30:00.000Z",
      provider: "openai",
      requestedModel: "gpt-5.6-sol",
      resolvedModel: null,
      outcome: "provider_error",
      reason: "upstream timeout",
    },
  },
  openCircuits: [
    {
      provider: "openai",
      openedAt: "2026-08-30T06:30:00.000Z",
      resetsAt: "2026-08-30T19:00:00.000Z",
      reason: "3 ошибки провайдера за сутки",
    },
  ],
};

describe("LLM-мониторинг", () => {
  it("показывает точные малые суммы, экспозицию и фактически выбранную модель", () => {
    render(<LlmMonitoring monitoring={monitoring} />);

    expect(screen.getByText("$0.000123")).toBeVisible();
    expect(screen.getByText("$9.9955")).toBeVisible();
    expect(screen.getByText("gpt-5.6-luna")).toBeVisible();
    expect(screen.getByText("$0.000456")).toBeVisible();
    expect(screen.getByText(/Факт\/граница/)).toHaveTextContent(
      "Факт/граница · экспозиция $0.0045 · резерв $0.0034",
    );
    expect(screen.getByRole("progressbar", { name: "Дневная экспозиция LLM-бюджета" })).toHaveValue(
      0.0045,
    );
  });

  it("не выдаёт отсутствие завершённых вызовов за нулевую стоимость", () => {
    render(<LlmMonitoring monitoring={{ ...monitoring, latestCompleted: null }} />);

    expect(screen.getByText("завершённых вызовов нет")).toBeVisible();
    expect(screen.getByText("стоимость появится после первого завершённого вызова")).toBeVisible();
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("различает неизвестную стоимость и расчётные границы", () => {
    const { rerender } = render(
      <LlmMonitoring
        monitoring={{
          ...monitoring,
          latestCompleted: {
            ...monitoring.latestCompleted!,
            costUsd: null,
            costBasis: "unknown",
          },
        }}
      />,
    );

    expect(screen.getByText("неизвестно")).toBeVisible();
    expect(screen.getByText("провайдер не вернул итоговую стоимость")).toBeVisible();

    rerender(
      <LlmMonitoring
        monitoring={{
          ...monitoring,
          latestCompleted: {
            ...monitoring.latestCompleted!,
            costUsd: 0.000321,
            costBasis: "lower_bound",
          },
        }}
      />,
    );

    expect(screen.getByText("≥ $0.000321")).toBeVisible();
    expect(screen.getByText("минимум $0.000321, итог неизвестен")).toBeVisible();

    rerender(
      <LlmMonitoring
        monitoring={{
          ...monitoring,
          latestCompleted: {
            ...monitoring.latestCompleted!,
            costUsd: 0.000654,
            costBasis: "upper_bound",
          },
        }}
      />,
    );

    expect(screen.getByText("≤ $0.000654")).toBeVisible();
    expect(screen.getByText("не больше $0.000654, разбивка cache 5m/1h неизвестна")).toBeVisible();

    rerender(
      <LlmMonitoring
        monitoring={{
          ...monitoring,
          latestCompleted: {
            ...monitoring.latestCompleted!,
            costUsd: 0.000987,
            costBasis: "estimate",
          },
        }}
      />,
    );

    expect(screen.getByText("≈ $0.000987")).toBeVisible();
    expect(screen.getByText("оценка $0.000987, точный итог неизвестен")).toBeVisible();
  });

  it("выносит зависшие резервы, ошибки и открытый circuit с причиной", () => {
    render(<LlmMonitoring monitoring={monitoring} />);

    expect(screen.getByText(/Резерв \$0\.0034/)).toBeVisible();
    expect(screen.getByText(/Провайдер: 2 · неизвестный исход: 1/)).toBeVisible();
    expect(screen.getByText(/upstream timeout/)).toBeVisible();
    expect(screen.getByText("openai", { selector: ".llm-circuit-entry code" })).toBeVisible();
    expect(screen.getByText("3 ошибки провайдера за сутки")).toBeVisible();
    expect(screen.getByText(/повтор после/)).toBeVisible();
    expect(screen.getByText("открыт · 1")).toBeVisible();
  });

  it("считает нулевой лимит жёсткой защитой и выдерживает circuit без причины", () => {
    const { container } = render(
      <LlmMonitoring
        monitoring={{
          ...monitoring,
          budget: {
            ...monitoring.budget,
            globalCapUsd: 0,
            globalExposureUsd: 0.0001,
            remainingUsd: 0,
          },
          openCircuits: [{ ...monitoring.openCircuits[0]!, reason: null }],
        }}
      />,
    );

    expect(screen.getByText("лимит $0.00")).toBeVisible();
    expect(screen.getByText("Причина не указана")).toBeVisible();
    expect(container.querySelector(".llm-budget-rail.is-hot")).not.toBeNull();
    expect(screen.getByRole("progressbar", { name: "Дневная экспозиция LLM-бюджета" })).toHaveValue(
      1,
    );
  });

  it("явно сообщает, когда снимок Core получить не удалось", () => {
    render(<LlmMonitoring monitoring={null} />);

    expect(screen.getByRole("status")).toHaveTextContent("LLM-мониторинг: не проверили");
    expect(screen.queryByText("$0.00")).toBeNull();
  });
});
