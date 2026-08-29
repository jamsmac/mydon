import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CoreLlmLedgerClient,
  LlmBudgetDeniedError,
  LlmLedgerUnavailableError,
  LlmReplayBlockedError,
  inputTokenCeiling,
  isLlmLedgerBlockingError,
} from "./llm-ledger";

const request = {
  requestKey: "cc:123:assistant:1",
  traceKey: "cc:123",
  consumer: "cc" as const,
  feature: "assistant",
  provider: "anthropic",
  model: "claude-opus-5",
  inputTokenCeiling: 2_500,
  outputTokenCeiling: 512,
};

describe("CoreLlmLedgerClient", () => {
  it("возвращает reservation и передаёт service token", async () => {
    let serviceHeader: string | null = null;
    const client = new CoreLlmLedgerClient({
      baseUrl: "http://core/",
      serviceToken: "secret",
      fetchImpl: async (_url, init) => {
        serviceHeader = new Headers(init?.headers).get("x-service-token");
        return new Response(
          JSON.stringify({
            allowed: true,
            status: "reserved",
            action: "pause",
            reservation: {
              id: "3a997edd-cab2-4df1-8148-f46c73617129",
              requestKey: request.requestKey,
              day: "2026-08-29",
              reservedUsd: 0.0253,
              replay: false,
            },
            budget: {
              day: "2026-08-29",
              globalCapUsd: 5,
              globalExposureUsd: 0.0253,
              remainingUsd: 4.9747,
            },
          }),
          { status: 200 },
        );
      },
    });

    const reservation = await client.reserve(request);
    assert.equal(reservation.reservedUsd, 0.0253);
    assert.equal(serviceHeader, "secret");
  });

  it("типизированно запрещает платный fallback при исчерпанном бюджете", async () => {
    const client = new CoreLlmLedgerClient({
      baseUrl: "http://core",
      serviceToken: "secret",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            allowed: false,
            status: "denied",
            action: "ask",
            reason: "дневной потолок исчерпан",
            budget: {
              day: "2026-08-29",
              globalCapUsd: 5,
              globalExposureUsd: 5,
              remainingUsd: 0,
            },
          }),
          { status: 200 },
        ),
    });

    await assert.rejects(
      () => client.reserve(request),
      (error: unknown) =>
        error instanceof LlmBudgetDeniedError &&
        error.action === "ask" &&
        isLlmLedgerBlockingError(error),
    );
  });

  it("типизированно отличает закрытый replay от временной недоступности", async () => {
    const client = new CoreLlmLedgerClient({
      baseUrl: "http://core",
      serviceToken: "secret",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            allowed: false,
            status: "settled",
            action: "pause",
            replayBlocked: true,
            reason: "requestKey уже закрыт статусом settled",
            budget: {
              day: "2026-08-29",
              globalCapUsd: 5,
              globalExposureUsd: 0.01,
              remainingUsd: 4.99,
            },
          }),
          { status: 200 },
        ),
    });

    await assert.rejects(
      () => client.reserve(request),
      (error: unknown) =>
        error instanceof LlmReplayBlockedError &&
        error.requestKey === request.requestKey &&
        isLlmLedgerBlockingError(error),
    );
  });

  it("не принимает несовместимый или не-JSON ответ Core", async () => {
    const client = new CoreLlmLedgerClient({
      baseUrl: "http://core",
      serviceToken: "secret",
      fetchImpl: async () => new Response("proxy failure", { status: 502 }),
    });
    await assert.rejects(() => client.reserve(request), LlmLedgerUnavailableError);
  });

  it("типизирует отказ чтения response body как недоступность ledger", async () => {
    const response = new Response(null, { status: 200 });
    Object.defineProperty(response, "text", {
      value: async () => {
        throw new Error("body stream aborted");
      },
    });
    const client = new CoreLlmLedgerClient({
      baseUrl: "http://core",
      serviceToken: "secret",
      fetchImpl: async () => response,
    });

    await assert.rejects(
      () => client.reserve(request),
      (error: unknown) =>
        error instanceof LlmLedgerUnavailableError &&
        error.cause instanceof Error &&
        error.cause.message === "body stream aborted",
    );
  });
});

describe("inputTokenCeiling", () => {
  it("считает UTF-8 байты и протокольный запас", () => {
    assert.equal(inputTokenCeiling("abc", 10), 13);
    assert.equal(inputTokenCeiling("я", 0), 2);
  });
});
