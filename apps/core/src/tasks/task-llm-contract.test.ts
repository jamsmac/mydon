import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inputTokenCeiling } from "@mydon/shared";
import {
  assertBoundedProviderPayload,
  canonicalJsonHash,
  normalizeTaskLlmExecutionPlan,
  normalizeTaskLlmResultPayload,
} from "./task-llm-contract";
import { TaskLlmJobsService, taskLlmSettlementDto } from "./task-llm-jobs.service";

const CHAT_PROFILE = `openai-chat-completions:sha256:${"a".repeat(64)}`;

const PLAN = {
  version: 1,
  steps: [
    {
      stepKey: "coach-review:eval",
      kind: "chat",
      feature: "coach-review:eval",
      adapter: "openai-compatible",
      adapterVersion: 1,
      endpointProfile: CHAT_PROFILE,
      provider: "openai",
      models: ["primary", "fallback"],
    },
  ],
};

describe("task LLM bounded contract", () => {
  it("canonicalizes the allowlisted v1 plan and rejects skipped/duplicate routes", () => {
    assert.deepEqual(normalizeTaskLlmExecutionPlan(PLAN), PLAN);
    assert.equal(canonicalJsonHash({ b: 2, a: 1 }), canonicalJsonHash({ a: 1, b: 2 }));
    assert.throws(
      () =>
        normalizeTaskLlmExecutionPlan({
          version: 1,
          steps: [PLAN.steps[0], PLAN.steps[0]],
        }),
      /duplicate plan stepKey/,
    );
    assert.throws(
      () =>
        normalizeTaskLlmExecutionPlan({ version: 1, steps: [{ ...PLAN.steps[0], models: [] }] }),
      /models must contain 1\.\.3/,
    );
    assert.throws(
      () =>
        normalizeTaskLlmExecutionPlan({
          version: 1,
          steps: [{ ...PLAN.steps[0], adapter: "anthropic-native" }],
        }),
      /adapter must be openai-compatible/,
    );
    assert.throws(
      () =>
        normalizeTaskLlmExecutionPlan({
          version: 1,
          steps: [{ ...PLAN.steps[0], endpointProfile: "openai-chat-completions" }],
        }),
      /endpointProfile is unsupported for chat/,
    );
    assert.equal(
      normalizeTaskLlmExecutionPlan({
        version: 1,
        steps: [
          {
            ...PLAN.steps[0],
            endpointProfile: CHAT_PROFILE,
          },
        ],
      }).steps[0]?.endpointProfile,
      CHAT_PROFILE,
    );
  });

  it("keeps exact provider text, bounds vectors and only accepts definitive 4xx", () => {
    const chat = normalizeTaskLlmResultPayload("chat", "success", { text: "  exact text  " });
    assert.equal(chat.text, "  exact text  ");
    assert.throws(
      () =>
        normalizeTaskLlmResultPayload("chat", "provider_rejection", {
          error: "timeout",
          statusCode: 408,
        }),
      /not an allowlisted definitive provider rejection/,
    );
    assert.equal(
      normalizeTaskLlmResultPayload("chat", "provider_rejection", {
        error: "rate limited",
        statusCode: 429,
      }).statusCode,
      429,
    );
    assert.throws(
      () => normalizeTaskLlmResultPayload("embedding", "success", { vector: [0, Infinity] }),
      /non-finite/,
    );
  });

  it("rejects secrets and oversized exact request bodies before persistence", () => {
    assert.throws(
      () => assertBoundedProviderPayload({ model: "m", api_key: "secret" }),
      /may contain a secret/,
    );
    assert.throws(
      () => assertBoundedProviderPayload({ model: "m", input: "x".repeat(1_000_001) }),
      /exceeds 1000000 bytes/,
    );
  });

  it("ties token ceilings to the strict exact OpenAI-compatible envelope", async () => {
    const service = new TaskLlmJobsService(null as never, null as never);
    const system = "guard";
    const user = "prompt";
    const base = {
      agentName: "coach",
      runId: "11111111-1111-4111-8111-111111111111",
      executionAttemptId: "22222222-2222-4222-8222-222222222222",
      stepKey: "coach-review:eval",
      providerAttemptNo: 1,
      kind: "chat" as const,
      feature: "coach-review:eval",
      adapter: "openai-compatible",
      adapterVersion: 1,
      endpointProfile: CHAT_PROFILE,
      provider: "openai",
      model: "primary",
      inputTokenCeiling: inputTokenCeiling(`${system}\n\n${user}`),
      outputTokenCeiling: 512,
      requestPayload: {
        model: "primary",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: 512,
      },
    };
    await assert.rejects(
      () =>
        service.ensure("33333333-3333-4333-8333-333333333333", { ...base, inputTokenCeiling: 1 }),
      /does not match the exact chat payload/,
    );
    await assert.rejects(
      () =>
        service.ensure("33333333-3333-4333-8333-333333333333", {
          ...base,
          requestPayload: { ...base.requestPayload, temperature: 0 },
        }),
      /temperature is not allowlisted/,
    );
  });

  it("does not invent usage or resolved model for a provider rejection", () => {
    const dto = taskLlmSettlementDto(
      { id: "job-1", operationHash: "a".repeat(64) } as never,
      "provider_rejection",
      { error: "bad request", statusCode: 400 },
    );
    assert.equal(dto.usage, undefined);
    assert.equal(dto.resolvedModel, undefined);
    assert.equal(dto.outcome, "provider_error");
  });
});
