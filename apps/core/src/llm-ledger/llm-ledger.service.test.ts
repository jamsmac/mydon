import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { agentTaskLlmJob, llmModelPrice, llmSpend, systemConfig } from "@mydon/db";
import { tashkentDay } from "@mydon/shared";
import type { ReleaseLlmDto, ReserveLlmDto, SettleLlmDto } from "./llm-ledger.dto";
import { hashLedgerPayload, usdToNano, type LedgerPriceSnapshot } from "./llm-ledger.money";
import {
  classifySettlementAnomaly,
  consumerRequiresAgent,
  flatOpenAiPriceTierDenial,
  LLM_STUCK_RESERVATION_THRESHOLD_MINUTES,
  LlmLedgerService,
  llmMonitoringFrame,
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

/** Terminal spend double: closing-operation replay must not issue a second UPDATE. */
function terminalSpendTx(row: Record<string, unknown>) {
  let updates = 0;
  const tx = {
    execute: async () => undefined,
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => {
        if (table === agentTaskLlmJob) {
          return { where: () => ({ limit: async () => [] }) };
        }
        assert.equal(table, llmSpend);
        if (fields) {
          return { where: () => ({ limit: async () => [row] }) };
        }
        return {
          where: () => ({
            limit: () => ({ for: async () => [row] }),
          }),
        };
      },
    }),
    update: () => {
      updates += 1;
      throw new Error("terminal replay must not update llm_spend");
    },
  } as never;
  return { tx, updateCount: () => updates };
}

interface MonitoringFixture {
  config?: Record<string, string>;
  daily?: {
    knownCostUsd: string;
    globalExposureUsd: string;
    reservedUsd: string;
  };
  latest?: Record<string, unknown> | null;
  stuck?: {
    count: number | string;
    reservedUsd: string;
    oldestReservedAt: Date | string | null;
  };
  failures?: {
    count: number | string;
    providerErrorCount: number | string;
    unknownCount: number | string;
  };
  lastFailure?: Record<string, unknown> | null;
  circuits?: Array<Record<string, unknown>>;
}

