import { createHash } from "node:crypto";
import type { LlmTokenUsage } from "@mydon/shared";

export const NANO_USD = 1_000_000_000n;
const TOKENS_PER_MTOK = 1_000_000n;
export const DOCUMENTS_INPUT_OVERHEAD_TOKENS = 128_000;

export const DOCUMENTS_LEDGER_POLICY = {
  version: 1,
  inputOverheadTokens: DOCUMENTS_INPUT_OVERHEAD_TOKENS,
  codeExecution: {
    exact: false,
    basis: "container_5m_minimum",
    monthlyFreePoolApplied: false,
  },
} as const;

export interface LedgerPriceSnapshot {
  version: 2;
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
  documentsPolicy: typeof DOCUMENTS_LEDGER_POLICY;
  validFrom: string;
}

/**
 * Decimal USD -> nano-USD без binary-float в середине вычисления.
 *
 * Тарифы и денежные поля БД имеют scale=9. Конфиг может прийти
 * с большим числом знаков: для потолка отбрасываем хвост (не разрешая
 * потратить больше), для факта/резерва округляем вверх.
 */
export function usdToNano(value: string | number, rounding: "floor" | "ceil" = "floor"): bigint {
  let raw = typeof value === "number" ? numberAsDecimal(value) : value.trim().replace(",", ".");
  let match = raw.match(/^(\d+)(?:\.(\d*))?$/);
  // config-spec принимает любой Number, включая 1e3. Не расходимся с панелью:
  // разворачиваем exponent в decimal до перевода в BigInt.
  if (!match && typeof value === "string") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      raw = numberAsDecimal(parsed);
      match = raw.match(/^(\d+)(?:\.(\d*))?$/);
    }
  }
  if (!match) throw new Error(`Некорректная сумма USD: ${raw}`);
  const whole = BigInt(match[1]);
  const fraction = match[2] ?? "";
  const kept = fraction.slice(0, 9).padEnd(9, "0");
  const discarded = fraction.slice(9);
  const bump = rounding === "ceil" && /[1-9]/.test(discarded) ? 1n : 0n;
  return whole * NANO_USD + BigInt(kept || "0") + bump;
}

export function nanoToUsd(value: bigint): string {
  if (value < 0n) throw new Error("USD не может быть отрицательным");
  const whole = value / NANO_USD;
  const fraction = (value % NANO_USD).toString().padStart(9, "0");
  return `${whole}.${fraction}`;
}

export function nanoToNumber(value: bigint): number {
  return Number(nanoToUsd(value));
}

