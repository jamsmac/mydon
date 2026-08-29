import { createHash } from "node:crypto";
import { BadRequestException, ConflictException } from "@nestjs/common";

export type TaskLlmJobKind = "chat" | "embedding";

export interface TaskLlmExecutionPlanStep {
  stepKey: string;
  kind: TaskLlmJobKind;
  feature: string;
  adapter: string;
  adapterVersion: 1;
  endpointProfile: string;
  provider: string;
  models: string[];
}

export interface TaskLlmExecutionPlan {
  version: 1;
  steps: TaskLlmExecutionPlanStep[];
}

export interface TaskLlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheCreation5mInputTokens?: number;
  cacheCreation1hInputTokens?: number;
  codeExecutionRequests?: number;
}

export interface TaskLlmStoredResult {
  kind: "success" | "provider_rejection";
  payload: Record<string, unknown>;
  resultHash: string;
}

const SAFE_KEY = /^[a-z0-9][a-z0-9:._/-]{0,127}$/i;
const MAX_STEPS = 8;
const MAX_MODELS = 3;
const MAX_JSON_BYTES = 1_000_000;
const OPENAI_COMPATIBLE_ADAPTER = "openai-compatible";
const OPENAI_CHAT_ENDPOINT_PROFILE = /^openai-chat-completions:sha256:[0-9a-f]{64}$/;
const OPENAI_EMBEDDING_ENDPOINT_PROFILE = /^openai-embeddings:sha256:[0-9a-f]{64}$/;
export const DEFINITIVE_PROVIDER_REJECTION_STATUS_CODES = new Set([
  400, 401, 403, 404, 409, 413, 415, 422, 429,
]);
const SECRET_KEY =
  /(?:^|[_-])(authorization|cookie|secret|password|passphrase|api[_-]?key|access[_-]?token)(?:$|[_-])/i;

export function canonicalJsonValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new BadRequestException("JSON contains a non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item));
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      Object.defineProperty(result, key, {
        value: canonicalJsonValue(source[key]),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  }
  throw new BadRequestException("JSON contains an unsupported value");
}

export function canonicalJsonHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJsonValue(value)))
    .digest("hex");
}

