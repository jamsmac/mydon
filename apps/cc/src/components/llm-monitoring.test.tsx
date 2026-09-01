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
  settlementOutbox: {
    available: true,
    pendingCount: 0,
    retryingCount: 0,
    processingCount: 0,
    deadCount: 0,
    fallbackCount: 0,
    exactCount: 0,
    oldestPendingAt: null,
    nextRetryAt: null,
    maxAttempts: 8,
  },
  openCircuits: [
    {
      provider: "openai",
      openedAt: "2026-08-30T06:30:00.000Z",
      resetsAt: "2026-08-30T19:00:00.000Z",
      reason: "3 ошибки провайдера за сутки",
    },
  ],
  catalogPrice: {
    meteredEnabled: true,
    provider: "openai",
    model: "gpt-5.6-sol",
    hasActivePrice: true,
  },
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

  it("зелёным показывает пустую durable-очередь закрытия", () => {
    const { container } = render(<LlmMonitoring monitoring={monitoring} />);
    const row = container.querySelector(".llm-settlement-outbox-row");

    expect(row).toHaveTextContent("Очередь пуста: все закрывающие операции подтверждены Core");
    expect(row?.querySelector(".pill.ok")).toHaveTextContent("пусто");
    expect(row).toHaveTextContent(
      "Точный итог: 0 · защитный unknown: 0 · на повторе: 0 · потолок попыток: 8",
    );
  });

  it("выносит pending, retry, fallback, exact и dead без id и payload", () => {
    const { container } = render(
      <LlmMonitoring
        monitoring={{
          ...monitoring,
          settlementOutbox: {
            available: true,
            pendingCount: 3,
            retryingCount: 2,
            processingCount: 1,
            deadCount: 1,
            fallbackCount: 2,
            exactCount: 2,
            oldestPendingAt: "2026-08-30T06:20:00.000Z",
            nextRetryAt: "2026-08-30T06:40:00.000Z",
            maxAttempts: 8,
          },
        }}
      />,
    );
    const row = container.querySelector(".llm-settlement-outbox-row");

    expect(row).toHaveTextContent("Ожидают: 3 · на повторе: 2 · в обработке: 1 · неисправимы: 1");
    expect(row).toHaveTextContent(
      "Точный итог: 2 · защитный unknown: 2 · на повторе: 2 · потолок попыток: 8",
    );
    expect(row).toHaveTextContent(/Старейшая: .+ · следующий повтор: .+/);
    expect(row?.querySelector(".pill.bad")).toHaveTextContent("сбой · 1");
    expect(row).not.toHaveTextContent("reservationId");
    expect(row).not.toHaveTextContent("payload");
  });

  it("не выдаёт недоступный spool за пустую очередь", () => {
    const { container } = render(
      <LlmMonitoring
        monitoring={{
          ...monitoring,
          settlementOutbox: { ...monitoring.settlementOutbox, available: false },
        }}
      />,
    );
    const row = container.querySelector(".llm-settlement-outbox-row");

    expect(row).toHaveTextContent("Локальную очередь производителей прочитать не удалось");
    expect(row).toHaveTextContent("Нулевые счётчики не означают, что очередь пуста");
    expect(row?.querySelector(".pill.bad")).toHaveTextContent("не проверен");
    expect(row).not.toHaveTextContent("Очередь пуста:");
  });

  it("считает retrying запись работающей очередью, даже когда новых pending нет", () => {
    const { container } = render(
      <LlmMonitoring
        monitoring={{
          ...monitoring,
          settlementOutbox: {
            ...monitoring.settlementOutbox,
            retryingCount: 1,
            maxAttempts: 32,
          },
        }}
      />,
    );
    const row = container.querySelector(".llm-settlement-outbox-row");

    expect(row?.querySelector(".pill:not(.ok):not(.bad)")).toHaveTextContent("в очереди · 1");
    expect(row).not.toHaveTextContent("Очередь пуста:");
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

  it("тревожит, когда LLM включён, но у модели нет действующей цены", () => {
    const { container } = render(
      <LlmMonitoring
        monitoring={{
          ...monitoring,
          catalogPrice: {
            meteredEnabled: true,
            provider: "openai",
            model: "gpt-5.6-sol",
            hasActivePrice: false,
          },
        }}
      />,
    );

    expect(screen.getByText("LLM включён, но вызовы отклоняются")).toBeVisible();
    const row = container.querySelector(".llm-catalog-price-row");
    expect(row).toHaveTextContent("openai/gpt-5.6-sol");
    expect(row).toHaveTextContent("действующей цены нет — вызовы будут отклонены");
    expect(row?.querySelector(".pill.bad")).toHaveTextContent("нет цены");
  });

  it("не тревожит, когда у выбранной модели есть действующая цена", () => {
    const { container } = render(<LlmMonitoring monitoring={monitoring} />);

    expect(screen.queryByText("LLM включён, но вызовы отклоняются")).toBeNull();
    const row = container.querySelector(".llm-catalog-price-row");
    expect(row).toHaveTextContent("действующая цена есть");
    expect(row?.querySelector(".pill.ok")).toHaveTextContent("есть");
  });

  it("при выключенном метрируемом маршруте отсутствие цены не тревога", () => {
    const { container } = render(
      <LlmMonitoring
        monitoring={{
          ...monitoring,
          catalogPrice: {
            meteredEnabled: false,
            provider: "openai",
            model: "gpt-5.6-sol",
            hasActivePrice: false,
          },
        }}
      />,
    );

    expect(screen.queryByText("LLM включён, но вызовы отклоняются")).toBeNull();
    const row = container.querySelector(".llm-catalog-price-row");
    expect(row).toHaveTextContent("метрируемый маршрут выключен");
    expect(row?.querySelector(".pill")).toHaveTextContent("не требуется");
  });

  it("явно сообщает, когда снимок Core получить не удалось", () => {
    render(<LlmMonitoring monitoring={null} />);

    expect(screen.getByRole("status")).toHaveTextContent("LLM-мониторинг: не проверили");
    expect(screen.queryByText("$0.00")).toBeNull();
  });
});
