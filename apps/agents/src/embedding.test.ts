import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  LlmBudgetDeniedError,
  LlmLedgerUnavailableError,
  LlmReplayBlockedError,
  type LlmLedger,
  type LlmReserveRequest,
  type LlmSettlementRequest,
} from "@mydon/shared";
import {
  HttpEmbeddingGateway,
  embedWithLedger,
  embeddingGatewayFromEnv,
  embeddingPosture,
  type EmbeddingGateway,
} from "./embedding";

const EMBED_KEYS = [
  "EMBED_BASE_URL",
  "EMBED_API_KEY",
  "EMBED_BILLING_MODE",
  "EMBED_MODEL",
  "EMBED_PRICE_PROVIDER_ID",
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of EMBED_KEYS) savedEnv[key] = process.env[key];
beforeEach(() => {
  for (const key of EMBED_KEYS) delete process.env[key];
});
afterEach(() => {
  for (const key of EMBED_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const CONTEXT = {
  agentName: "knowledge-curator",
  feature: "assess-ideas:recall",
  requestKey: "embed-test-1",
} as const;

function ledgerFake() {
  const reserves: LlmReserveRequest[] = [];
  const settlements: { id: string; request: LlmSettlementRequest }[] = [];
  const failures: { id: string; request: LlmSettlementRequest }[] = [];
  const ledger: LlmLedger = {
    reserve: async (request) => {
      reserves.push(request);
      return {
        id: "embed-reservation",
        requestKey: request.requestKey,
        day: "2026-08-29",
        reservedUsd: 0.001,
        replay: false,
        budget: {
          day: "2026-08-29",
          globalCapUsd: 5,
          globalExposureUsd: 0.001,
          remainingUsd: 4.999,
        },
      };
    },
    settle: async (id, request) => {
      settlements.push({ id, request });
    },
    fail: async (id, request) => {
      failures.push({ id, request: { outcome: request.outcome ?? "unknown", ...request } });
    },
    release: async () => undefined,
  };
  return { ledger, reserves, settlements, failures };
}

describe("HTTP embeddings + LLM-ledger", () => {
  it("reserve denial не вызывает embedding provider", async () => {
    let calls = 0;
    const gateway: EmbeddingGateway = {
      provider: "openai-compatible",
      billingMode: "metered",
      model: "embed-model",
      embed: async () => {
        calls += 1;
        return { vector: [1, 0] };
      },
    };
    const ledger = ledgerFake().ledger;
    ledger.reserve = async () => {
      throw new LlmBudgetDeniedError("pause", "лимит", {
        day: "2026-08-29",
        globalCapUsd: 5,
        globalExposureUsd: 5,
        remainingUsd: 0,
      });
    };
    await assert.rejects(
      () => embedWithLedger(gateway, "text", { ...CONTEXT, ledger }),
      LlmBudgetDeniedError,
    );
    assert.equal(calls, 0);
  });

  it("reserve replay не повторяет embedding provider call", async () => {
    let calls = 0;
    const gateway: EmbeddingGateway = {
      provider: "openai-compatible",
      billingMode: "metered",
      model: "embed-model",
      embed: async () => {
        calls += 1;
        return { vector: [1, 0] };
      },
    };
    const ledger = ledgerFake().ledger;
    const reserve = ledger.reserve;
    ledger.reserve = async (request) => ({ ...(await reserve(request)), replay: true });
    await assert.rejects(
      () => embedWithLedger(gateway, "text", { ...CONTEXT, ledger }),
      (error: unknown) => error instanceof LlmReplayBlockedError && /replay/.test(error.message),
    );
    assert.equal(calls, 0);
  });

  it("lease guard перед каждым embedding останавливает stale worker до reserve/provider", async () => {
    let providerCalls = 0;
    let guardCalls = 0;
    const gateway: EmbeddingGateway = {
      provider: "openai",
      billingMode: "metered",
      model: "embed-model",
      embed: async () => {
        providerCalls += 1;
        return { vector: [1, 0], usage: { inputTokens: 1, outputTokens: 0 } };
      },
    };
    const { ledger, reserves } = ledgerFake();
    const assertLease = async () => {
      guardCalls += 1;
      if (guardCalls > 1) throw new LlmLedgerUnavailableError("task lease lost");
    };

    assert.deepEqual(
      await embedWithLedger(gateway, "first", {
        ...CONTEXT,
        requestKey: "embed-1",
        ledger,
        assertLease,
      }),
      [1, 0],
    );
    await assert.rejects(
      () =>
        embedWithLedger(gateway, "second", {
          ...CONTEXT,
          requestKey: "embed-2",
          ledger,
          assertLease,
        }),
      LlmLedgerUnavailableError,
    );
    assert.equal(providerCalls, 1, "второй provider dispatch запрещён");
    assert.equal(reserves.length, 1, "второй reserve тоже запрещён");
  });

  it("каждая metered embedding-попытка резервируется и сохраняет usage/cost/id", async () => {
    const gateway: EmbeddingGateway = {
      provider: "openai-compatible",
      billingMode: "metered",
      model: "embed-model",
      embed: async () => ({
        vector: [1, 0],
        usage: { inputTokens: 7, outputTokens: 0 },
        costUsd: 0.0002,
        providerRequestId: "embed-response-1",
        resolvedModel: "embed-model",
      }),
    };
    const { ledger, reserves, settlements } = ledgerFake();
    assert.deepEqual(await embedWithLedger(gateway, "text", { ...CONTEXT, ledger }), [1, 0]);
    assert.equal(reserves.length, 1);
    assert.equal(reserves[0].consumer, "embeddings");
    assert.equal(reserves[0].outputTokenCeiling, 0);
    assert.equal(settlements.length, 1);
    assert.deepEqual(settlements[0].request.usage, { inputTokens: 7, outputTokens: 0 });
    assert.equal(settlements[0].request.providerReportedUsd, 0.0002);
    assert.equal(settlements[0].request.providerRequestId, "embed-response-1");
    assert.equal(settlements[0].request.resolvedModel, "embed-model");
  });

  it("metered vector без provider resolvedModel отдаёт Core для unknown+circuit", async () => {
    const gateway: EmbeddingGateway = {
      provider: "openai-compatible",
      billingMode: "metered",
      model: "embed-alias",
      embed: async () => ({
        vector: [0.1, 0.2],
        usage: { inputTokens: 7, outputTokens: 0 },
        providerRequestId: "embed-no-model",
      }),
    };
    const { ledger, settlements, failures } = ledgerFake();
    assert.deepEqual(await embedWithLedger(gateway, "text", { ...CONTEXT, ledger }), [0.1, 0.2]);
    assert.equal(settlements.length, 1);
    assert.equal(failures.length, 0);
    assert.equal(settlements[0].request.outcome, "success");
    assert.equal(settlements[0].request.resolvedModel, undefined);
    assert.deepEqual(settlements[0].request.usage, { inputTokens: 7, outputTokens: 0 });
  });

  it("valid vector без usage/cost всё равно уходит в Core как success", async () => {
    const gateway: EmbeddingGateway = {
      provider: "openai",
      billingMode: "metered",
      model: "embed-model",
      embed: async () => ({ vector: [1, 0], resolvedModel: "embed-model" }),
    };
    const { ledger, settlements, failures } = ledgerFake();
    assert.deepEqual(await embedWithLedger(gateway, "text", { ...CONTEXT, ledger }), [1, 0]);
    assert.equal(failures.length, 0);
    assert.deepEqual(settlements[0].request, {
      outcome: "success",
      resolvedModel: "embed-model",
    });
  });

  it("HttpEmbeddingGateway сохраняет prompt_tokens/total_tokens, а нет cost не заменяет нулём", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          id: "emb-1",
          model: "embed-resolved",
          data: [{ embedding: [0.1, 0.2] }],
          usage: { prompt_tokens: 3, total_tokens: 3 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const gateway = new HttpEmbeddingGateway(
      "https://gateway.invalid",
      "fixture-provider",
      "",
      "embed-model",
      1000,
      "metered",
      fetchImpl,
    );
    const result = await gateway.embed("hello");
    assert.deepEqual(result.vector, [0.1, 0.2]);
    assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 0 });
    assert.equal(result.providerRequestId, "emb-1");
    assert.equal(result.resolvedModel, "embed-resolved");
    assert.equal("costUsd" in result, false);
  });

  it("HTTP embeddings по умолчанию metered; local только явный", () => {
    assert.equal(
      new HttpEmbeddingGateway("http://local", "fixture-provider").billingMode,
      "metered",
    );
    assert.equal(
      new HttpEmbeddingGateway("http://local", "", "", "m", 1000, "local").billingMode,
      "local",
    );
  });

  it("fromEnv блокирует metered без EMBED_PRICE_PROVIDER_ID до HTTP", () => {
    process.env.EMBED_BASE_URL = "https://gateway.invalid";
    process.env.EMBED_BILLING_MODE = "metered";

    assert.throws(() => embeddingGatewayFromEnv(), /EMBED_PRICE_PROVIDER_ID.*заблокирован/);
    assert.match(embeddingPosture(), /EMBED_PRICE_PROVIDER_ID.*заблокированы/);
  });

  it("fromEnv передаёт exact embedding pricing profile; local разрешён без него", () => {
    process.env.EMBED_BASE_URL = "https://gateway.invalid";
    process.env.EMBED_PRICE_PROVIDER_ID = "openai";
    const metered = embeddingGatewayFromEnv();
    assert.equal(metered?.provider, "openai");
    assert.equal(metered?.billingMode, "metered");
    assert.match(embeddingPosture(), /price provider=openai/);

    process.env.EMBED_BILLING_MODE = "local";
    delete process.env.EMBED_PRICE_PROVIDER_ID;
    const local = embeddingGatewayFromEnv();
    assert.equal(local?.provider, "");
    assert.equal(local?.billingMode, "local");
  });

  it("ошибка settle наблюдаема, но уже полученный embedding не теряется", async () => {
    const gateway: EmbeddingGateway = {
      provider: "openai",
      billingMode: "metered",
      model: "embed-model",
      embed: async () => ({
        vector: [0.25, 0.75],
        usage: { inputTokens: 3, outputTokens: 0 },
        resolvedModel: "embed-model",
      }),
    };
    const ledger = ledgerFake().ledger;
    ledger.settle = async () => {
      throw new Error("Core unavailable");
    };
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    try {
      assert.deepEqual(
        await embedWithLedger(gateway, "text", { ...CONTEXT, ledger }),
        [0.25, 0.75],
      );
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /requestKey=embed-test-1/);
    assert.match(warnings[0], /reservation=embed-reservation/);
    assert.match(warnings[0], /Core unavailable/);
  });

  it("ошибка fail тоже пишет requestKey и reservation", async () => {
    const gateway: EmbeddingGateway = {
      provider: "openai",
      billingMode: "metered",
      model: "embed-model",
      embed: async () => ({ vector: null, error: "provider failed" }),
    };
    const ledger = ledgerFake().ledger;
    ledger.fail = async () => {
      throw new Error("fail unavailable");
    };
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    try {
      assert.equal(await embedWithLedger(gateway, "text", { ...CONTEXT, ledger }), null);
    } finally {
      console.warn = originalWarn;
    }
    assert.match(warnings[0], /requestKey=embed-test-1/);
    assert.match(warnings[0], /reservation=embed-reservation/);
    assert.match(warnings[0], /fail unavailable/);
  });
});
