import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { llmModelPrice, llmSpend, systemConfig } from "@mydon/db";
import { tashkentDay } from "@mydon/shared";
import type { ReserveLlmDto } from "./llm-ledger.dto";
import { hashLedgerPayload, usdToNano, type LedgerPriceSnapshot } from "./llm-ledger.money";
import {
  classifySettlementAnomaly,
  consumerRequiresAgent,
  flatOpenAiPriceTierDenial,
  LlmLedgerService,
  normalizeSettlement,
  normalizeUsage,
  providerCircuitWindow,
  reservationLimitDenial,
  resolveLlmAdmissionPolicy,
  stabilizeLedgerDay,
} from "./llm-ledger.service";

const PRICE: LedgerPriceSnapshot = {
  version: 2,
  provider: "anthropic",
  model: "claude-opus-5",
  billingKind: "metered",
  settlementKind: "tokens",
  inputUsdPerMtok: "5",
  outputUsdPerMtok: "25",
  cacheReadUsdPerMtok: "0.5",
  cacheWrite5mUsdPerMtok: "6.25",
  cacheWrite1hUsdPerMtok: "10",
  fixedRequestUsd: "0",
  reservationCeilingUsd: null,
  codeExecutionUsdPerRequest: "0.004166667",
  documentsPolicy: {
    version: 1,
    inputOverheadTokens: 128_000,
    codeExecution: {
      exact: false,
      basis: "container_5m_minimum",
      monthlyFreePoolApplied: false,
    },
  },
  validFrom: "2026-08-29T00:00:00.000Z",
};

const RESERVE_REQUEST: ReserveLlmDto = {
  requestKey: "core-policy-test",
  consumer: "bot",
  feature: "policy-test",
  provider: "openai",
  model: "gpt-5.6-sol",
  inputTokenCeiling: 0,
  outputTokenCeiling: 1_000_000,
};

type PolicyPriceRow = {
  id: string;
  provider: string;
  model: string;
  billingKind: "metered" | "subscription";
  settlementKind: "tokens" | "provider_reported";
  inputUsdPerMtok: string;
  outputUsdPerMtok: string;
  cacheReadUsdPerMtok: string;
  cacheWrite5mUsdPerMtok: string;
  cacheWrite1hUsdPerMtok: string;
  fixedRequestUsd: string;
  reservationCeilingUsd: string | null;
  codeExecutionUsdPerRequest: string;
  validFrom: Date;
  validTo: Date | null;
};

function policyPrice(overrides: Partial<PolicyPriceRow> = {}): PolicyPriceRow {
  return {
    id: "price-openai-sol",
    provider: "openai",
    model: "gpt-5.6-sol",
    billingKind: "metered",
    settlementKind: "tokens",
    inputUsdPerMtok: "0",
    outputUsdPerMtok: "4",
    cacheReadUsdPerMtok: "0",
    cacheWrite5mUsdPerMtok: "0",
    cacheWrite1hUsdPerMtok: "0",
    fixedRequestUsd: "0",
    reservationCeilingUsd: null,
    codeExecutionUsdPerRequest: "0",
    validFrom: new Date("2026-08-30T00:00:00.000Z"),
    validTo: null,
    ...overrides,
  };
}

function policySnapshot(row: PolicyPriceRow): LedgerPriceSnapshot {
  return {
    version: 2,
    provider: row.provider,
    model: row.model,
    billingKind: row.billingKind,
    settlementKind: row.settlementKind,
    inputUsdPerMtok: row.inputUsdPerMtok,
    outputUsdPerMtok: row.outputUsdPerMtok,
    cacheReadUsdPerMtok: row.cacheReadUsdPerMtok,
    cacheWrite5mUsdPerMtok: row.cacheWrite5mUsdPerMtok,
    cacheWrite1hUsdPerMtok: row.cacheWrite1hUsdPerMtok,
    fixedRequestUsd: row.fixedRequestUsd,
    reservationCeilingUsd: row.reservationCeilingUsd,
    codeExecutionUsdPerRequest: row.codeExecutionUsdPerRequest,
    documentsPolicy: PRICE.documentsPolicy,
    validFrom: row.validFrom.toISOString(),
  };
}

