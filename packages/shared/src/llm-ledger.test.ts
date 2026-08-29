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

const budget = {
  day: "2026-08-29",
  globalCapUsd: 5,
  globalExposureUsd: 0.0253,
  remainingUsd: 4.9747,
};

const reservation = {
  id: "3a997edd-cab2-4df1-8148-f46c73617129",
  requestKey: request.requestKey,
  day: budget.day,
  reservedUsd: 0.0253,
  replay: false,
};

function clientReturning(body: unknown): CoreLlmLedgerClient {
  return new CoreLlmLedgerClient({
    baseUrl: "http://core",
    serviceToken: "secret",
    fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }),
  });
}

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

  it("согласованный replayBlocked для открытой reservation не превращает в dispatch", async () => {
    const client = clientReturning({
      allowed: false,
      status: "reserved",
      action: "pause",
      replayBlocked: true,
      reason: "requestKey использован с другим payload",
      budget,
    });

    await assert.rejects(
      () => client.reserve(request),
      (error: unknown) =>
        error instanceof LlmReplayBlockedError && error.requestKey === request.requestKey,
    );
  });

  it("не разрешает dispatch для allowed-ответа с противоречивой семантикой", async () => {
    const invalidResponses = [
      {
        name: "status не reserved",
        body: { allowed: true, status: "settled", action: "pause", reservation, budget },
      },
      {
        name: "нет reservation",
        body: { allowed: true, status: "reserved", action: "pause", budget },
      },
      {
        name: "requestKey не совпадает",
        body: {
          allowed: true,
          status: "reserved",
          action: "pause",
          reservation: { ...reservation, requestKey: "другой-request-key" },
          budget,
        },
      },
      {
        name: "день reservation не совпадает с budget",
        body: {
          allowed: true,
          status: "reserved",
          action: "pause",
          reservation: { ...reservation, day: "2026-08-28" },
          budget,
        },
      },
      {
        name: "allowed одновременно replayBlocked",
        body: {
          allowed: true,
          status: "reserved",
          action: "pause",
          replayBlocked: true,
          reservation,
          budget,
        },
      },
    ];

    for (const sample of invalidResponses) {
      await assert.rejects(
        () => clientReturning(sample.body).reserve(request),
        LlmLedgerUnavailableError,
        sample.name,
      );
    }
  });

  it("принимает только согласованные denied и replayBlocked формы", async () => {
    const invalidResponses = [
      {
        name: "закрытый статус без replayBlocked",
        body: { allowed: false, status: "settled", action: "pause", budget },
      },
      {
        name: "denied содержит reservation",
        body: {
          allowed: false,
          status: "denied",
          action: "pause",
          reservation,
          budget,
        },
      },
      {
        name: "replayBlocked содержит reservation",
        body: {
          allowed: false,
          status: "settled",
          action: "pause",
          replayBlocked: true,
          reservation,
          budget,
        },
      },
      {
        name: "неизвестный статус",
        body: { allowed: false, status: "future", action: "pause", replayBlocked: true, budget },
      },
    ];

    for (const sample of invalidResponses) {
      await assert.rejects(
        () => clientReturning(sample.body).reserve(request),
        LlmLedgerUnavailableError,
        sample.name,
      );
    }
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
