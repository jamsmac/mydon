import {
  LlmLedgerUnavailableError,
  LlmReplayBlockedError,
  inputTokenCeiling,
  type LlmLedger,
  type LlmTokenUsage,
} from "@mydon/shared";
import { httpBillingMode } from "./llm-ledger";
import {
  DEFINITIVE_PROVIDER_REJECTION_STATUSES,
  OPENAI_COMPATIBLE_ADAPTER,
  OPENAI_COMPATIBLE_ADAPTER_VERSION,
  bindHttpEndpoint,
  type ExactProviderOutcome,
} from "./model-gateway";
import type { TaskLlmSession } from "./task-llm-session";

export const EMBEDDING_ENDPOINT_PROFILE = "openai-embeddings";

/**
 * Шлюз эмбеддингов для семантической памяти.
 *
 * HTTP считается metered, пока `EMBED_BILLING_MODE=local` явно не
 * скажет обратное. Отсутствие usage/cost в ответе не делает вызов
 * бесплатным: reservation остаётся unknown exposure.
 */

export type EmbeddingBillingMode = "metered" | "local";

export interface EmbeddingResult {
  vector: number[] | null;
  usage?: LlmTokenUsage;
  costUsd?: number;
  providerRequestId?: string;
  resolvedModel?: string;
  error?: string;
  statusCode?: number;
}

export interface EmbeddingGateway {
  readonly provider: string;
  readonly billingMode: EmbeddingBillingMode;
  readonly model: string;
  embed(text: string): Promise<EmbeddingResult>;
  readonly adapter?: string;
  readonly adapterVersion?: number;
  readonly endpointProfile?: string;
  buildRequestPayload?(model: string, text: string): Record<string, unknown>;
  dispatchExact?(
    requestPayload: Record<string, unknown>,
  ): Promise<ExactProviderOutcome<EmbeddingResult>>;
}

