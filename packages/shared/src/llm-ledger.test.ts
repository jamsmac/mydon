import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CoreLlmLedgerClient,
  LlmBudgetDeniedError,
  LlmLedgerCloseError,
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

function unreadableResponse(status = 200): Response {
  const response = new Response(null, { status });
  Object.defineProperty(response, "text", {
    value: async () => {
      throw new Error("body stream aborted");
    },
  });
  return response;
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
    const client = new CoreLlmLedgerClient({
      baseUrl: "http://core",
      serviceToken: "secret",
      fetchImpl: async () => unreadableResponse(),
    });

    await assert.rejects(
      () => client.reserve(request),
      (error: unknown) =>
        error instanceof LlmLedgerUnavailableError &&
        error.message === "Не удалось прочитать ответ LLM-ledger (HTTP 200)" &&
        error.cause === undefined,
    );
  });

  it("reserve никогда не повторяет HTTP-попытку после неоднозначного отказа", async () => {
    const failures: Array<{ name: string; response: () => Promise<Response> }> = [
      {
        name: "network/timeout",
        response: async () => {
          throw new DOMException("timed out", "TimeoutError");
        },
      },
      {
        name: "HTTP 503",
        response: async () => new Response('{"message":"transient"}', { status: 503 }),
      },
      {
        name: "unreadable response",
        response: async () => unreadableResponse(),
      },
    ];

    for (const failure of failures) {
      let calls = 0;
      const client = new CoreLlmLedgerClient({
        baseUrl: "http://core",
        serviceToken: "secret",
        closeRetryAttempts: 5,
        closeRetryBaseDelayMs: 0,
        fetchImpl: async () => {
          calls += 1;
          return failure.response();
        },
      });

      await assert.rejects(() => client.reserve(request), LlmLedgerUnavailableError, failure.name);
      assert.equal(calls, 1, failure.name);
    }
  });

  it("settle повторяет exact path/body и создаёт свежий timeout signal", async () => {
    const calls: Array<{
      url: string;
      body: string | null;
      signal: AbortSignal | null | undefined;
      serviceToken: string | null;
    }> = [];
    const settlement = {
      outcome: "success" as const,
      usage: { inputTokens: 17, outputTokens: 4 },
      resolvedModel: "gpt-5.6-sol",
      metadata: { attempt: 1 },
    };
    const client = new CoreLlmLedgerClient({
      baseUrl: "http://core/",
      serviceToken: "service-secret",
      timeoutMs: 25,
      closeRetryAttempts: 3,
      closeRetryBaseDelayMs: 0,
      fetchImpl: async (url, init) => {
        calls.push({
          url: String(url),
          body: typeof init?.body === "string" ? init.body : null,
          signal: init?.signal,
          serviceToken: new Headers(init?.headers).get("x-service-token"),
        });
        if (calls.length === 1) throw new DOMException("timed out", "TimeoutError");
        if (calls.length === 2) return unreadableResponse();
        return new Response('{"status":"settled","replay":true}', { status: 200 });
      },
    });

    await client.settle("reservation/with slash", settlement);

    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls.map((call) => call.url),
      Array(3).fill("http://core/llm-ledger/reservations/reservation%2Fwith%20slash/settle"),
    );
    assert.deepEqual(
      calls.map((call) => call.body),
      Array(3).fill(JSON.stringify(settlement)),
    );
    assert.deepEqual(
      calls.map((call) => call.serviceToken),
      ["service-secret", "service-secret", "service-secret"],
    );
    assert.ok(calls[0]?.signal instanceof AbortSignal);
    assert.ok(calls[1]?.signal instanceof AbortSignal);
    assert.ok(calls[2]?.signal instanceof AbortSignal);
    assert.notEqual(calls[0]?.signal, calls[1]?.signal);
    assert.notEqual(calls[1]?.signal, calls[2]?.signal);
  });

  it("settle повторяет 408/425/429/5xx и не-JSON 2xx", async () => {
    const transientStatuses = [408, 425, 429, 500, 503, 599];
    for (const status of transientStatuses) {
      let calls = 0;
      const client = new CoreLlmLedgerClient({
        baseUrl: "http://core",
        serviceToken: "secret",
        closeRetryAttempts: 2,
        closeRetryBaseDelayMs: 0,
        fetchImpl: async () => {
          calls += 1;
          return calls === 1
            ? new Response('{"message":"temporary"}', { status })
            : new Response("{}", { status: 200 });
        },
      });

      await client.settle(reservation.id, { outcome: "success" });
      assert.equal(calls, 2, `HTTP ${status}`);
    }

    let nonJsonCalls = 0;
    const nonJsonClient = new CoreLlmLedgerClient({
      baseUrl: "http://core",
      serviceToken: "secret",
      closeRetryAttempts: 2,
      closeRetryBaseDelayMs: 0,
      fetchImpl: async () => {
        nonJsonCalls += 1;
        return nonJsonCalls === 1
          ? new Response("broken response", { status: 200 })
          : new Response("{}", { status: 200 });
      },
    });
    await nonJsonClient.settle(reservation.id, { outcome: "success" });
    assert.equal(nonJsonCalls, 2);
  });

  it("429 Retry-After delta-seconds увеличивает задержку close retry", async () => {
    let calls = 0;
    const waits: number[] = [];
    const client = new CoreLlmLedgerClient({
      baseUrl: "http://core",
      serviceToken: "secret",
      closeRetryAttempts: 2,
      closeRetryBaseDelayMs: 250,
      closeRetryWaitImpl: async (delayMs) => {
        waits.push(delayMs);
      },
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? new Response("{}", { status: 429, headers: { "Retry-After": "1" } })
          : new Response("{}", { status: 200 });
      },
    });

    await client.settle(reservation.id, { outcome: "success" });

    assert.equal(calls, 2);
    assert.deepEqual(waits, [1_000]);
  });

  it("Retry-After HTTP-date ограничивается cap, а прошедшая дата оставляет backoff", async () => {
    const samples = [
      {
        name: "future",
        retryAfter: new Date(Date.now() + 60_000).toUTCString(),
        expectedDelayMs: 2_000,
      },
      {
        name: "past",
        retryAfter: new Date(Date.now() - 60_000).toUTCString(),
        expectedDelayMs: 100,
      },
      {
        name: "obsolete RFC850",
        retryAfter: "Tuesday, 01-Jan-30 00:00:00 GMT",
        expectedDelayMs: 2_000,
      },
      {
        name: "obsolete asctime",
        retryAfter: "Tue Jan  1 00:00:00 2030",
        expectedDelayMs: 2_000,
      },
    ];

    for (const sample of samples) {
      let calls = 0;
      const waits: number[] = [];
      const client = new CoreLlmLedgerClient({
        baseUrl: "http://core",
        serviceToken: "secret",
        closeRetryAttempts: 2,
        closeRetryBaseDelayMs: 100,
        closeRetryWaitImpl: async (delayMs) => {
          waits.push(delayMs);
        },
        fetchImpl: async () => {
          calls += 1;
          return calls === 1
            ? new Response("{}", {
                status: 429,
                headers: { "Retry-After": sample.retryAfter },
              })
            : new Response("{}", { status: 200 });
        },
      });

      await client.settle(reservation.id, { outcome: "success" });
      assert.equal(calls, 2, sample.name);
      assert.deepEqual(waits, [sample.expectedDelayMs], sample.name);
    }
  });

  it("RFC850 разрешает двузначный год по 50-летней границе HTTP", async () => {
    const originalDateNow = Date.now;
    Date.now = () => Date.UTC(2026, 0, 1);
    try {
      const samples = [
        { retryAfter: "Saturday, 01-Jan-50 00:00:00 GMT", expectedDelayMs: 2_000 },
        { retryAfter: "Wednesday, 01-Jan-76 00:00:00 GMT", expectedDelayMs: 2_000 },
        { retryAfter: "Friday, 02-Jan-76 00:00:00 GMT", expectedDelayMs: 100 },
      ];

      for (const sample of samples) {
        let calls = 0;
        const waits: number[] = [];
        const client = new CoreLlmLedgerClient({
          baseUrl: "http://core",
          serviceToken: "secret",
          closeRetryAttempts: 2,
          closeRetryBaseDelayMs: 100,
          closeRetryWaitImpl: async (delayMs) => {
            waits.push(delayMs);
          },
          fetchImpl: async () => {
            calls += 1;
            return calls === 1
              ? new Response("{}", {
                  status: 429,
                  headers: { "Retry-After": sample.retryAfter },
                })
              : new Response("{}", { status: 200 });
          },
        });

        await client.settle(reservation.id, { outcome: "success" });
        assert.equal(calls, 2, sample.retryAfter);
        assert.deepEqual(waits, [sample.expectedDelayMs], sample.retryAfter);
      }
    } finally {
      Date.now = originalDateNow;
    }
  });

  it("IMF-fixdate и asctime отвергают невозможный календарь, но принимают leap second", async () => {
    const samples = [
      { retryAfter: "Fri, 31 Feb 2030 00:00:00 GMT", expectedDelayMs: 100 },
      { retryAfter: "Fri Feb 31 00:00:00 2030", expectedDelayMs: 100 },
      { retryAfter: "Tue, 01 Jan 2030 24:00:00 GMT", expectedDelayMs: 100 },
      { retryAfter: "Tue Jan 01 24:00:00 2030", expectedDelayMs: 100 },
      { retryAfter: "Tue, 01 Jan 2030 00:00:60 GMT", expectedDelayMs: 2_000 },
      { retryAfter: "Tue Jan 01 00:00:60 2030", expectedDelayMs: 2_000 },
    ];

    for (const sample of samples) {
      let calls = 0;
      const waits: number[] = [];
      const client = new CoreLlmLedgerClient({
        baseUrl: "http://core",
        serviceToken: "secret",
        closeRetryAttempts: 2,
        closeRetryBaseDelayMs: 100,
        closeRetryWaitImpl: async (delayMs) => {
          waits.push(delayMs);
        },
        fetchImpl: async () => {
          calls += 1;
          return calls === 1
            ? new Response("{}", {
                status: 429,
                headers: { "Retry-After": sample.retryAfter },
              })
            : new Response("{}", { status: 200 });
        },
      });

      await client.settle(reservation.id, { outcome: "success" });
      assert.equal(calls, 2, sample.retryAfter);
      assert.deepEqual(waits, [sample.expectedDelayMs], sample.retryAfter);
    }
  });

  it("неверный и отрицательный Retry-After не ломают close retry", async () => {
    for (const retryAfter of ["malformed", "-1", "1.5"]) {
      let calls = 0;
      const waits: number[] = [];
      const client = new CoreLlmLedgerClient({
        baseUrl: "http://core",
        serviceToken: "secret",
        closeRetryAttempts: 2,
        closeRetryBaseDelayMs: 125,
        closeRetryWaitImpl: async (delayMs) => {
          waits.push(delayMs);
        },
        fetchImpl: async () => {
          calls += 1;
          return calls === 1
            ? new Response("{}", { status: 429, headers: { "Retry-After": retryAfter } })
            : new Response("{}", { status: 200 });
        },
      });

      await client.settle(reservation.id, { outcome: "success" });
      assert.equal(calls, 2, retryAfter);
      assert.deepEqual(waits, [125], retryAfter);
    }
  });

  it("settle не hot-loop-ит 4xx, но auth drift оставляет outbox retryable", async () => {
    const terminalStatuses = [400, 401, 403, 404, 409, 422];
    for (const status of terminalStatuses) {
      let calls = 0;
      const requestSecret = "request-body-secret";
      const serviceSecret = "service-token-secret";
      const responseSecret = "response-body-secret";
      const client = new CoreLlmLedgerClient({
        baseUrl: "http://core",
        serviceToken: serviceSecret,
        closeRetryAttempts: 5,
        closeRetryBaseDelayMs: 0,
        fetchImpl: async () => {
          calls += 1;
          return new Response(JSON.stringify({ message: responseSecret }), { status });
        },
      });

      await assert.rejects(
        () =>
          client.settle(reservation.id, {
            outcome: "success",
            metadata: { opaque: requestSecret },
          }),
        (error: unknown) => {
          assert.ok(error instanceof LlmLedgerCloseError);
          assert.equal(error.retryable, status === 401 || status === 403);
          assert.equal(error.httpStatus, status);
          assert.equal(error.message, `LLM-ledger отказал (HTTP ${status})`);
          assert.doesNotMatch(error.message, new RegExp(requestSecret));
          assert.doesNotMatch(error.message, new RegExp(serviceSecret));
          assert.doesNotMatch(error.message, new RegExp(responseSecret));
          return true;
        },
      );
      assert.equal(calls, 1, `HTTP ${status}`);
    }
  });

  it("settle не повторяет HTTP 409 даже при нечитаемом body", async () => {
    let calls = 0;
    const waits: number[] = [];
    const client = new CoreLlmLedgerClient({
      baseUrl: "http://core",
      serviceToken: "secret",
      closeRetryAttempts: 5,
      closeRetryBaseDelayMs: 0,
      closeRetryWaitImpl: async (delayMs) => {
        waits.push(delayMs);
      },
      fetchImpl: async () => {
        calls += 1;
        return unreadableResponse(409);
      },
    });

    await assert.rejects(
      () => client.settle(reservation.id, { outcome: "success" }),
      (error: unknown) =>
        error instanceof LlmLedgerCloseError &&
        !error.retryable &&
        error.httpStatus === 409,
    );
    assert.equal(calls, 1);
    assert.deepEqual(waits, []);
  });

  it("fail повторяет exact unknown settlement", async () => {
    const bodies: string[] = [];
    const client = new CoreLlmLedgerClient({
      baseUrl: "http://core",
      serviceToken: "secret",
      closeRetryAttempts: 2,
      closeRetryBaseDelayMs: 0,
      fetchImpl: async (_url, init) => {
        bodies.push(String(init?.body));
        return bodies.length === 1
          ? new Response("{}", { status: 503 })
          : new Response("{}", { status: 200 });
      },
    });

    await client.fail(reservation.id, { reason: "provider timeout" });
    const expected = JSON.stringify({ reason: "provider timeout", outcome: "unknown" });
    assert.deepEqual(bodies, [expected, expected]);
  });

  it("release повторяет exact reason и останавливается на success", async () => {
    const urls: string[] = [];
    const bodies: string[] = [];
    const client = new CoreLlmLedgerClient({
      baseUrl: "http://core",
      serviceToken: "secret",
      closeRetryAttempts: 5,
      closeRetryBaseDelayMs: 0,
      fetchImpl: async (url, init) => {
        urls.push(String(url));
        bodies.push(String(init?.body));
        return urls.length === 1
          ? new Response("{}", { status: 429 })
          : new Response(null, { status: 204 });
      },
    });

    await client.release(reservation.id, "before_provider_send");
    assert.equal(urls.length, 2);
    assert.ok(urls.every((url) => url.endsWith(`/${reservation.id}/release`)));
    assert.deepEqual(bodies, [
      JSON.stringify({ reason: "before_provider_send" }),
      JSON.stringify({ reason: "before_provider_send" }),
    ]);
  });

  it("recoverPreDispatch повторяет exact requestKey через отдельный close endpoint", async () => {
    const urls: string[] = [];
    const bodies: string[] = [];
    const client = new CoreLlmLedgerClient({
      baseUrl: "http://core/",
      serviceToken: "secret",
      closeRetryAttempts: 2,
      closeRetryBaseDelayMs: 0,
      fetchImpl: async (url, init) => {
        urls.push(String(url));
        bodies.push(String(init?.body));
        return urls.length === 1
          ? new Response("{}", { status: 503 })
          : new Response('{"status":"released","replay":false}', { status: 200 });
      },
    });

    await client.recoverPreDispatch(request.requestKey);

    assert.deepEqual(urls, [
      "http://core/llm-ledger/reservations/recover-pre-dispatch",
      "http://core/llm-ledger/reservations/recover-pre-dispatch",
    ]);
    assert.deepEqual(bodies, [
      JSON.stringify({ requestKey: request.requestKey }),
      JSON.stringify({ requestKey: request.requestKey }),
    ]);
  });

  it("recoverPreDispatch не подтверждает missing до появления исходного reserve", async () => {
    const client = new CoreLlmLedgerClient({
      baseUrl: "http://core",
      serviceToken: "secret",
      closeRetryAttempts: 1,
      fetchImpl: async () =>
        new Response('{"status":"missing","replay":true}', { status: 200 }),
    });

    await assert.rejects(
      () => client.recoverPreDispatch(request.requestKey),
      (error: unknown) => {
        assert.ok(error instanceof LlmLedgerCloseError);
        assert.equal(error.retryable, true);
        assert.doesNotMatch(error.message, new RegExp(request.requestKey));
        return true;
      },
    );
  });

  it("exhausted retryable HTTP ошибка сохраняет безопасную close-классификацию", async () => {
    let calls = 0;
    const client = new CoreLlmLedgerClient({
      baseUrl: "http://core",
      serviceToken: "service-secret",
      closeRetryAttempts: 2,
      closeRetryBaseDelayMs: 0,
      fetchImpl: async () => {
        calls += 1;
        return new Response('{"message":"response-secret"}', { status: 503 });
      },
    });

    await assert.rejects(
      () => client.release(reservation.id, "request-secret"),
      (error: unknown) => {
        assert.ok(error instanceof LlmLedgerCloseError);
        assert.equal(error.retryable, true);
        assert.equal(error.httpStatus, 503);
        assert.equal(error.cause, undefined);
        assert.doesNotMatch(error.message, /service-secret|response-secret|request-secret/);
        return true;
      },
    );
    assert.equal(calls, 2);
  });

  it("close retry ограничен пятью попытками даже при большем конфиге", async () => {
    let calls = 0;
    const transportSecret = "transport-echoed-secret";
    const requestSecret = "request-body-secret";
    const client = new CoreLlmLedgerClient({
      baseUrl: "http://core",
      serviceToken: "secret",
      closeRetryAttempts: 100,
      closeRetryBaseDelayMs: 0,
      fetchImpl: async () => {
        calls += 1;
        throw new Error(`connection reset ${transportSecret}`);
      },
    });

    await assert.rejects(
      () =>
        client.settle(reservation.id, {
          outcome: "unknown",
          metadata: { opaque: requestSecret },
        }),
      (error: unknown) => {
        assert.ok(error instanceof LlmLedgerCloseError);
        assert.equal(error.retryable, true);
        assert.equal(error.httpStatus, undefined);
        assert.equal(error.message, "Не удалось связаться с LLM-ledger в Core");
        assert.doesNotMatch(error.message, new RegExp(transportSecret));
        assert.doesNotMatch(error.message, new RegExp(requestSecret));
        assert.equal(error.cause, undefined);
        return true;
      },
    );
    assert.equal(calls, 5);
  });
});

describe("inputTokenCeiling", () => {
  it("считает UTF-8 байты и протокольный запас", () => {
    assert.equal(inputTokenCeiling("abc", 10), 13);
    assert.equal(inputTokenCeiling("я", 0), 2);
  });
});