/** Канонический SHA-256: порядок ключей metadata не ломает retry. */
export function hashLedgerPayload(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export function reserveCostNano(
  price: LedgerPriceSnapshot,
  request: {
    consumer: string;
    feature: string;
    inputTokenCeiling: number;
    outputTokenCeiling: number;
  },
): bigint {
  if (price.billingKind === "subscription") return 0n;
  if (price.settlementKind === "provider_reported") {
    if (price.reservationCeilingUsd === null) {
      throw new Error("provider_reported тариф не имеет reservation_ceiling_usd");
    }
    return usdToNano(price.reservationCeilingUsd, "ceil");
  }

  // Кэш-состав в reserve ещё неизвестен. Все input-токены оцениваем по
  // самой дорогой input/cache-ставке: резерв обязан быть верхней границей.
  const inputRate = maxBigInt(
    usdToNano(price.inputUsdPerMtok, "ceil"),
    usdToNano(price.cacheReadUsdPerMtok, "ceil"),
    usdToNano(price.cacheWrite5mUsdPerMtok, "ceil"),
    usdToNano(price.cacheWrite1hUsdPerMtok, "ceil"),
  );
  const numerator =
    inputRate *
      BigInt(billableInputTokenCeiling(price, request.consumer, request.inputTokenCeiling)) +
    usdToNano(price.outputUsdPerMtok, "ceil") * BigInt(request.outputTokenCeiling);
  const tokenCost = divideCeil(numerator, TOKENS_PER_MTOK);
  const codeExecutionReserve = isDocumentCodeExecution(request.consumer, request.feature)
    ? usdToNano(price.codeExecutionUsdPerRequest, "ceil")
    : 0n;
  return tokenCost + usdToNano(price.fixedRequestUsd, "ceil") + codeExecutionReserve;
}

/**
 * Generic Agents/embeddings gateways are routing surfaces: requested alias is
 * not proof of the physical SKU. Reserve the highest active SKU cost for that
 * provider route; direct Bot/CC/Documents calls keep exact requested pricing.
 */
export function reserveProviderRouteCostNano(
  requestedPrice: LedgerPriceSnapshot,
  activeProviderPrices: readonly LedgerPriceSnapshot[],
  request: {
    consumer: string;
    feature: string;
    inputTokenCeiling: number;
    outputTokenCeiling: number;
  },
): bigint {
  const prices =
    request.consumer === "agents" || request.consumer === "embeddings"
      ? activeProviderPrices
      : [requestedPrice];
  return maxBigInt(...prices.map((price) => reserveCostNano(price, request)));
}

export function settlementCostNano(
  price: LedgerPriceSnapshot,
  request: {
    consumer: string;
    feature: string;
    usage?: LlmTokenUsage;
    providerReportedUsd?: number;
  },
): bigint | null {
  if (price.billingKind === "subscription") return 0n;
  if (price.settlementKind === "provider_reported") {
    return request.providerReportedUsd === undefined
      ? null
      : usdToNano(request.providerReportedUsd, "ceil");
  }
  if (!request.usage) return null;

  const usage = request.usage;
  const cacheCreationCost = cacheCreationCostNumerator(price, usage);
  const numerator =
    usdToNano(price.inputUsdPerMtok, "ceil") * BigInt(usage.inputTokens) +
    usdToNano(price.outputUsdPerMtok, "ceil") * BigInt(usage.outputTokens) +
    usdToNano(price.cacheReadUsdPerMtok, "ceil") * BigInt(usage.cacheReadInputTokens ?? 0) +
    cacheCreationCost;
  const codeExecutionCost = isDocumentCodeExecution(request.consumer, request.feature)
    ? usdToNano(price.codeExecutionUsdPerRequest, "ceil")
    : 0n;
  return (
    divideCeil(numerator, TOKENS_PER_MTOK) +
    usdToNano(price.fixedRequestUsd, "ceil") +
    codeExecutionCost
  );
}

export function exposureNano(
  status: "reserved" | "settled" | "failed" | "released" | "denied",
  outcome: "success" | "provider_error" | "unknown" | null,
  reservedUsd: string,
  actualUsd: string | null,
): bigint {
  if (status === "reserved") return usdToNano(reservedUsd, "ceil");
  if (status === "settled") return usdToNano(actualUsd ?? "0", "ceil");
  if (status === "failed" && outcome === "unknown") {
    return maxBigInt(usdToNano(reservedUsd, "ceil"), usdToNano(actualUsd ?? "0", "ceil"));
  }
  if (status === "failed") return usdToNano(actualUsd ?? reservedUsd, "ceil");
  return 0n;
}

/** Client ceiling + server-owned Documents protocol/skills overhead. */
export function billableInputTokenCeiling(
  price: LedgerPriceSnapshot,
  consumer: string,
  clientInputTokenCeiling: number,
): number {
  return (
    clientInputTokenCeiling +
    (isDocumentCodeExecution(consumer, "") ? price.documentsPolicy.inputOverheadTokens : 0)
  );
}

/**
 * Провайдер может вернуть canonical Anthropic id с dated suffix, даже если
 * запрос был сделан по alias. Для остальных провайдеров разрешён только exact.
 * Qualifiers не принимаем: `:nitro` и `/fast` могут быть отдельным premium SKU.
 */
export function resolvedModelMatchesCatalogPrice(
  provider: string,
  resolvedModel: string,
  catalogModel: string,
): boolean {
  if (!catalogModel) return false;
  if (resolvedModel === catalogModel) return true;
  if (provider !== "anthropic" || !resolvedModel.startsWith(catalogModel)) return false;
  return /^-\d{8}$/.test(resolvedModel.slice(catalogModel.length));
}

/** Reserve использует только exact catalog model; из overlap берём свежую цену. */
export function selectCatalogPrice<T extends { model: string; validFrom: Date }>(
  rows: readonly T[],
  requestedModel: string,
): T | undefined {
  return rows
    .filter((row) => row.model === requestedModel)
    .sort((left, right) => right.validFrom.getTime() - left.validFrom.getTime())[0];
}

/** Новый единый ключ важнее legacy как группа, независимо от источника. */
export function globalCapValue(
  db: Record<string, string>,
  env: Record<string, string | undefined>,
): string {
  return firstNonEmpty(
    db.LLM_GLOBAL_DAILY_BUDGET_USD,
    env.LLM_GLOBAL_DAILY_BUDGET_USD,
    db.AGENT_GLOBAL_BUDGET_USD,
    env.AGENT_GLOBAL_BUDGET_USD,
    "10",
  );
}

/** Карточка агента важнее общего per-agent ключа. */
export function agentCapValue(
  cardValue: string | null,
  db: Record<string, string>,
  env: Record<string, string | undefined>,
): string {
  return firstNonEmpty(
    cardValue ?? undefined,
    db.AGENT_DAILY_BUDGET_USD,
    env.AGENT_DAILY_BUDGET_USD,
    "5",
  );
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      if (item !== undefined) {
        // Assignment to `__proto__` mutates the prototype and silently drops
        // that key from JSON.stringify. Preserve it as an own JSON property.
        Object.defineProperty(out, key, {
          value: canonical(item),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
    return out;
  }
  return value;
}

function divideCeil(numerator: bigint, denominator: bigint): bigint {
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

function maxBigInt(...values: bigint[]): bigint {
  return values.reduce((max, value) => (value > max ? value : max), 0n);
}

function cacheCreationCostNumerator(price: LedgerPriceSnapshot, usage: LlmTokenUsage): bigint {
  const hasBreakdown =
    usage.cacheCreation5mInputTokens !== undefined ||
    usage.cacheCreation1hInputTokens !== undefined;
  const aggregate = usage.cacheCreationInputTokens ?? 0;
  const rate5m = usdToNano(price.cacheWrite5mUsdPerMtok, "ceil");
  const rate1h = usdToNano(price.cacheWrite1hUsdPerMtok, "ceil");
  if (!hasBreakdown) return maxBigInt(rate5m, rate1h) * BigInt(aggregate);

  const tokens5m = usage.cacheCreation5mInputTokens ?? 0;
  const tokens1h = usage.cacheCreation1hInputTokens ?? 0;
  if (usage.cacheCreationInputTokens !== undefined && aggregate !== tokens5m + tokens1h) {
    throw new Error("cacheCreationInputTokens не равен сумме 5m/1h breakdown");
  }
  return rate5m * BigInt(tokens5m) + rate1h * BigInt(tokens1h);
}

function isDocumentCodeExecution(consumer: string, _feature: string): boolean {
  // Один Messages request Documents открывает один Anthropic container.
  // server_tool_use.code_execution_requests хранится только как audit usage:
  // несколько tool calls внутри контейнера не создают несколько minimum charges.
  return consumer === "documents";
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function numberAsDecimal(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Некорректная сумма USD: ${value}`);
  // toFixed убирает exponent-notation и даёт хвост для корректного ceil до 1e-9.
  return value.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
}