export function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function normalizedBoundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new BadRequestException(`${field} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > max) {
    throw new BadRequestException(`${field} must contain 1..${max} characters`);
  }
  return normalized;
}

function boundedNonBlankText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new BadRequestException(`${field} must contain 1..${max} characters`);
  }
  return value;
}

function normalizedKey(value: unknown, field: string): string {
  const normalized = normalizedBoundedText(value, field, 128);
  if (!SAFE_KEY.test(normalized)) {
    throw new BadRequestException(`${field} contains unsupported characters`);
  }
  return normalized;
}

/** Validates and canonicalizes the immutable, server-hashed workflow plan. */
export function normalizeTaskLlmExecutionPlan(value: unknown): TaskLlmExecutionPlan {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestException("plan must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.steps) || raw.steps.length > MAX_STEPS) {
    throw new BadRequestException(
      `plan.version must be 1 and plan.steps must contain at most ${MAX_STEPS} steps`,
    );
  }
  const seen = new Set<string>();
  const steps = raw.steps.map((item, index): TaskLlmExecutionPlanStep => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new BadRequestException(`plan.steps[${index}] must be an object`);
    }
    const step = item as Record<string, unknown>;
    const stepKey = normalizedKey(step.stepKey, `plan.steps[${index}].stepKey`);
    if (seen.has(stepKey)) throw new BadRequestException(`duplicate plan stepKey ${stepKey}`);
    seen.add(stepKey);
    if (step.kind !== "chat" && step.kind !== "embedding") {
      throw new BadRequestException(`plan.steps[${index}].kind must be chat or embedding`);
    }
    if (step.adapterVersion !== 1) {
      throw new BadRequestException(`plan.steps[${index}].adapterVersion must be 1`);
    }
    const adapter = normalizedKey(step.adapter, `plan.steps[${index}].adapter`);
    if (adapter !== OPENAI_COMPATIBLE_ADAPTER) {
      throw new BadRequestException(
        `plan.steps[${index}].adapter must be ${OPENAI_COMPATIBLE_ADAPTER} for adapterVersion 1`,
      );
    }
    const endpointProfile = normalizedKey(
      step.endpointProfile,
      `plan.steps[${index}].endpointProfile`,
    );
    const allowedEndpointProfile =
      step.kind === "chat"
        ? OPENAI_CHAT_ENDPOINT_PROFILE.test(endpointProfile)
        : OPENAI_EMBEDDING_ENDPOINT_PROFILE.test(endpointProfile);
    if (!allowedEndpointProfile) {
      throw new BadRequestException(
        `plan.steps[${index}].endpointProfile is unsupported for ${step.kind}`,
      );
    }
    if (!Array.isArray(step.models) || step.models.length < 1 || step.models.length > MAX_MODELS) {
      throw new BadRequestException(
        `plan.steps[${index}].models must contain 1..${MAX_MODELS} models`,
      );
    }
    const models = step.models.map((model, modelIndex) =>
      normalizedBoundedText(model, `plan.steps[${index}].models[${modelIndex}]`, 192),
    );
    if (new Set(models).size !== models.length) {
      throw new BadRequestException(`plan.steps[${index}].models contains duplicates`);
    }
    return {
      stepKey,
      kind: step.kind,
      feature: normalizedKey(step.feature, `plan.steps[${index}].feature`),
      adapter,
      adapterVersion: 1,
      endpointProfile,
      provider: normalizedKey(step.provider, `plan.steps[${index}].provider`).toLowerCase(),
      models,
    };
  });
  return { version: 1, steps };
}

export function parseStoredTaskLlmExecutionPlan(value: unknown): TaskLlmExecutionPlan {
  try {
    return normalizeTaskLlmExecutionPlan(value);
  } catch (error) {
    if (error instanceof BadRequestException) {
      throw new ConflictException("Stored task LLM execution plan is invalid");
    }
    throw error;
  }
}

export function assertBoundedProviderPayload(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestException("requestPayload must be a JSON object");
  }
  const canonical = canonicalJsonValue(value) as Record<string, unknown>;
  if (jsonByteLength(canonical) > MAX_JSON_BYTES) {
    throw new BadRequestException(`requestPayload exceeds ${MAX_JSON_BYTES} bytes`);
  }
  assertNoSecretKeys(canonical);
  return canonical;
}

function assertNoSecretKeys(value: unknown, path = "requestPayload"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretKeys(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) {
      throw new BadRequestException(`${path}.${key} may contain a secret and cannot be persisted`);
    }
    assertNoSecretKeys(child, `${path}.${key}`);
  }
}

function normalizedUsage(value: unknown): TaskLlmUsage | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestException("result.usage must be an object");
  }
  const raw = value as Record<string, unknown>;
  const read = (key: string, max = 100_000_000): number | undefined => {
    const entry = raw[key];
    if (entry === undefined) return undefined;
    if (!Number.isInteger(entry) || Number(entry) < 0 || Number(entry) > max) {
      throw new BadRequestException(`result.usage.${key} must be a bounded non-negative integer`);
    }
    return Number(entry);
  };
  const inputTokens = read("inputTokens");
  const outputTokens = read("outputTokens");
  if (inputTokens === undefined || outputTokens === undefined) {
    throw new BadRequestException("result.usage requires inputTokens and outputTokens");
  }
  const optional = {
    cacheReadInputTokens: read("cacheReadInputTokens"),
    cacheCreationInputTokens: read("cacheCreationInputTokens"),
    cacheCreation5mInputTokens: read("cacheCreation5mInputTokens"),
    cacheCreation1hInputTokens: read("cacheCreation1hInputTokens"),
    codeExecutionRequests: read("codeExecutionRequests", 100_000),
  };
  return {
    inputTokens,
    outputTokens,
    ...Object.fromEntries(Object.entries(optional).filter(([, item]) => item !== undefined)),
  } as TaskLlmUsage;
}

/** Turns a worker completion payload into bounded canonical evidence. */
export function normalizeTaskLlmResultPayload(
  jobKind: TaskLlmJobKind,
  outcome: "success" | "provider_rejection",
  value: unknown,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestException("result must be an object");
  }
  const raw = value as Record<string, unknown>;
  const common: Record<string, unknown> = {};
  const usage = normalizedUsage(raw.usage);
  if (usage) common.usage = usage;
  if (raw.providerRequestId !== undefined) {
    common.providerRequestId = normalizedBoundedText(
      raw.providerRequestId,
      "result.providerRequestId",
      256,
    );
  }
  if (raw.resolvedModel !== undefined) {
    common.resolvedModel = normalizedBoundedText(raw.resolvedModel, "result.resolvedModel", 192);
  }
  if (raw.providerReportedUsd !== undefined) {
    if (
      typeof raw.providerReportedUsd !== "number" ||
      !Number.isFinite(raw.providerReportedUsd) ||
      raw.providerReportedUsd < 0
    ) {
      throw new BadRequestException("result.providerReportedUsd must be a non-negative number");
    }
    common.providerReportedUsd = raw.providerReportedUsd;
  }

  let payload: Record<string, unknown>;
  if (outcome === "provider_rejection") {
    if (
      !Number.isInteger(raw.statusCode) ||
      !DEFINITIVE_PROVIDER_REJECTION_STATUS_CODES.has(Number(raw.statusCode))
    ) {
      throw new BadRequestException(
        "result.statusCode is not an allowlisted definitive provider rejection",
      );
    }
    payload = {
      error: normalizedBoundedText(raw.error, "result.error", 4_000),
      statusCode: Number(raw.statusCode),
      ...common,
    };
  } else if (jobKind === "chat") {
    payload = { text: boundedNonBlankText(raw.text, "result.text", 256_000), ...common };
  } else {
    if (!Array.isArray(raw.vector) || raw.vector.length === 0 || raw.vector.length > 16_384) {
      throw new BadRequestException("result.vector must contain 1..16384 numbers");
    }
    const vector = raw.vector.map((item) => {
      if (typeof item !== "number" || !Number.isFinite(item)) {
        throw new BadRequestException("result.vector contains a non-finite number");
      }
      return Object.is(item, -0) ? 0 : item;
    });
    payload = { vector, ...common };
  }
  const canonical = canonicalJsonValue(payload) as Record<string, unknown>;
  if (jsonByteLength(canonical) > MAX_JSON_BYTES) {
    throw new BadRequestException(`result exceeds ${MAX_JSON_BYTES} bytes`);
  }
  return canonical;
}