function priorReservation(
  request: ReserveLlmDto,
  price: PolicyPriceRow,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "spend-policy-prior",
    requestKey: request.requestKey,
    requestHash: hashLedgerPayload({ ...request, metadata: request.metadata ?? {} }),
    day: tashkentDay(new Date()),
    status: "reserved",
    reservedUsd: price.outputUsdPerMtok,
    agentId: null,
    agentName: request.agentName ?? null,
    priceId: price.id,
    priceSnapshot: policySnapshot(price),
    metadata: {},
    ...overrides,
  };
}

/** Узкий in-memory tx для проверки именно reserve policy, без живого Postgres. */
function reservePolicyTx(
  config: Record<string, string>,
  outputUsdPerMtok = "4",
  options: {
    prior?: Record<string, unknown>;
    exposureUsd?: string;
    prices?: PolicyPriceRow[];
  } = {},
) {
  const inserted: Record<string, unknown>[] = [];
  const prices = options.prices ?? [policyPrice({ outputUsdPerMtok })];

  const tx = {
    execute: async () => undefined,
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => {
        if (table === systemConfig) {
          return Promise.resolve(Object.entries(config).map(([key, value]) => ({ key, value })));
        }
        if (table === llmModelPrice) return { where: async () => prices };
        assert.equal(table, llmSpend);
        if (fields && "value" in fields) {
          return { where: async () => [{ value: options.exposureUsd ?? "0" }] };
        }
        if (fields && "reason" in fields) {
          return { where: () => ({ limit: async () => [] }) };
        }
        return {
          where: () => ({
            limit: () => ({ for: async () => (options.prior ? [options.prior] : []) }),
          }),
        };
      },
    }),
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        assert.equal(table, llmSpend);
        inserted.push(row);
        return {
          returning: async () => [{ id: "spend-policy-test", createdAt: new Date(), ...row }],
        };
      },
    }),
  } as never;
  return { tx, inserted };
}

async function withoutLlmEnabledEnv<T>(body: () => Promise<T>): Promise<T> {
  const previous = process.env.LLM_ENABLED;
  delete process.env.LLM_ENABLED;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.LLM_ENABLED;
    else process.env.LLM_ENABLED = previous;
  }
}

