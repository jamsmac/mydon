import { randomUUID } from "node:crypto";
import {
  LlmBudgetDeniedError,
  LlmLedgerUnavailableError,
  LlmReplayBlockedError,
  type LlmTokenUsage,
} from "@mydon/shared";
import {
  AgentsCoreHttpError,
  type AgentsCoreClient,
  type ClaimAgentTaskLlmDispatchResult,
  type CompleteAgentTaskLlmJobInput,
  type CompleteAgentTaskLlmJobResult,
  type EnsureAgentTaskLlmJobResult,
  type TaskLlmCompletionPayload,
  type TaskLlmStoredResult,
} from "./core-client";
import type { EmbeddingGateway, EmbeddingResult } from "./embedding";
import type { ModelGateway, ModelRequest, ModelResult } from "./model-gateway";
import type { TaskLlmJobKind, TaskLlmWorkflowPlan, TaskLlmWorkflowStep } from "./task-llm-workflow";

type TaskLlmCorePort = Pick<
  AgentsCoreClient,
  "ensureAgentTaskLlmJob" | "claimAgentTaskLlmDispatch" | "completeAgentTaskLlmJob"
>;

export interface TaskLlmFence {
  taskId: string;
  agentName: string;
  runId: string;
  executionAttemptId: string;
}

/** Immutable task workflow route differs from current runtime configuration. */
export class TaskLlmWorkflowChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskLlmWorkflowChangedError";
  }
}

interface AttemptRoute {
  kind: TaskLlmJobKind;
  feature: string;
  model: string;
  providerAttemptNo: number;
  inputTokenCeiling: number;
  outputTokenCeiling: number;
  requestPayload: Record<string, unknown>;
}

