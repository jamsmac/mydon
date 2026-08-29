import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  agentCapValue,
  billableInputTokenCeiling,
  DOCUMENTS_INPUT_OVERHEAD_TOKENS,
  DOCUMENTS_LEDGER_POLICY,
  exposureNano,
  globalCapValue,
  hashLedgerPayload,
  nanoToNumber,
  nanoToUsd,
  reserveCostNano,
  reserveProviderRouteCostNano,
  resolvedModelMatchesCatalogPrice,
  selectCatalogPrice,
  settlementCostNano,
  usdToNano,
  type LedgerPriceSnapshot,
} from "./llm-ledger.money";

const OPUS: LedgerPriceSnapshot = {
  version: 2,
  provider: "anthropic",
  model: "claude-opus-5",
  billingKind: "metered",
  settlementKind: "tokens",
  inputUsdPerMtok: "5.000000000",
  outputUsdPerMtok: "25.000000000",
  cacheReadUsdPerMtok: "0.500000000",
  cacheWrite5mUsdPerMtok: "6.250000000",
  cacheWrite1hUsdPerMtok: "10.000000000",
  fixedRequestUsd: "0.000000000",
  reservationCeilingUsd: null,
  codeExecutionUsdPerRequest: "0.004166667",
  documentsPolicy: DOCUMENTS_LEDGER_POLICY,
  validFrom: "2026-08-29T00:00:00.000Z",
};