/** Узкий read-only DB double для проверки безопасного monitoring snapshot. */
function monitoringDb(fixture: MonitoringFixture) {
  return {
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => {
        if (table === systemConfig) {
          return Promise.resolve(
            Object.entries(fixture.config ?? {}).map(([key, value]) => ({ key, value })),
          );
        }
        assert.equal(table, llmSpend);
        const keys = Object.keys(fields ?? {});
        if (keys.includes("knownCostUsd")) {
          return {
            where: async () => [
              fixture.daily ?? {
                knownCostUsd: "0",
                globalExposureUsd: "0",
                reservedUsd: "0",
              },
            ],
          };
        }
        if (keys.includes("feature")) {
          return {
            where: () => ({
              orderBy: () => ({
                limit: async () => (fixture.latest ? [fixture.latest] : []),
              }),
            }),
          };
        }
        if (keys.includes("oldestReservedAt")) {
          return {
            where: async () => [
              fixture.stuck ?? { count: 0, reservedUsd: "0", oldestReservedAt: null },
            ],
          };
        }
        if (keys.includes("providerErrorCount")) {
          return {
            where: async () => [
              fixture.failures ?? { count: 0, providerErrorCount: 0, unknownCount: 0 },
            ],
          };
        }
        if (keys.includes("requestedModel")) {
          return {
            where: () => ({
              orderBy: () => ({
                limit: async () => (fixture.lastFailure ? [fixture.lastFailure] : []),
              }),
            }),
          };
        }
        return {
          where: () => ({
            orderBy: async () => fixture.circuits ?? [],
          }),
        };
      },
    }),
  } as never;
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
  it("settle exact replay returns the stored result without a second write", async () => {
    const price = policyPrice();
    const spendId = "spend-settle-exact-replay";
    const body: SettleLlmDto = {
      outcome: "success",
      providerRequestId: "provider-response-1",
      resolvedModel: "gpt-5.6-sol",
      usage: { inputTokens: 120, outputTokens: 30 },
      metadata: { attempt: 1 },
    };
    const row = {
      ...priorReservation(RESERVE_REQUEST, price),
      id: spendId,
      provider: RESERVE_REQUEST.provider,
      status: "settled",
      settlementHash: hashLedgerPayload(normalizeSettlement(body)),
    };
    const fixture = terminalSpendTx(row);

    const result = await new LlmLedgerService({} as never).settleInTx(fixture.tx, spendId, body);

    assert.deepEqual(result, { status: "settled", replay: true });
    assert.equal(fixture.updateCount(), 0);
  });

  it("settle replay with a different settlement is a 409 conflict", async () => {
    const price = policyPrice();
    const spendId = "spend-settle-mismatch";
    const original: SettleLlmDto = {
      outcome: "success",
      providerRequestId: "provider-response-1",
      resolvedModel: "gpt-5.6-sol",
      usage: { inputTokens: 120, outputTokens: 30 },
    };
    const row = {
      ...priorReservation(RESERVE_REQUEST, price),
      id: spendId,
      provider: RESERVE_REQUEST.provider,
      status: "settled",
      settlementHash: hashLedgerPayload(normalizeSettlement(original)),
    };
    const fixture = terminalSpendTx(row);

    await assert.rejects(
      () =>
        new LlmLedgerService({} as never).settleInTx(fixture.tx, spendId, {
          ...original,
          usage: { inputTokens: 120, outputTokens: 31 },
        }),
      (error: unknown) => error instanceof ConflictException && error.getStatus() === 409,
    );
    assert.equal(fixture.updateCount(), 0);
  });

  it("release exact replay returns the stored result without a second write", async () => {
    const price = policyPrice();
    const spendId = "spend-release-exact-replay";
    const body: ReleaseLlmDto = { reason: "provider_not_called" };
    const row = {
      ...priorReservation(RESERVE_REQUEST, price),
      id: spendId,
      provider: RESERVE_REQUEST.provider,
      status: "released",
      reason: body.reason,
    };
    const fixture = terminalSpendTx(row);

    const result = await new LlmLedgerService({} as never).releaseInTx(fixture.tx, spendId, body);

    assert.deepEqual(result, { status: "released", replay: true });
    assert.equal(fixture.updateCount(), 0);
  });

  it("release replay with a different reason is a 409 conflict", async () => {
    const price = policyPrice();
    const spendId = "spend-release-mismatch";
    const row = {
      ...priorReservation(RESERVE_REQUEST, price),
      id: spendId,
      provider: RESERVE_REQUEST.provider,
      status: "released",
      reason: "provider_not_called",
    };
    const fixture = terminalSpendTx(row);

    await assert.rejects(
      () =>
        new LlmLedgerService({} as never).releaseInTx(fixture.tx, spendId, {
          reason: "different_pre_dispatch_reason",
        }),
      (error: unknown) => error instanceof ConflictException && error.getStatus() === 409,
    );
    assert.equal(fixture.updateCount(), 0);
  });

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

  it("глобальный $10 cap разрешает ровно остаток и отклоняет один nano сверху", async () => {
    const config = {
      LLM_ENABLED: "1",
      LLM_MAX_RESERVATION_USD: "3",
      LLM_GLOBAL_DAILY_BUDGET_USD: "10",
    };

    const exact = reservePolicyTx(config, "3", { exposureUsd: "7" });
    const allowed = await new LlmLedgerService({} as never).reserveInTx(exact.tx, {
      ...RESERVE_REQUEST,
      requestKey: "core-policy-global-cap-exact",
    });
    assert.equal(allowed.allowed, true);
    assert.equal(exact.inserted[0]?.status, "reserved");

    const over = reservePolicyTx(config, "3", { exposureUsd: "7.000000001" });
    const denied = await new LlmLedgerService({} as never).reserveInTx(over.tx, {
      ...RESERVE_REQUEST,
      requestKey: "core-policy-global-cap-over",
    });
    assert.equal(denied.allowed, false);
    assert.match(denied.reason ?? "", /Дневной LLM-потолок/);
    assert.equal(over.inserted[0]?.status, "denied");
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

  it("ledger replay отзывает reserve после снижения потолка одного вызова", async () => {
    const price = policyPrice({ outputUsdPerMtok: "3" });
    const prior = priorReservation(RESERVE_REQUEST, price, {
      reservedUsd: "3.000000000",
    });
    const replay = reservePolicyTx(
      {
        LLM_ENABLED: "1",
        LLM_MAX_RESERVATION_USD: "2.999999999",
        LLM_GLOBAL_DAILY_BUDGET_USD: "10",
      },
      "3",
      { prior, exposureUsd: "3", prices: [price] },
    );

    const response = await new LlmLedgerService({} as never).reserveInTx(
      replay.tx,
      RESERVE_REQUEST,
    );
    assert.equal(response.allowed, false);
    assert.equal(response.status, "reserved");
    assert.match(response.reason ?? "", /превышает потолок/);
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

  it("monitoring фиксирует единый день, reset и stale boundary на ташкентской полуночи", () => {
    const before = llmMonitoringFrame(new Date("2026-08-30T18:59:59.999Z"));
    assert.equal(before.day, "2026-08-30");
    assert.equal(before.start.toISOString(), "2026-08-29T19:00:00.000Z");
    assert.equal(before.end.toISOString(), "2026-08-30T19:00:00.000Z");
    assert.equal(before.staleBefore.toISOString(), "2026-08-30T18:54:59.999Z");
    assert.equal(LLM_STUCK_RESERVATION_THRESHOLD_MINUTES, 5);

    const after = llmMonitoringFrame(new Date("2026-08-30T19:00:00.000Z"));
    assert.equal(after.day, "2026-08-31");
    assert.equal(after.start.toISOString(), "2026-08-30T19:00:00.000Z");
    assert.equal(after.end.toISOString(), "2026-08-31T19:00:00.000Z");
  });

  it("monitoring честно разделяет факт, exposure и reserve и дедуплицирует circuit", async () => {
    const secret = "sk-do-not-return";
    const service = new LlmLedgerService(
      monitoringDb({
        config: { LLM_GLOBAL_DAILY_BUDGET_USD: "10" },
        daily: {
          knownCostUsd: "1.250000001",
          globalExposureUsd: "3.750000002",
          reservedUsd: "2.500000001",
        },
        latest: {
          provider: "openai",
          consumer: "cc",
          feature: "assistant",
          requestedModel: "gpt-5.6-sol",
          resolvedModel: "gpt-5.6-sol-2026-08-01",
          status: "failed",
          outcome: "unknown",
          actualUsd: "0.000000001",
          metadata: { secret, _llmLedger: { lowerBound: true } },
          settledAt: null,
          failedAt: new Date("2026-08-30T18:58:00.000Z"),
        },
        stuck: {
          count: "2",
          reservedUsd: "2.500000001",
          oldestReservedAt: "2026-08-29T10:00:00.000Z",
        },
        failures: { count: "3", providerErrorCount: "1", unknownCount: "2" },
        lastFailure: {
          failedAt: new Date("2026-08-30T18:58:00.000Z"),
          provider: "openai",
          requestedModel: "gpt-5.6-sol",
          resolvedModel: null,
          outcome: "unknown",
          reason: `provider result unknown: ${secret}`,
        },
        circuits: [
          {
            provider: "openai",
            failedAt: new Date("2026-08-30T18:50:00.000Z"),
            reason: "later anomaly",
          },
          {
            provider: "anthropic",
            failedAt: new Date("2026-08-30T18:45:00.000Z"),
            reason: null,
          },
          {
            provider: "openai",
            failedAt: new Date("2026-08-30T18:40:00.000Z"),
            reason: "first anomaly",
          },
        ],
      }),
    );

    const snapshot = await service.monitoring(new Date("2026-08-30T18:59:00.000Z"));
    assert.deepEqual(snapshot.budget, {
      globalCapUsd: 10,
      knownCostUsd: 1.250000001,
      globalExposureUsd: 3.750000002,
      reservedUsd: 2.500000001,
      remainingUsd: 6.249999998,
    });
    assert.deepEqual(snapshot.latestCompleted, {
      provider: "openai",
      consumer: "cc",
      feature: "assistant",
      requestedModel: "gpt-5.6-sol",
      resolvedModel: "gpt-5.6-sol-2026-08-01",
      status: "failed",
      outcome: "unknown",
      costUsd: 0.000000001,
      costBasis: "lower_bound",
      completedAt: "2026-08-30T18:58:00.000Z",
    });
    assert.deepEqual(snapshot.stuckReservations, {
      thresholdMinutes: 5,
      count: 2,
      reservedUsd: 2.500000001,
      oldestReservedAt: "2026-08-29T10:00:00.000Z",
    });
    assert.equal(snapshot.failuresToday.count, 3);
    assert.equal(snapshot.failuresToday.last?.reason, "Исход запроса неизвестен");
    assert.deepEqual(snapshot.openCircuits, [
      {
        provider: "openai",
        openedAt: "2026-08-30T18:40:00.000Z",
        resetsAt: "2026-08-30T19:00:00.000Z",
        reason: "Аномалия модели открыла circuit",
      },
      {
        provider: "anthropic",
        openedAt: "2026-08-30T18:45:00.000Z",
        resetsAt: "2026-08-30T19:00:00.000Z",
        reason: "Аномалия модели открыла circuit",
      },
    ]);
    assert.doesNotMatch(JSON.stringify(snapshot), /sk-do-not-return|requestKey|_llmLedger/);
  });

  it("monitoring fail-closed показывает invalid cap и не подменяет unknown cost резервом", async () => {
    const service = new LlmLedgerService(
      monitoringDb({
        config: { LLM_GLOBAL_DAILY_BUDGET_USD: "not-money" },
        daily: {
          knownCostUsd: "0",
          globalExposureUsd: "2",
          reservedUsd: "2",
        },
        latest: {
          provider: "anthropic",
          consumer: "documents",
          feature: "render",
          requestedModel: "claude-opus-5",
          resolvedModel: null,
          status: "failed",
          outcome: "unknown",
          actualUsd: null,
          metadata: null,
          settledAt: null,
          failedAt: new Date("2026-08-30T10:00:00.000Z"),
        },
      }),
    );

    const snapshot = await service.monitoring(new Date("2026-08-30T12:00:00.000Z"));
    assert.equal(snapshot.budget.globalCapUsd, 0);
    assert.equal(snapshot.budget.remainingUsd, 0);
    assert.match(snapshot.budget.configError ?? "", /не является неотрицательной суммой/);
    assert.equal(snapshot.latestCompleted?.costUsd, null);
    assert.equal(snapshot.latestCompleted?.costBasis, "unknown");
  });

  it("успешный Documents settlement остаётся lower bound, а не мнимым итогом", async () => {
    const snapshot = await new LlmLedgerService(
      monitoringDb({
        latest: {
          provider: "anthropic",
          consumer: "documents",
          feature: "document:pdf",
          requestedModel: "claude-opus-5",
          resolvedModel: "claude-opus-5",
          status: "settled",
          outcome: "success",
          actualUsd: "0.125000001",
          metadata: {},
          settledAt: new Date("2026-08-30T11:59:00.000Z"),
          failedAt: null,
        },
      }),
    ).monitoring(new Date("2026-08-30T12:00:00.000Z"));

    assert.equal(snapshot.latestCompleted?.costUsd, 0.125000001);
    assert.equal(snapshot.latestCompleted?.costBasis, "lower_bound");
  });

  it("aggregate-only cache creation показывается как верхняя граница", async () => {
    const snapshot = await new LlmLedgerService(
      monitoringDb({
        latest: {
          provider: "anthropic",
          consumer: "agents",
          feature: "assistant",
          requestedModel: "claude-opus-5",
          resolvedModel: "claude-opus-5",
          status: "settled",
          outcome: "success",
          actualUsd: "0.250000001",
          cacheCreationInputTokens: 10,
          cacheCreation5mInputTokens: null,
          cacheCreation1hInputTokens: null,
          metadata: {},
          settledAt: new Date("2026-08-30T11:59:00.000Z"),
          failedAt: null,
        },
      }),
    ).monitoring(new Date("2026-08-30T12:00:00.000Z"));

    assert.equal(snapshot.latestCompleted?.costUsd, 0.250000001);
    assert.equal(snapshot.latestCompleted?.costBasis, "upper_bound");
  });

  it("нулевой aggregate-only cache не превращает точную цену в границу", async () => {
    const snapshot = await new LlmLedgerService(
      monitoringDb({
        latest: {
          provider: "anthropic",
          consumer: "agents",
          feature: "assistant",
          requestedModel: "claude-opus-5",
          resolvedModel: "claude-opus-5",
          status: "settled",
          outcome: "success",
          actualUsd: "0.125",
          cacheCreationInputTokens: 0,
          cacheCreation5mInputTokens: null,
          cacheCreation1hInputTokens: null,
          metadata: {},
          settledAt: new Date("2026-08-30T11:59:00.000Z"),
          failedAt: null,
        },
      }),
    ).monitoring(new Date("2026-08-30T12:00:00.000Z"));

    assert.equal(snapshot.latestCompleted?.costBasis, "actual");
  });

  it("aggregate-only cache вместе с lower bound отмечает сумму как оценку", async () => {
    const snapshot = await new LlmLedgerService(
      monitoringDb({
        latest: {
          provider: "anthropic",
          consumer: "documents",
          feature: "document:pdf",
          requestedModel: "claude-opus-5",
          resolvedModel: "claude-opus-5",
          status: "settled",
          outcome: "success",
          actualUsd: "0.250000001",
          cacheCreationInputTokens: 10,
          cacheCreation5mInputTokens: null,
          cacheCreation1hInputTokens: null,
          metadata: {},
          settledAt: new Date("2026-08-30T11:59:00.000Z"),
          failedAt: null,
        },
      }),
    ).monitoring(new Date("2026-08-30T12:00:00.000Z"));

    assert.equal(snapshot.latestCompleted?.costBasis, "estimate");
  });

  it("ошибка сегодня видна по failedAt, даже если reserve относился ко вчерашнему billing day", async () => {
    const snapshot = await new LlmLedgerService(
      monitoringDb({
        daily: { knownCostUsd: "0", globalExposureUsd: "0", reservedUsd: "0" },
        failures: { count: 1, providerErrorCount: 1, unknownCount: 0 },
        lastFailure: {
          day: "2026-08-29",
          failedAt: new Date("2026-08-30T08:00:00.000Z"),
          provider: "openai",
          requestedModel: "gpt-5.6-sol",
          resolvedModel: "gpt-5.6-sol",
          outcome: "provider_error",
          reason: "HTTP 429",
        },
      }),
    ).monitoring(new Date("2026-08-30T12:00:00.000Z"));

    assert.equal(snapshot.day, "2026-08-30");
    assert.equal(snapshot.failuresToday.count, 1);
    assert.equal(snapshot.failuresToday.last?.failedAt, "2026-08-30T08:00:00.000Z");
    assert.equal(snapshot.failuresToday.last?.outcome, "provider_error");
  });

  it("monitoring defensive mapping исключает denied/released из latest", async () => {
    const latestBase = {
      provider: "openai",
      consumer: "bot",
      feature: "chat",
      requestedModel: "gpt-5.6-sol",
      resolvedModel: null,
      outcome: null,
      actualUsd: null,
      metadata: {},
      settledAt: null,
      failedAt: null,
    };
    for (const status of ["denied", "released"] as const) {
      const snapshot = await new LlmLedgerService(
        monitoringDb({ latest: { ...latestBase, status } }),
      ).monitoring(new Date("2026-08-30T12:00:00.000Z"));
      assert.equal(snapshot.latestCompleted, null);
    }
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