const TASK_LLM_JOB_STATUSES = new Set([
  "waiting_budget",
  "ready",
  "dispatching",
  "succeeded",
  "rejected",
  "unknown",
  "cancelled",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validJobStatus(value: unknown): boolean {
  return typeof value === "string" && TASK_LLM_JOB_STATUSES.has(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function retryableExactResponse(error: unknown): boolean {
  return !(error instanceof AgentsCoreHttpError) || error.status >= 500;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function tokenField(value: unknown): number | undefined {
  const numeric = numberField(value);
  return numeric === undefined || !Number.isInteger(numeric) ? undefined : numeric;
}

function usageField(value: unknown): LlmTokenUsage | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const inputTokens = tokenField(raw.inputTokens);
  const outputTokens = tokenField(raw.outputTokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const optional = {
    cacheReadInputTokens: tokenField(raw.cacheReadInputTokens),
    cacheCreationInputTokens: tokenField(raw.cacheCreationInputTokens),
    cacheCreation5mInputTokens: tokenField(raw.cacheCreation5mInputTokens),
    cacheCreation1hInputTokens: tokenField(raw.cacheCreation1hInputTokens),
    codeExecutionRequests: tokenField(raw.codeExecutionRequests),
  };
  return {
    inputTokens,
    outputTokens,
    ...(optional.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: optional.cacheReadInputTokens }
      : {}),
    ...(optional.cacheCreationInputTokens !== undefined
      ? { cacheCreationInputTokens: optional.cacheCreationInputTokens }
      : {}),
    ...(optional.cacheCreation5mInputTokens !== undefined
      ? { cacheCreation5mInputTokens: optional.cacheCreation5mInputTokens }
      : {}),
    ...(optional.cacheCreation1hInputTokens !== undefined
      ? { cacheCreation1hInputTokens: optional.cacheCreation1hInputTokens }
      : {}),
    ...(optional.codeExecutionRequests !== undefined
      ? { codeExecutionRequests: optional.codeExecutionRequests }
      : {}),
  };
}

function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Coordinates one immutable Core execution. It never retries provider wire
 * traffic; only idempotent Core claim/complete calls may be repeated verbatim.
 */
export class TaskLlmSession {
  constructor(
    private readonly core: TaskLlmCorePort,
    private readonly fence: TaskLlmFence,
    private readonly plan: TaskLlmWorkflowPlan,
  ) {}

  modelsForChat(feature: string, gateway: ModelGateway, fallback: readonly string[]): string[] {
    const planned = this.plannedStep("chat", feature);
    if (planned) {
      if (gateway.billingMode !== "metered") {
        throw this.workflowChanged(
          `Task workflow route ${feature} был metered, текущий gateway стал ${gateway.billingMode}`,
        );
      }
      return [...this.route("chat", feature, gateway).models];
    }
    // An empty model chain has always meant that the LLM path is disabled.
    // A new execution therefore has no chat plan step and must not invent a
    // provider model merely to satisfy the non-empty Core plan constraint.
    if (gateway.billingMode === "metered" && fallback.length === 0) return [];
    if (gateway.billingMode === "metered") {
      throw this.workflowChanged(
        `Task workflow ${this.plan.version} не разрешает chat step ${feature}`,
      );
    }
    return [...fallback];
  }

  /**
   * Decides whether task-mode embedding must use the durable state machine.
   * A saved metered step can never be bypassed by switching current config to
   * local, and a newly metered route cannot enter an old local-only plan.
   */
  usesDurableEmbedding(gateway: EmbeddingGateway, feature: string): boolean {
    const planned = this.plannedStep("embedding", feature);
    if (!planned) {
      if (gateway.billingMode === "metered") {
        throw this.workflowChanged(
          `Task workflow ${this.plan.version} не разрешает embedding step ${feature}`,
        );
      }
      return false;
    }
    if (gateway.billingMode !== "metered") {
      throw this.workflowChanged(
        `Task workflow route ${feature} был metered, текущий gateway стал ${gateway.billingMode}`,
      );
    }
    this.route("embedding", feature, gateway);
    return true;
  }

  async callChat(
    gateway: ModelGateway,
    feature: string,
    model: string,
    providerAttemptNo: number,
    request: ModelRequest,
    inputTokenCeiling: number,
    outputTokenCeiling: number,
  ): Promise<ModelResult> {
    const step = this.attemptStep("chat", feature, gateway, model, providerAttemptNo);
    if (!gateway.buildRequestPayload || !gateway.dispatchExact) {
      throw new LlmLedgerUnavailableError(
        `Metered task gateway ${gateway.provider} не поддерживает exact durable dispatch`,
      );
    }
    const route: AttemptRoute = {
      kind: "chat",
      feature,
      model,
      providerAttemptNo,
      inputTokenCeiling,
      outputTokenCeiling,
      requestPayload: gateway.buildRequestPayload(model, request),
    };
    const result = await this.runAttempt(step, route, (payload) => gateway.dispatchExact!(payload));
    return this.chatResult(result, model);
  }

  async embed(
    gateway: EmbeddingGateway,
    text: string,
    feature: string,
    inputTokenCeiling: number,
  ): Promise<EmbeddingResult> {
    const step = this.route("embedding", feature, gateway);
    const model = step.models[0];
    if (!model) {
      throw new LlmLedgerUnavailableError(`Task workflow step ${feature} не содержит model`);
    }
    if (!gateway.buildRequestPayload || !gateway.dispatchExact) {
      throw new LlmLedgerUnavailableError(
        `Metered task embedding gateway ${gateway.provider} не поддерживает exact durable dispatch`,
      );
    }
    const result = await this.runAttempt(
      step,
      {
        kind: "embedding",
        feature,
        model,
        providerAttemptNo: 1,
        inputTokenCeiling,
        outputTokenCeiling: 0,
        requestPayload: gateway.buildRequestPayload(model, text),
      },
      (payload) => gateway.dispatchExact!(payload),
    );
    return this.embeddingResult(result);
  }

  private route(
    kind: TaskLlmJobKind,
    feature: string,
    gateway: {
      provider: string;
      billingMode: string;
      adapter?: string;
      adapterVersion?: number;
      endpointProfile?: string;
    },
  ): TaskLlmWorkflowStep {
    const step = this.plannedStep(kind, feature);
    if (!step) {
      throw this.workflowChanged(
        `Task workflow ${this.plan.version} не разрешает ${kind} step ${feature}`,
      );
    }
    if (gateway.billingMode !== "metered") {
      throw this.workflowChanged(
        `Task workflow route ${feature} был metered, текущий gateway стал ${gateway.billingMode}`,
      );
    }
    if (
      step.provider !== gateway.provider.trim().toLowerCase() ||
      step.adapter !== gateway.adapter ||
      step.adapterVersion !== gateway.adapterVersion ||
      step.endpointProfile !== gateway.endpointProfile
    ) {
      throw this.workflowChanged(
        `Task workflow route ${feature} не совпал с текущим provider/adapter/endpoint`,
      );
    }
    return step;
  }

  private plannedStep(kind: TaskLlmJobKind, feature: string): TaskLlmWorkflowStep | undefined {
    return this.plan.steps.find(
      (candidate) =>
        candidate.stepKey === feature && candidate.kind === kind && candidate.feature === feature,
    );
  }

  private attemptStep(
    kind: TaskLlmJobKind,
    feature: string,
    gateway: ModelGateway,
    model: string,
    providerAttemptNo: number,
  ): TaskLlmWorkflowStep {
    const step = this.route(kind, feature, gateway);
    if (providerAttemptNo < 1 || step.models[providerAttemptNo - 1] !== model) {
      throw this.workflowChanged(
        `Model ${model} attempt ${providerAttemptNo} не совпал с task workflow step ${feature}`,
      );
    }
    return step;
  }

  private async runAttempt<T extends ModelResult | EmbeddingResult>(
    step: TaskLlmWorkflowStep,
    route: AttemptRoute,
    dispatch: (payload: Record<string, unknown>) => Promise<{
      outcome: "success" | "provider_rejection" | "unknown";
      result: T;
    }>,
  ): Promise<TaskLlmStoredResult> {
    let ensured: EnsureAgentTaskLlmJobResult;
    try {
      const response = await this.core.ensureAgentTaskLlmJob(this.fence.taskId, {
        agentName: this.fence.agentName,
        runId: this.fence.runId,
        executionAttemptId: this.fence.executionAttemptId,
        stepKey: step.stepKey,
        providerAttemptNo: route.providerAttemptNo,
        kind: route.kind,
        feature: route.feature,
        adapter: step.adapter,
        adapterVersion: step.adapterVersion,
        endpointProfile: step.endpointProfile,
        provider: step.provider,
        model: route.model,
        inputTokenCeiling: route.inputTokenCeiling,
        outputTokenCeiling: route.outputTokenCeiling,
        requestPayload: route.requestPayload,
      });
      ensured = this.validatedEnsure(response);
    } catch (error) {
      if (error instanceof AgentsCoreHttpError && error.status === 409) {
        throw this.blocked("ensure operation hash mismatch", undefined, error);
      }
      throw new LlmLedgerUnavailableError(
        `Core не подтвердил durable LLM job: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    const existing = this.terminalResult(ensured.status, ensured.result, ensured.jobId);
    if (existing) return existing;
    if (ensured.status === "waiting_budget") {
      if (!ensured.denial) {
        throw new LlmLedgerUnavailableError(
          `Core вернул waiting_budget без denial для job ${ensured.jobId}`,
        );
      }
      throw new LlmBudgetDeniedError(
        ensured.denial.action,
        ensured.denial.reason,
        ensured.denial.budget,
      );
    }
    if (ensured.status !== "ready") {
      throw this.blocked(`job уже в состоянии ${ensured.status}`, ensured.jobId);
    }

    const dispatchToken = randomUUID();
    const claim = await this.claimWithRecovery(ensured.jobId, dispatchToken);
    const claimedResult = this.terminalResult(claim.status, claim.result, ensured.jobId);
    if (claimedResult) return claimedResult;
    if (!claim.granted || claim.status !== "dispatching" || !claim.requestPayload) {
      throw this.blocked("Core не вернул exact dispatch grant", ensured.jobId);
    }
    if (claim.operationHash !== ensured.operationHash) {
      throw this.blocked("operationHash изменился между ensure и claim", ensured.jobId);
    }

    // Exactly one provider wire attempt. No catch-and-retry is allowed here.
    let provider: {
      outcome: "success" | "provider_rejection" | "unknown";
      result: T;
    };
    try {
      provider = await dispatch(claim.requestPayload);
    } catch (error) {
      await this.completeWithRecovery(ensured.jobId, {
        dispatchToken,
        outcome: "unknown",
      });
      throw this.blocked(
        `provider dispatch завершился неизвестно: ${errorMessage(error)}`,
        ensured.jobId,
        error,
      );
    }
    const completion = this.completion(dispatchToken, provider);
    const completed = await this.completeWithRecovery(ensured.jobId, completion);
    if (provider.outcome === "unknown") {
      throw this.blocked("provider outcome неизвестен; automatic retry запрещён", ensured.jobId);
    }
    const durable = this.terminalResult(completed.status, completed.result, ensured.jobId);
    if (!durable) {
      throw this.blocked("Core не вернул durable terminal result", ensured.jobId);
    }
    return durable;
  }

  private async claimWithRecovery(
    jobId: string,
    dispatchToken: string,
  ): Promise<ClaimAgentTaskLlmDispatchResult> {
    const input = {
      agentName: this.fence.agentName,
      runId: this.fence.runId,
      executionAttemptId: this.fence.executionAttemptId,
      dispatchToken,
    };
    let response: ClaimAgentTaskLlmDispatchResult;
    try {
      response = await this.core.claimAgentTaskLlmDispatch(this.fence.taskId, jobId, input);
    } catch (firstError) {
      if (!retryableExactResponse(firstError)) {
        throw this.blocked("dispatch claim отклонён Core", jobId, firstError);
      }
      try {
        response = await this.core.claimAgentTaskLlmDispatch(this.fence.taskId, jobId, input);
      } catch (recoveryError) {
        throw this.blocked(
          `dispatch claim response потерян и exact recovery не подтвердила grant: ${errorMessage(recoveryError)}`,
          jobId,
          recoveryError,
        );
      }
    }
    return this.validatedClaim(response, jobId);
  }

  private async completeWithRecovery(
    jobId: string,
    input: CompleteAgentTaskLlmJobInput,
  ): Promise<CompleteAgentTaskLlmJobResult> {
    try {
      return await this.core.completeAgentTaskLlmJob(this.fence.taskId, jobId, input);
    } catch (firstError) {
      if (!retryableExactResponse(firstError)) {
        throw this.blocked("durable complete отклонён Core", jobId, firstError);
      }
      try {
        return await this.core.completeAgentTaskLlmJob(this.fence.taskId, jobId, input);
      } catch (recoveryError) {
        throw this.blocked(
          `provider уже ответил, но exact complete recovery не подтверждена: ${errorMessage(recoveryError)}`,
          jobId,
          recoveryError,
        );
      }
    }
  }

  private validatedEnsure(value: unknown): EnsureAgentTaskLlmJobResult {
    if (
      !plainRecord(value) ||
      typeof value.jobId !== "string" ||
      !UUID_PATTERN.test(value.jobId) ||
      !validJobStatus(value.status) ||
      typeof value.operationHash !== "string" ||
      !HASH_PATTERN.test(value.operationHash)
    ) {
      throw new LlmLedgerUnavailableError("Core вернул невалидный durable LLM ensure response");
    }
    return value as unknown as EnsureAgentTaskLlmJobResult;
  }

  private validatedClaim(value: unknown, jobId: string): ClaimAgentTaskLlmDispatchResult {
    if (!plainRecord(value)) {
      throw this.blocked("Core вернул невалидный durable dispatch claim response", jobId);
    }
    const payloadValid = value.requestPayload === undefined || plainRecord(value.requestPayload);
    if (
      !payloadValid ||
      typeof value.granted !== "boolean" ||
      typeof value.replay !== "boolean" ||
      !validJobStatus(value.status) ||
      typeof value.operationHash !== "string" ||
      !HASH_PATTERN.test(value.operationHash) ||
      (value.granted === true && !plainRecord(value.requestPayload))
    ) {
      throw this.blocked("Core вернул невалидный durable dispatch claim response", jobId);
    }
    return value as unknown as ClaimAgentTaskLlmDispatchResult;
  }

  private completion<T extends ModelResult | EmbeddingResult>(
    dispatchToken: string,
    provider: {
      outcome: "success" | "provider_rejection" | "unknown";
      result: T;
    },
  ): CompleteAgentTaskLlmJobInput {
    if (provider.outcome === "unknown") return { dispatchToken, outcome: "unknown" };

    const result = provider.result;
    const common: TaskLlmCompletionPayload = {
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.providerRequestId ? { providerRequestId: result.providerRequestId } : {}),
      ...(result.resolvedModel ? { resolvedModel: result.resolvedModel } : {}),
      ...(result.costUsd !== undefined ? { providerReportedUsd: result.costUsd } : {}),
    };
    if (provider.outcome === "provider_rejection") {
      if (result.statusCode === undefined) {
        return { dispatchToken, outcome: "unknown" };
      }
      return {
        dispatchToken,
        outcome: "provider_rejection",
        result: {
          ...common,
          error: result.error ?? `provider rejected with ${result.statusCode}`,
          statusCode: result.statusCode,
        },
      };
    }
    if ("text" in result && typeof result.text === "string") {
      return { dispatchToken, outcome: "success", result: { ...common, text: result.text } };
    }
    if ("vector" in result && Array.isArray(result.vector)) {
      return { dispatchToken, outcome: "success", result: { ...common, vector: result.vector } };
    }
    return { dispatchToken, outcome: "unknown" };
  }

  private terminalResult(
    status: string,
    result: TaskLlmStoredResult | undefined,
    jobId: string,
  ): TaskLlmStoredResult | null {
    if (status !== "succeeded" && status !== "rejected") return null;
    if (!result) throw this.blocked(`terminal job ${status} не содержит result`, jobId);
    if (status === "succeeded" && result.kind !== "success") {
      throw this.blocked("succeeded job содержит rejection", jobId);
    }
    if (status === "rejected" && result.kind !== "provider_rejection") {
      throw this.blocked("rejected job содержит success", jobId);
    }
    return result;
  }

  private chatResult(result: TaskLlmStoredResult, requestedModel: string): ModelResult {
    const payload = this.payload(result);
    if (result.kind === "provider_rejection") {
      const statusCode = tokenField(payload.statusCode);
      if (statusCode === undefined) throw this.blocked("rejection без statusCode");
      return {
        text: "",
        model: requestedModel,
        ok: false,
        statusCode,
        error: optionalString(payload, "error") ?? `provider rejected with ${statusCode}`,
        ...(usageField(payload.usage) ? { usage: usageField(payload.usage) } : {}),
        ...(optionalString(payload, "providerRequestId")
          ? { providerRequestId: optionalString(payload, "providerRequestId") }
          : {}),
        ...(optionalString(payload, "resolvedModel")
          ? { resolvedModel: optionalString(payload, "resolvedModel") }
          : {}),
        ...(numberField(payload.providerReportedUsd) !== undefined
          ? { costUsd: numberField(payload.providerReportedUsd) }
          : {}),
      };
    }
    if (typeof payload.text !== "string") throw this.blocked("chat success без text");
    const usage = usageField(payload.usage);
    const providerRequestId = optionalString(payload, "providerRequestId");
    const resolvedModel = optionalString(payload, "resolvedModel");
    const costUsd = numberField(payload.providerReportedUsd);
    return {
      text: payload.text,
      model: requestedModel,
      ok: true,
      ...(usage ? { usage } : {}),
      ...(providerRequestId ? { providerRequestId } : {}),
      ...(resolvedModel ? { resolvedModel } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    };
  }

  private embeddingResult(result: TaskLlmStoredResult): EmbeddingResult {
    const payload = this.payload(result);
    if (result.kind === "provider_rejection") {
      const statusCode = tokenField(payload.statusCode);
      if (statusCode === undefined) throw this.blocked("embedding rejection без statusCode");
      return {
        vector: null,
        statusCode,
        error: optionalString(payload, "error") ?? `provider rejected with ${statusCode}`,
      };
    }
    const vector =
      Array.isArray(payload.vector) &&
      payload.vector.length > 0 &&
      payload.vector.every((value) => typeof value === "number" && Number.isFinite(value))
        ? payload.vector
        : null;
    if (!vector) {
      throw this.blocked("embedding success без валидного vector");
    }
    const usage = usageField(payload.usage);
    const providerRequestId = optionalString(payload, "providerRequestId");
    const resolvedModel = optionalString(payload, "resolvedModel");
    const costUsd = numberField(payload.providerReportedUsd);
    return {
      vector,
      ...(usage ? { usage } : {}),
      ...(providerRequestId ? { providerRequestId } : {}),
      ...(resolvedModel ? { resolvedModel } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    };
  }

  private payload(result: TaskLlmStoredResult): Record<string, unknown> {
    if (
      result.payload === null ||
      typeof result.payload !== "object" ||
      Array.isArray(result.payload)
    ) {
      throw this.blocked("durable result содержит невалидный payload");
    }
    return result.payload;
  }

  private blocked(message: string, jobId?: string, cause?: unknown): LlmReplayBlockedError {
    const key = jobId
      ? `task:${this.fence.taskId}:llm-job:${jobId}`
      : `task:${this.fence.taskId}:execution:${this.fence.executionAttemptId}`;
    const error = new LlmReplayBlockedError(key, message);
    if (cause !== undefined) Object.defineProperty(error, "cause", { value: cause });
    return error;
  }

  private workflowChanged(message: string): TaskLlmWorkflowChangedError {
    return new TaskLlmWorkflowChangedError(
      `task:${this.fence.taskId}:execution:${this.fence.executionAttemptId}: ${message}`,
    );
  }
}
