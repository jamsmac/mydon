import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BadRequestException } from "@nestjs/common";
import type { LedgerPriceSnapshot } from "./llm-ledger.money";
import {
  classifySettlementAnomaly,
  consumerRequiresAgent,
  normalizeSettlement,
  normalizeUsage,
  providerCircuitWindow,
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

describe("LLM-ledger settlement invariants", () => {
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