describe("LLM-ledger: денежная математика", () => {
  it("Agents/embeddings reserve max active provider SKU; direct surfaces keep exact", () => {
    const cheaper = { ...OPUS, model: "cheap", outputUsdPerMtok: "10" };
    const expensive = { ...OPUS, model: "premium", outputUsdPerMtok: "40" };
    const base = {
      feature: "route-test",
      inputTokenCeiling: 0,
      outputTokenCeiling: 1_000_000,
    };
    assert.equal(
      reserveProviderRouteCostNano(cheaper, [cheaper, expensive], {
        ...base,
        consumer: "agents",
      }),
      usdToNano("40"),
    );
    assert.equal(
      reserveProviderRouteCostNano(cheaper, [cheaper, expensive], {
        ...base,
        consumer: "embeddings",
      }),
      usdToNano("40"),
    );
    assert.equal(
      reserveProviderRouteCostNano(cheaper, [cheaper, expensive], {
        ...base,
        consumer: "bot",
      }),
      usdToNano("10"),
    );
  });

  it("резерв берёт максимальную input/cache-ставку, факт — раздельный usage", () => {
    const reserved = reserveCostNano(OPUS, {
      consumer: "bot",
      feature: "chat",
      inputTokenCeiling: 1_000,
      outputTokenCeiling: 200,
    });
    assert.equal(nanoToUsd(reserved), "0.015000000");

    const actual = settlementCostNano(OPUS, {
      consumer: "bot",
      feature: "chat",
      // Шлюз может прислать свою цену, но token-тариф считается только по snapshot Core.
      providerReportedUsd: 999,
      usage: {
        inputTokens: 1_000,
        outputTokens: 200,
        cacheReadInputTokens: 100,
        cacheCreationInputTokens: 50,
      },
    });
    assert.equal(nanoToUsd(actual!), "0.010550000");
  });

  it("cache breakdown считает 5m/1h раздельно, aggregate-only — по max rate", () => {
    const split = settlementCostNano(OPUS, {
      consumer: "bot",
      feature: "chat",
      usage: {
        inputTokens: 1_000,
        outputTokens: 200,
        cacheReadInputTokens: 100,
        cacheCreationInputTokens: 50,
        cacheCreation5mInputTokens: 30,
        cacheCreation1hInputTokens: 20,
      },
    });
    assert.equal(nanoToUsd(split!), "0.010437500");
    assert.throws(
      () =>
        settlementCostNano(OPUS, {
          consumer: "bot",
          feature: "chat",
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationInputTokens: 51,
            cacheCreation5mInputTokens: 30,
            cacheCreation1hInputTokens: 20,
          },
        }),
      /не равен сумме/,
    );
  });

  it("documents резервирует overhead и ровно один container minimum на Messages request", () => {
    const reserved = reserveCostNano(OPUS, {
      consumer: "documents",
      feature: "bot.report",
      inputTokenCeiling: 0,
      outputTokenCeiling: 0,
    });
    assert.equal(
      billableInputTokenCeiling(OPUS, "documents", 0),
      DOCUMENTS_INPUT_OVERHEAD_TOKENS,
      "client ceiling=0 не убирает server-owned overhead",
    );
    assert.equal(nanoToUsd(reserved), "1.284166667");
    const actual = settlementCostNano(OPUS, {
      consumer: "documents",
      feature: "bot.report",
      usage: { inputTokens: 0, outputTokens: 0, codeExecutionRequests: 2 },
    });
    assert.equal(nanoToUsd(actual!), "0.004166667");
  });

  it("subscription явно стоит ноль; provider_reported берёт серверный ceiling", () => {
    assert.equal(
      reserveCostNano(
        { ...OPUS, billingKind: "subscription" },
        {
          consumer: "agents",
          feature: "chat",
          inputTokenCeiling: 10_000_000,
          outputTokenCeiling: 10_000_000,
        },
      ),
      0n,
    );
    const reported: LedgerPriceSnapshot = {
      ...OPUS,
      settlementKind: "provider_reported",
      reservationCeilingUsd: "0.750000000",
    };
    assert.equal(
      nanoToUsd(
        reserveCostNano(reported, {
          consumer: "embeddings",
          feature: "embed",
          inputTokenCeiling: 1,
          outputTokenCeiling: 0,
        }),
      ),
      "0.750000000",
    );
    assert.equal(
      nanoToUsd(
        settlementCostNano(reported, {
          consumer: "embeddings",
          feature: "embed",
          providerReportedUsd: 0.125,
        })!,
      ),
      "0.125000000",
    );
    assert.equal(
      settlementCostNano(OPUS, {
        consumer: "agents",
        feature: "chat",
        providerReportedUsd: 10,
      }),
      null,
      "providerReportedUsd без usage не закрывает token-резерв как success",
    );
  });

  it("exposure: reserved=резерв, settled=факт, failed=факт или резерв, released/denied=0", () => {
    assert.equal(exposureNano("reserved", null, "0.600000000", null), usdToNano("0.6"));
    assert.equal(exposureNano("settled", "success", "0.6", "0.4"), usdToNano("0.4"));
    assert.equal(exposureNano("failed", "provider_error", "0.6", "0.2"), usdToNano("0.2"));
    assert.equal(exposureNano("failed", "provider_error", "0.6", null), usdToNano("0.6"));
    assert.equal(
      exposureNano("failed", "unknown", "0.6", "0.2"),
      usdToNano("0.6"),
      "partial usage unknown — только lower bound, reserve не освобождается",
    );
    assert.equal(exposureNano("failed", "unknown", "0.6", "0.8"), usdToNano("0.8"));
    assert.equal(exposureNano("released", null, "0.6", null), 0n);
    assert.equal(exposureNano("denied", null, "0.6", null), 0n);
  });

  it("nano-USD не теряет малые траты, а JSON response получает number", () => {
    assert.equal(nanoToUsd(usdToNano("0.000000001")), "0.000000001");
    assert.equal(nanoToNumber(usdToNano("1.250000009")), 1.250000009);
    assert.equal(usdToNano("0.0000000001", "floor"), 0n);
    assert.equal(usdToNano("0.0000000001", "ceil"), 1n);
  });
});