export interface EmbeddingCallContext {
  ledger?: LlmLedger;
  agentName: string;
  feature: string;
  requestKey: string;
  traceKey?: string;
  /** Durable task lease: проверить CAS до reserve/provider. */
  assertLease?: () => Promise<void>;
  /** Durable provider coordinator, only for metered task-mode calls. */
  taskLlm?: TaskLlmSession;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function reportedUsage(data: unknown): LlmTokenUsage | undefined {
  const raw = (data as { usage?: Record<string, unknown> })?.usage;
  if (!raw) return undefined;
  const inputTokens = nonNegativeInt(raw.prompt_tokens ?? raw.input_tokens ?? raw.total_tokens);
  if (inputTokens === undefined) return undefined;
  return { inputTokens, outputTokens: 0 };
}

function reportedCost(data: unknown): number | undefined {
  const usage = (data as { usage?: Record<string, unknown> })?.usage;
  const raw = usage?.cost_usd ?? usage?.cost ?? (data as { cost?: unknown })?.cost;
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** OpenAI-совместимый HTTP-шлюз (`POST {base}/embeddings`). */
export class HttpEmbeddingGateway implements EmbeddingGateway {
  readonly adapter = OPENAI_COMPATIBLE_ADAPTER;
  readonly adapterVersion = OPENAI_COMPATIBLE_ADAPTER_VERSION;
  readonly endpointProfile: string;
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    readonly provider: string,
    private readonly apiKey = "",
    readonly model = "text-embedding-3-small",
    private readonly timeoutMs = 20_000,
    readonly billingMode: EmbeddingBillingMode = "metered",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const endpoint = bindHttpEndpoint(EMBEDDING_ENDPOINT_PROFILE, baseUrl);
    this.baseUrl = endpoint.baseUrl;
    this.endpointProfile = endpoint.endpointProfile;
    if (billingMode === "metered" && provider.trim() === "") {
      throw new Error("Metered HttpEmbeddingGateway требует явный price provider id");
    }
  }

  buildRequestPayload(model: string, text: string): Record<string, unknown> {
    return { model, input: text };
  }

  async dispatchExact(
    requestPayload: Record<string, unknown>,
  ): Promise<ExactProviderOutcome<EmbeddingResult>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(requestPayload),
      });
      if (!res.ok) {
        const result: EmbeddingResult = {
          vector: null,
          error: `шлюз ответил ${res.status}`,
          statusCode: res.status,
        };
        return DEFINITIVE_PROVIDER_REJECTION_STATUSES.has(res.status)
          ? { outcome: "provider_rejection", result }
          : { outcome: "unknown", result };
      }
      const data = (await res.json()) as {
        id?: unknown;
        model?: unknown;
        usage?: Record<string, unknown>;
        cost?: unknown;
        data?: { embedding?: unknown }[];
      };
      const raw = data?.data?.[0]?.embedding;
      const valid =
        Array.isArray(raw) &&
        raw.length > 0 &&
        raw.length <= 16_384 &&
        raw.every((value) => typeof value === "number" && Number.isFinite(value))
          ? (raw as number[])
          : null;
      if (valid === null) {
        return {
          outcome: "unknown",
          result: { vector: null, error: "provider не вернул валидный embedding" },
        };
      }
      const usage = reportedUsage(data);
      const costUsd = reportedCost(data);
      return {
        outcome: "success",
        result: {
          vector: valid,
          ...(usage ? { usage } : {}),
          ...(costUsd !== undefined ? { costUsd } : {}),
          ...(typeof data.id === "string" ? { providerRequestId: data.id } : {}),
          ...(typeof data.model === "string" ? { resolvedModel: data.model } : {}),
        },
      };
    } catch (error) {
      return {
        outcome: "unknown",
        result: { vector: null, error: error instanceof Error ? error.message : String(error) },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async embed(text: string): Promise<EmbeddingResult> {
    return (await this.dispatchExact(this.buildRequestPayload(this.model, text))).result;
  }
}

/**
 * Одна физическая embedding-попытка с атомарным Core reserve.
 * Reserve-ошибки типизированно выходят наружу ДО provider call.
 */
export async function embedWithLedger(
  gateway: EmbeddingGateway,
  text: string,
  context: EmbeddingCallContext,
): Promise<number[] | null> {
  // Вызов стоит перед local и metered ветками: stale worker не
  // должен уйти provider-у даже при локальном billing mode.
  await context.assertLease?.();
  const durable = context.taskLlm?.usesDurableEmbedding(gateway, context.feature) ?? false;
  if (durable) {
    return (
      await context.taskLlm!.embed(gateway, text, context.feature, inputTokenCeiling(text, 256))
    ).vector;
  }
  if (gateway.billingMode === "local") return (await gateway.embed(text)).vector;
  if (!context.ledger) {
    throw new LlmLedgerUnavailableError("Metered embeddings не получили клиент Core ledger");
  }

  const reservation = await context.ledger.reserve({
    consumer: "embeddings",
    feature: context.feature,
    agentName: context.agentName,
    provider: gateway.provider,
    model: gateway.model,
    requestKey: context.requestKey,
    traceKey: context.traceKey ?? context.requestKey,
    inputTokenCeiling: inputTokenCeiling(text, 256),
    outputTokenCeiling: 0,
  });

  // Replay означает, что эта физическая попытка могла уже уйти provider-у
  // из другого процесса. Provider idempotency key embeddings API не получает,
  // поэтому повторный dispatch был бы потенциальной двойной оплатой.
  if (reservation.replay) {
    throw new LlmReplayBlockedError(
      reservation.requestKey,
      `LLM-ledger вернул replay для ${reservation.requestKey}; повторный embedding call запрещён`,
    );
  }

  let result: EmbeddingResult;
  try {
    result = await gateway.embed(text);
  } catch (error) {
    result = { vector: null, error: error instanceof Error ? error.message : String(error) };
  }

  // После provider dispatch не маскируем его результат сбоем settle:
  // незакрытый reservation сам останется в exposure до конца суток.
  try {
    if (result.vector !== null) {
      await context.ledger.settle(reservation.id, {
        outcome: "success",
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.costUsd !== undefined ? { providerReportedUsd: result.costUsd } : {}),
        ...(result.providerRequestId ? { providerRequestId: result.providerRequestId } : {}),
        ...(result.resolvedModel ? { resolvedModel: result.resolvedModel } : {}),
        ...(!result.resolvedModel ? { reason: "provider не сообщил resolvedModel" } : {}),
      });
    } else {
      await context.ledger.fail(reservation.id, {
        outcome: "unknown",
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.costUsd !== undefined ? { providerReportedUsd: result.costUsd } : {}),
        ...(result.providerRequestId ? { providerRequestId: result.providerRequestId } : {}),
        ...(result.resolvedModel ? { resolvedModel: result.resolvedModel } : {}),
        reason: result.error ?? "provider не сообщил embedding usage/cost",
      });
    }
  } catch (error) {
    // Резерв не освобождён и продолжает защищать дневной cap.
    console.warn(
      `[llm-ledger] embedding accounting failed requestKey=${context.requestKey} reservation=${reservation.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return result.vector;
}

/** Нет `EMBED_BASE_URL` → null (семантическая память спит). */
export function embeddingGatewayFromEnv(): EmbeddingGateway | null {
  const baseUrl = (process.env.EMBED_BASE_URL ?? "").trim();
  if (!baseUrl) return null;
  const model = (process.env.EMBED_MODEL ?? "").trim() || "text-embedding-3-small";
  const billingMode = httpBillingMode(process.env.EMBED_BILLING_MODE);
  const priceProviderId = (process.env.EMBED_PRICE_PROVIDER_ID ?? "").trim();
  if (billingMode === "metered" && !priceProviderId) {
    throw new Error(
      "EMBED_PRICE_PROVIDER_ID обязателен для metered HTTP: provider call заблокирован до reserve",
    );
  }
  return new HttpEmbeddingGateway(
    baseUrl,
    priceProviderId,
    (process.env.EMBED_API_KEY ?? "").trim(),
    model,
    20_000,
    billingMode,
  );
}

/** Стартовый лог: память выключена, local, metered или заблокирована конфигурацией. */
export function embeddingPosture(): string {
  const baseUrl = (process.env.EMBED_BASE_URL ?? "").trim();
  if (!baseUrl) return "Семантическая память выключена — EMBED_BASE_URL не задан";

  const billingMode = httpBillingMode(process.env.EMBED_BILLING_MODE);
  const priceProviderId = (process.env.EMBED_PRICE_PROVIDER_ID ?? "").trim();
  if (billingMode === "metered" && !priceProviderId) {
    return "ОШИБКА конфигурации памяти: EMBED_PRICE_PROVIDER_ID не задан; metered HTTP-вызовы заблокированы до provider";
  }
  return billingMode === "local"
    ? "Семантическая память включена (HTTP-шлюз, явно local)"
    : `Семантическая память включена (metered через Core ledger, price provider=${priceProviderId})`;
}

/** Косинусная близость двух векторов. Разные длины/нули → 0 (безопасно). */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