describe("LLM-ledger settlement invariants", () => {
  it("LLM по умолчанию fail-closed; DB важнее env, cap по умолчанию $3", () => {
    const defaults = resolveLlmAdmissionPolicy({}, {});
    assert.equal(defaults.enabled, false);
    assert.match(defaults.denial ?? "", /LLM_ENABLED/);
    assert.equal(defaults.reservationCapNano, usdToNano("3"));

    const dbWins = resolveLlmAdmissionPolicy(
      { LLM_ENABLED: "1", LLM_MAX_RESERVATION_USD: "2.5" },
      { LLM_ENABLED: "0", LLM_MAX_RESERVATION_USD: "9" },
    );
    assert.deepEqual(dbWins, {
      enabled: true,
      reservationCapNano: usdToNano("2.5"),
    });

    const invalidCap = resolveLlmAdmissionPolicy(
      { LLM_ENABLED: "1", LLM_MAX_RESERVATION_USD: "много" },
      {},
    );
    assert.equal(invalidCap.enabled, true);
    assert.equal(invalidCap.reservationCapNano, 0n);
    assert.match(invalidCap.denial ?? "", /не является неотрицательной суммой/);
  });

  it("reserveInTx центрально пишет denied, когда LLM_ENABLED не равен 1", async () => {
    await withoutLlmEnabledEnv(async () => {
      const { tx, inserted } = reservePolicyTx({});
      const response = await new LlmLedgerService({} as never).reserveInTx(tx, RESERVE_REQUEST);
      assert.equal(response.allowed, false);
      assert.match(response.reason ?? "", /LLM_ENABLED/);
      assert.equal(inserted.length, 1);
      assert.equal(inserted[0]?.status, "denied");
    });
  });

  it("reserveInTx применяет per-reservation cap до дневного лимита", async () => {
    const config = {
      LLM_ENABLED: "1",
      LLM_MAX_RESERVATION_USD: "3",
      LLM_GLOBAL_DAILY_BUDGET_USD: "10",
    };
    const over = reservePolicyTx(config, "4");
    const denied = await new LlmLedgerService({} as never).reserveInTx(over.tx, RESERVE_REQUEST);
    assert.equal(denied.allowed, false);
    assert.match(denied.reason ?? "", /превышает потолок/);
    assert.equal(over.inserted[0]?.status, "denied");
    assert.equal(over.inserted[0]?.reservedUsd, "4.000000000");

    const equal = reservePolicyTx(config, "3");
    const allowed = await new LlmLedgerService({} as never).reserveInTx(equal.tx, {
      ...RESERVE_REQUEST,
      requestKey: "core-policy-test-equal",
    });
    assert.equal(allowed.allowed, true);
    assert.equal(equal.inserted[0]?.status, "reserved");
    assert.equal(equal.inserted[0]?.reservedUsd, "3.000000000");
  });

  it("ledger replay отзывает reserve, когда дневной cap опустили ниже текущей exposure", async () => {
    const price = policyPrice();
    const prior = priorReservation(RESERVE_REQUEST, price, {
      reservedUsd: "1.000000000",
    });
    const replay = reservePolicyTx(
      {
        LLM_ENABLED: "1",
        LLM_MAX_RESERVATION_USD: "3",
        LLM_GLOBAL_DAILY_BUDGET_USD: "0.5",
      },
      "4",
      { prior, exposureUsd: "1", prices: [price] },
    );

    const response = await new LlmLedgerService({} as never).reserveInTx(
      replay.tx,
      RESERVE_REQUEST,
    );
    assert.equal(response.allowed, false);
    assert.equal(response.status, "reserved");
    assert.match(response.reason ?? "", /экспозиция.*выше.*дневного потолка/);
    assert.equal(replay.inserted.length, 0, "replay не создаёт второй spend");
  });

  it("ledger replay разрешает неизменённый reserve текущих суток и active price", async () => {
    const price = policyPrice({ outputUsdPerMtok: "1" });
    const prior = priorReservation(RESERVE_REQUEST, price, {
      reservedUsd: "1.000000000",
    });
    const replay = reservePolicyTx(
      {
        LLM_ENABLED: "1",
        LLM_MAX_RESERVATION_USD: "3",
        LLM_GLOBAL_DAILY_BUDGET_USD: "10",
      },
      "1",
      { prior, exposureUsd: "1", prices: [price] },
    );

    const response = await new LlmLedgerService({} as never).reserveInTx(
      replay.tx,
      RESERVE_REQUEST,
    );
    assert.equal(response.allowed, true);
    assert.equal(response.status, "reserved");
    assert.equal(response.reservation?.id, prior.id);
    assert.equal(response.reservation?.replay, true);
  });

  it("ledger replay не переносит старый reserve в следующие ташкентские сутки", async () => {
    const price = policyPrice({ outputUsdPerMtok: "1" });
    const prior = priorReservation(RESERVE_REQUEST, price, {
      day: "2000-01-01",
      reservedUsd: "1.000000000",
    });
    const replay = reservePolicyTx(
      {
        LLM_ENABLED: "1",
        LLM_MAX_RESERVATION_USD: "3",
        LLM_GLOBAL_DAILY_BUDGET_USD: "10",
      },
      "1",
      { prior, prices: [price] },
    );

    const response = await new LlmLedgerService({} as never).reserveInTx(
      replay.tx,
      RESERVE_REQUEST,
    );
    assert.equal(response.allowed, false);
    assert.equal(response.status, "reserved");
    assert.match(response.reason ?? "", /ташкентским суткам 2000-01-01.*текущих сутках/);
    assert.equal(replay.inserted.length, 0);
  });

  it("ledger replay блокирует отсутствующую и заменённую active exact цену", async () => {
    const promo = policyPrice({ id: "promo-price", outputUsdPerMtok: "1" });
    const prior = priorReservation(RESERVE_REQUEST, promo, {
      reservedUsd: "1.000000000",
    });
    const config = {
      LLM_ENABLED: "1",
      LLM_MAX_RESERVATION_USD: "3",
      LLM_GLOBAL_DAILY_BUDGET_USD: "10",
    };

    const missing = reservePolicyTx(config, "1", {
      prior,
      exposureUsd: "1",
      prices: [policyPrice({ id: "other-price", model: "other-model" })],
    });
    const missingResponse = await new LlmLedgerService({} as never).reserveInTx(
      missing.tx,
      RESERVE_REQUEST,
    );
    assert.equal(missingResponse.allowed, false);
    assert.match(missingResponse.reason ?? "", /больше нет действующей цены/);

    const baseline = policyPrice({ id: "baseline-price", outputUsdPerMtok: "4" });
    const replaced = reservePolicyTx(config, "4", {
      prior,
      exposureUsd: "1",
      prices: [baseline],
    });
    const replacedResponse = await new LlmLedgerService({} as never).reserveInTx(
      replaced.tx,
      RESERVE_REQUEST,
    );
    assert.equal(replacedResponse.allowed, false);
    assert.match(replacedResponse.reason ?? "", /Действующая цена.*изменилась после reserve/);
  });

  it("ledger replay пересчитывает консервативный provider-route reserve", async () => {
    const request: ReserveLlmDto = {
      ...RESERVE_REQUEST,
      consumer: "agents",
      agentName: "coach",
      requestKey: "core-policy-route-replay",
    };
    const exact = policyPrice({ outputUsdPerMtok: "1" });
    const expensiveRoute = policyPrice({
      id: "price-openai-expensive-route",
      model: "another-routable-model",
      outputUsdPerMtok: "5",
    });
    const prior = priorReservation(request, exact, { reservedUsd: "1.000000000" });
    const replay = reservePolicyTx(
      {
        LLM_ENABLED: "1",
        LLM_MAX_RESERVATION_USD: "10",
        LLM_GLOBAL_DAILY_BUDGET_USD: "20",
      },
      "1",
      { prior, exposureUsd: "1", prices: [exact, expensiveRoute] },
    );

    const response = await new LlmLedgerService({} as never).reserveInTx(replay.tx, request);
    assert.equal(response.allowed, false);
    assert.match(response.reason ?? "", /консервативный reserve.*выше сохранённого/);
  });

  it("лимит одного reserve разрешает ровно $3 и отклоняет хотя бы один nano сверху", () => {
    const cap = usdToNano("3");
    assert.equal(reservationLimitDenial(cap, cap), undefined);
    assert.match(reservationLimitDenial(cap + 1n, cap) ?? "", /превышает потолок/);
  });

  it("gpt-5.6-sol с exact 272000 input проходит, а больший ceiling блокируется", () => {
    const request = { provider: "openai", model: "gpt-5.6-sol", inputTokenCeiling: 272_000 };
    assert.equal(flatOpenAiPriceTierDenial(request), undefined);
    assert.match(
      flatOpenAiPriceTierDenial({ ...request, inputTokenCeiling: 272_001 }) ?? "",
      /tier surcharge/,
    );
    assert.equal(
      flatOpenAiPriceTierDenial({
        ...request,
        provider: "custom-openai",
        inputTokenCeiling: 272_001,
      }),
      undefined,
    );
    assert.equal(
      flatOpenAiPriceTierDenial({ ...request, model: "another-model", inputTokenCeiling: 272_001 }),
      undefined,
    );
  });

  it("после ожидания day-lock повторно фиксирует уже наступившие ташкентские сутки", async () => {
    const clocks = [
      new Date("2026-08-28T18:59:59.999Z"),
      new Date("2026-08-28T19:00:00.001Z"),
      new Date("2026-08-28T19:00:00.002Z"),
    ];
    const lockedDays: string[] = [];

    const result = await stabilizeLedgerDay(
      async (day) => {
        lockedDays.push(day);
      },
      () => clocks.shift() ?? new Date("2026-08-28T19:00:00.003Z"),
    );

    assert.deepEqual(lockedDays, ["2026-08-28", "2026-08-29"]);
    assert.equal(result.day, "2026-08-29");
    assert.equal(result.now.toISOString(), "2026-08-28T19:00:00.002Z");
  });

  it("provider circuit day определяется временем обнаружения, а не billing day reserve", () => {
    const window = providerCircuitWindow(new Date("2026-08-28T19:00:01.000Z"));
    assert.equal(window.start.toISOString(), "2026-08-28T19:00:00.000Z");
    assert.equal(window.end.toISOString(), "2026-08-29T19:00:00.000Z");
  });

  it("missing/mismatched provider model открывает circuit; exact/dated Anthropic проходит", () => {
    assert.deepEqual(classifySettlementAnomaly(PRICE, { outcome: "success" }, 1n), {
      kind: "missing_resolved_model",
      circuitOpen: true,
      requestedModel: "claude-opus-5",
    });
    for (const outcome of ["provider_error", "unknown"] as const) {
      assert.equal(
        classifySettlementAnomaly(PRICE, { outcome, resolvedModel: "claude-sonnet-5" }, 1n)
          ?.circuitOpen,
        true,
        `mismatch ${outcome} не может обойти circuit`,
      );
    }
    assert.deepEqual(
      classifySettlementAnomaly(
        PRICE,
        { outcome: "success", resolvedModel: "claude-sonnet-5" },
        1n,
      ),
      {
        kind: "resolved_model_mismatch",
        circuitOpen: true,
        requestedModel: "claude-opus-5",
        resolvedModel: "claude-sonnet-5",
      },
    );
    assert.equal(
      classifySettlementAnomaly(
        PRICE,
        { outcome: "success", resolvedModel: "claude-opus-5-20260829" },
        1n,
      ),
      undefined,
    );
  });

  it("verified model без рассчитанного факта закрывается unknown без provider circuit", () => {
    assert.deepEqual(
      classifySettlementAnomaly(
        PRICE,
        { outcome: "success", resolvedModel: "claude-opus-5" },
        null,
      ),
      {
        kind: "missing_usage_or_cost",
        circuitOpen: false,
        requestedModel: "claude-opus-5",
        resolvedModel: "claude-opus-5",
      },
    );
  });

  it("preserves optional cache fields and rejects aggregate/split mismatch", () => {
    assert.deepEqual(normalizeUsage({ inputTokens: 2, outputTokens: 1 }), {
      inputTokens: 2,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      codeExecutionRequests: 0,
    });
    assert.deepEqual(
      normalizeSettlement({
        outcome: "success",
        resolvedModel: "claude-opus-5",
        usage: {
          inputTokens: 2,
          outputTokens: 1,
          cacheCreationInputTokens: 5,
          cacheCreation5mInputTokens: 2,
          cacheCreation1hInputTokens: 3,
        },
      }),
      {
        outcome: "success",
        resolvedModel: "claude-opus-5",
        usage: {
          inputTokens: 2,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 5,
          cacheCreation5mInputTokens: 2,
          cacheCreation1hInputTokens: 3,
          codeExecutionRequests: 0,
        },
        metadata: {},
      },
    );
    assert.throws(
      () =>
        normalizeUsage({
          inputTokens: 1,
          outputTokens: 1,
          cacheCreationInputTokens: 9,
          cacheCreation5mInputTokens: 2,
          cacheCreation1hInputTokens: 3,
        }),
      BadRequestException,
    );
  });

  it("embeddings как Agents-only consumer требует карточку агента", () => {
    assert.equal(consumerRequiresAgent("agents"), true);
    assert.equal(consumerRequiresAgent("embeddings"), true);
    assert.equal(consumerRequiresAgent("bot"), false);
  });
});