describe("LLM-ledger: idempotency и лимиты", () => {
  it("хеш не зависит от порядка JSON-ключей, но меняется при другом ceiling", () => {
    const a = hashLedgerPayload({ requestKey: "r1", metadata: { b: 2, a: 1 }, ceiling: 10 });
    const b = hashLedgerPayload({ ceiling: 10, metadata: { a: 1, b: 2 }, requestKey: "r1" });
    const c = hashLedgerPayload({ requestKey: "r1", metadata: { b: 2, a: 1 }, ceiling: 11 });
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  it("hash учитывает own JSON-ключ __proto__ без prototype pollution", () => {
    const hostile = JSON.parse('{"__proto__":{"admin":true},"safe":1}') as Record<string, unknown>;
    assert.notEqual(hashLedgerPayload(hostile), hashLedgerPayload({ safe: 1 }));
    assert.equal(({} as { admin?: boolean }).admin, undefined);
  });

  it("LLM_GLOBAL DB/env важнее legacy; у агента карточка важнее общего ключа", () => {
    assert.equal(
      globalCapValue(
        { AGENT_GLOBAL_BUDGET_USD: "3" },
        { LLM_GLOBAL_DAILY_BUDGET_USD: "7", AGENT_GLOBAL_BUDGET_USD: "4" },
      ),
      "7",
    );
    assert.equal(
      globalCapValue(
        { LLM_GLOBAL_DAILY_BUDGET_USD: "9", AGENT_GLOBAL_BUDGET_USD: "3" },
        { LLM_GLOBAL_DAILY_BUDGET_USD: "7" },
      ),
      "9",
    );
    assert.equal(agentCapValue("1.5", { AGENT_DAILY_BUDGET_USD: "2" }, {}), "1.5");
    assert.equal(
      agentCapValue(null, { AGENT_DAILY_BUDGET_USD: "2" }, { AGENT_DAILY_BUDGET_USD: "3" }),
      "2",
    );
    assert.equal(globalCapValue({}, {}), "10", "новая установка и UI должны видеть один дефолт");
  });

  it("settlement разрешает dated canonical id только Anthropic и без qualifiers", () => {
    assert.equal(
      resolvedModelMatchesCatalogPrice("anthropic", "claude-opus-5", "claude-opus-5"),
      true,
    );
    assert.equal(
      resolvedModelMatchesCatalogPrice("anthropic", "claude-opus-5-20260829", "claude-opus-5"),
      true,
    );
    assert.equal(
      resolvedModelMatchesCatalogPrice(
        "anthropic",
        "claude-opus-5-20260829:nitro",
        "claude-opus-5",
      ),
      false,
    );
    assert.equal(
      resolvedModelMatchesCatalogPrice("anthropic", "claude-opus-5:nitro", "claude-opus-5"),
      false,
    );
    assert.equal(
      resolvedModelMatchesCatalogPrice("anthropic", "claude-opus-5/fast", "claude-opus-5"),
      false,
    );
    assert.equal(
      resolvedModelMatchesCatalogPrice("anthropic", "claude-opus-5@turbo", "claude-opus-5"),
      false,
    );
    assert.equal(resolvedModelMatchesCatalogPrice("openai", "gpt-5-20260829", "gpt-5"), false);
    assert.equal(resolvedModelMatchesCatalogPrice("openai", "gpt-5", "gpt-5"), true);
  });

  it("reserve требует exact catalog row, включая dated и qualified модели", () => {
    const base = {
      model: "claude-opus-5",
      validFrom: new Date("2026-01-01T00:00:00.000Z"),
      inputUsdPerMtok: "5.000000000",
    };
    const premium = {
      model: "claude-opus-5-premium",
      validFrom: new Date("2026-02-01T00:00:00.000Z"),
      inputUsdPerMtok: "50.000000000",
    };
    const dotted = {
      model: "claude-opus-5.1",
      validFrom: new Date("2026-03-01T00:00:00.000Z"),
      inputUsdPerMtok: "75.000000000",
    };
    const dated = {
      model: "claude-opus-5-20260829",
      validFrom: new Date("2026-04-01T00:00:00.000Z"),
      inputUsdPerMtok: "80.000000000",
    };
    const nitro = {
      model: "claude-opus-5:nitro",
      validFrom: new Date("2026-05-01T00:00:00.000Z"),
      inputUsdPerMtok: "90.000000000",
    };
    const rows = [base, premium, dotted, dated, nitro];

    assert.equal(selectCatalogPrice(rows, premium.model), premium);
    assert.equal(selectCatalogPrice(rows, dotted.model), dotted);
    assert.equal(selectCatalogPrice(rows, dated.model), dated);
    assert.equal(selectCatalogPrice(rows, nitro.model), nitro);
    assert.equal(selectCatalogPrice([base], premium.model), undefined);
    assert.equal(selectCatalogPrice([base], dotted.model), undefined);
    assert.equal(selectCatalogPrice([base], dated.model), undefined);
    assert.equal(selectCatalogPrice([base], nitro.model), undefined);
    assert.equal(selectCatalogPrice([base], "claude-opus-5/fast"), undefined);
  });

  it("exact selection считает % и _ буквальными символами", () => {
    const literal = {
      model: "vendor/model_%",
      validFrom: new Date("2026-01-01T00:00:00.000Z"),
    };
    assert.equal(selectCatalogPrice([literal], "vendor/model_%"), literal);
    assert.equal(selectCatalogPrice([literal], "vendor/model_AX"), undefined);
  });
});
