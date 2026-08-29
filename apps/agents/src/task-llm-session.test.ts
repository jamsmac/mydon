import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LlmBudgetDeniedError, LlmReplayBlockedError } from "@mydon/shared";
import type {
  CompleteAgentTaskLlmJobInput,
  CompleteAgentTaskLlmJobResult,
  TaskLlmStoredResult,
} from "./core-client";
import { HttpEmbeddingGateway, embedWithLedger, type EmbeddingGateway } from "./embedding";
import { callModel } from "./llm";
import {
  HttpModelGateway,
  type ExactProviderOutcome,
  type ModelGateway,
  type ModelResult,
} from "./model-gateway";
import { TaskLlmSession, TaskLlmWorkflowChangedError } from "./task-llm-session";
import type { TaskLlmWorkflowPlan } from "./task-llm-workflow";

const CHAT_PLAN: TaskLlmWorkflowPlan = {
  version: 1,
  steps: [
    {
      stepKey: "coach-review:eval",
      kind: "chat",
      feature: "coach-review:eval",
      adapter: "openai-compatible",
      adapterVersion: 1,
      endpointProfile: "openai-chat-completions",
      provider: "openai",
      models: ["primary", "backup"],
    },
  ],
};

const EMBEDDING_PLAN: TaskLlmWorkflowPlan = {
  version: 1,
  steps: [
    {
      stepKey: "assess-ideas:recall",
      kind: "embedding",
      feature: "assess-ideas:recall",
      adapter: "openai-compatible",
      adapterVersion: 1,
      endpointProfile: "openai-embeddings",
      provider: "openai",
      models: ["embed-v1"],
    },
  ],
};

const FENCE = {
  taskId: "task-1",
  agentName: "coach",
  runId: "11111111-1111-4111-8111-111111111111",
  executionAttemptId: "22222222-2222-4222-8222-222222222222",
};
const JOB_1 = "33333333-3333-4333-8333-333333333333";
const JOB_2 = "44444444-4444-4444-8444-444444444444";
const EMBEDDING_JOB = "55555555-5555-4555-8555-555555555555";
const OP_1 = "a".repeat(64);
const OP_2 = "b".repeat(64);
const EMBEDDING_OP = "c".repeat(64);

function durableResult(
  kind: "success" | "provider_rejection",
  payload: Record<string, unknown>,
): TaskLlmStoredResult {
  return { kind, payload, resultHash: `hash:${kind}:${JSON.stringify(payload)}` };
}

function completed(
  input: CompleteAgentTaskLlmJobInput,
  replay = false,
): CompleteAgentTaskLlmJobResult {
  if (input.outcome === "unknown") return { status: "unknown", replay };
  const kind = input.outcome === "success" ? "success" : "provider_rejection";
  return {
    status: kind === "success" ? "succeeded" : "rejected",
    replay,
    result: durableResult(kind, (input.result ?? {}) as Record<string, unknown>),
  };
}

function chatGateway(outcomes: ExactProviderOutcome<ModelResult>[]) {
  const dispatched: Record<string, unknown>[] = [];
  const gateway: ModelGateway = {
    provider: "openai",
    billingMode: "metered",
    adapter: "openai-compatible",
    adapterVersion: 1,
    endpointProfile: "openai-chat-completions",
    call: async () => {
      throw new Error("legacy provider path must not run");
    },
    buildRequestPayload: (model, request) => ({
      model,
      messages: [{ role: "user", content: request.prompt }],
      max_tokens: request.maxTokens,
    }),
    dispatchExact: async (payload) => {
      dispatched.push(payload);
      const outcome = outcomes.shift();
      if (!outcome) throw new Error("unexpected physical dispatch");
      return outcome;
    },
  };
  return { gateway, dispatched };
}

function taskCall(session: TaskLlmSession, gateway: ModelGateway) {
  return callModel(
    gateway,
    {
      prompt: "evaluate",
      agentName: "coach",
      feature: "coach-review:eval",
      requestKey: "ignored-by-durable-task",
      taskLlm: session,
    },
    ["different-current-config"],
  );
}

describe("TaskLlmSession durable provider state machine", () => {
  it("an empty configured model chain performs no Core or provider operation", async () => {
    let coreCalls = 0;
    const core = {
      ensureAgentTaskLlmJob: async () => {
        coreCalls += 1;
        throw new Error("empty model chain must not ensure");
      },
      claimAgentTaskLlmDispatch: async () => {
        coreCalls += 1;
        throw new Error("empty model chain must not claim");
      },
      completeAgentTaskLlmJob: async () => {
        coreCalls += 1;
        throw new Error("empty model chain must not complete");
      },
    };
    const { gateway, dispatched } = chatGateway([]);
    const session = new TaskLlmSession(core as never, FENCE, { version: 1, steps: [] });

    const result = await callModel(
      gateway,
      {
        prompt: "evaluate",
        agentName: "coach",
        feature: "coach-review:eval",
        requestKey: "empty-chain",
        taskLlm: session,
      },
      [],
    );

    assert.equal(result.ok, false);
    assert.match(result.reason, /модель не настроена/);
    assert.equal(coreCalls, 0);
    assert.deepEqual(dispatched, []);
  });

  it("blocks a resumed chat plan when the effective provider base URL changed", async () => {
    let coreCalls = 0;
    let providerCalls = 0;
    const oldGateway = new HttpModelGateway("https://old-gateway.invalid/v1", "openai");
    const currentGateway = new HttpModelGateway(
      "https://new-gateway.invalid/v1",
      "openai",
      "",
      1000,
      "metered",
      async () => {
        providerCalls += 1;
        throw new Error("provider must stay untouched");
      },
    );
    const plan: TaskLlmWorkflowPlan = {
      version: 1,
      steps: [{ ...CHAT_PLAN.steps[0]!, endpointProfile: oldGateway.endpointProfile }],
    };
    const core = {
      ensureAgentTaskLlmJob: async () => {
        coreCalls += 1;
        throw new Error("Core must stay untouched");
      },
      claimAgentTaskLlmDispatch: async () => {
        coreCalls += 1;
        throw new Error("Core must stay untouched");
      },
      completeAgentTaskLlmJob: async () => {
        coreCalls += 1;
        throw new Error("Core must stay untouched");
      },
    };

    await assert.rejects(
      taskCall(new TaskLlmSession(core as never, FENCE, plan), currentGateway),
      TaskLlmWorkflowChangedError,
    );
    assert.equal(coreCalls, 0);
    assert.equal(providerCalls, 0);
  });

  it("does not bypass a saved metered chat step after config switches to local", async () => {
    let coreCalls = 0;
    let providerCalls = 0;
    const metered = new HttpModelGateway("https://gateway.invalid/v1", "openai");
    const local = new HttpModelGateway(
      "https://gateway.invalid/v1/",
      "openai",
      "",
      1000,
      "local",
      async () => {
        providerCalls += 1;
        throw new Error("local provider must stay untouched");
      },
    );
    const plan: TaskLlmWorkflowPlan = {
      version: 1,
      steps: [{ ...CHAT_PLAN.steps[0]!, endpointProfile: metered.endpointProfile }],
    };
    const core = {
      ensureAgentTaskLlmJob: async () => {
        coreCalls += 1;
        throw new Error("Core must stay untouched");
      },
      claimAgentTaskLlmDispatch: async () => {
        coreCalls += 1;
        throw new Error("Core must stay untouched");
      },
      completeAgentTaskLlmJob: async () => {
        coreCalls += 1;
        throw new Error("Core must stay untouched");
      },
    };

    await assert.rejects(
      taskCall(new TaskLlmSession(core as never, FENCE, plan), local),
      TaskLlmWorkflowChangedError,
    );
    assert.equal(coreCalls, 0);
    assert.equal(providerCalls, 0);
  });

  it("does not bypass a saved metered embedding step after config switches to local", async () => {
    let coreCalls = 0;
    let providerCalls = 0;
    const metered = new HttpEmbeddingGateway(
      "https://gateway.invalid/v1",
      "openai",
      "",
      "embed-v1",
    );
    const local = new HttpEmbeddingGateway(
      "https://gateway.invalid/v1/",
      "openai",
      "",
      "embed-v1",
      1000,
      "local",
      async () => {
        providerCalls += 1;
        throw new Error("local embedding provider must stay untouched");
      },
    );
    const plan: TaskLlmWorkflowPlan = {
      version: 1,
      steps: [{ ...EMBEDDING_PLAN.steps[0]!, endpointProfile: metered.endpointProfile }],
    };
    const core = {
      ensureAgentTaskLlmJob: async () => {
        coreCalls += 1;
        throw new Error("Core must stay untouched");
      },
      claimAgentTaskLlmDispatch: async () => {
        coreCalls += 1;
        throw new Error("Core must stay untouched");
      },
      completeAgentTaskLlmJob: async () => {
        coreCalls += 1;
        throw new Error("Core must stay untouched");
      },
    };

    await assert.rejects(
      () =>
        embedWithLedger(local, "text", {
          agentName: "coach",
          feature: "assess-ideas:recall",
          requestKey: "local-resume",
          taskLlm: new TaskLlmSession(core as never, FENCE, plan),
        }),
      TaskLlmWorkflowChangedError,
    );
    assert.equal(coreCalls, 0);
    assert.equal(providerCalls, 0);
  });

  it("malformed claim payload blocks before the provider wire", async () => {
    const core = {
      ensureAgentTaskLlmJob: async () => ({
        jobId: JOB_1,
        status: "ready" as const,
        operationHash: OP_1,
      }),
      claimAgentTaskLlmDispatch: async () => ({
        granted: true,
        replay: false,
        status: "dispatching" as const,
        operationHash: OP_1,
        requestPayload: ["not", "an", "object"],
      }),
      completeAgentTaskLlmJob: async () => {
        throw new Error("must not complete");
      },
    };
    const { gateway, dispatched } = chatGateway([
      {
        outcome: "success",
        result: { text: "must not dispatch", model: "primary", ok: true },
      },
    ]);

    await assert.rejects(
      taskCall(new TaskLlmSession(core as never, FENCE, CHAT_PLAN), gateway),
      LlmReplayBlockedError,
    );
    assert.deepEqual(dispatched, []);
  });

  it("lost claim response повторяет тот же token и dispatch-ит exact Core payload один раз", async () => {
    const storedPayload = {
      model: "primary",
      messages: [{ role: "user", content: "stored exact body" }],
      max_tokens: 2048,
    };
    const claimTokens: string[] = [];
    let claimCalls = 0;
    const core = {
      ensureAgentTaskLlmJob: async () => ({
        jobId: JOB_1,
        status: "ready" as const,
        operationHash: OP_1,
      }),
      claimAgentTaskLlmDispatch: async (
        _taskId: string,
        _jobId: string,
        input: { dispatchToken: string },
      ) => {
        claimTokens.push(input.dispatchToken);
        claimCalls += 1;
        if (claimCalls === 1) throw new Error("response lost");
        return {
          granted: true,
          replay: true,
          status: "dispatching" as const,
          operationHash: OP_1,
          requestPayload: storedPayload,
        };
      },
      completeAgentTaskLlmJob: async (
        _taskId: string,
        _jobId: string,
        input: CompleteAgentTaskLlmJobInput,
      ) => completed(input),
    };
    const { gateway, dispatched } = chatGateway([
      {
        outcome: "success",
        result: { text: "done", model: "primary", resolvedModel: "primary", ok: true },
      },
    ]);

    const result = await taskCall(new TaskLlmSession(core as never, FENCE, CHAT_PLAN), gateway);
    assert.equal(result.text, "done");
    assert.equal(claimCalls, 2);
    assert.equal(claimTokens[0], claimTokens[1], "lost response recovery must reuse token");
    assert.deepEqual(dispatched, [storedPayload], "gateway must not reconstruct provider body");
  });

  it("lost complete response exact-replays completion and never repeats provider", async () => {
    const completeInputs: CompleteAgentTaskLlmJobInput[] = [];
    let completeCalls = 0;
    const core = {
      ensureAgentTaskLlmJob: async () => ({
        jobId: JOB_1,
        status: "ready" as const,
        operationHash: OP_1,
      }),
      claimAgentTaskLlmDispatch: async () => ({
        granted: true,
        replay: false,
        status: "dispatching" as const,
        operationHash: OP_1,
        requestPayload: { model: "primary", messages: [] },
      }),
      completeAgentTaskLlmJob: async (
        _taskId: string,
        _jobId: string,
        input: CompleteAgentTaskLlmJobInput,
      ) => {
        completeInputs.push(input);
        completeCalls += 1;
        if (completeCalls === 1) throw new Error("complete response lost");
        return completed(input, true);
      },
    };
    const { gateway, dispatched } = chatGateway([
      {
        outcome: "success",
        result: {
          text: "saved",
          model: "primary",
          usage: { inputTokens: 5, outputTokens: 2 },
          ok: true,
        },
      },
    ]);

    assert.equal(
      (await taskCall(new TaskLlmSession(core as never, FENCE, CHAT_PLAN), gateway)).text,
      "saved",
    );
    assert.equal(dispatched.length, 1);
    assert.equal(completeCalls, 2);
    assert.deepEqual(completeInputs[0], completeInputs[1]);
    assert.notEqual(completeInputs[0]?.dispatchToken, "");
  });

  it("resume after durable complete reuses result without second provider call", async () => {
    let saved: TaskLlmStoredResult | undefined;
    let claimCalls = 0;
    const core = {
      ensureAgentTaskLlmJob: async () =>
        saved
          ? { jobId: JOB_1, status: "succeeded" as const, operationHash: OP_1, result: saved }
          : { jobId: JOB_1, status: "ready" as const, operationHash: OP_1 },
      claimAgentTaskLlmDispatch: async () => {
        claimCalls += 1;
        return {
          granted: true,
          replay: false,
          status: "dispatching" as const,
          operationHash: OP_1,
          requestPayload: { model: "primary", messages: [] },
        };
      },
      completeAgentTaskLlmJob: async (
        _taskId: string,
        _jobId: string,
        input: CompleteAgentTaskLlmJobInput,
      ) => {
        const response = completed(input);
        saved = response.result;
        return response;
      },
    };
    const first = chatGateway([
      {
        outcome: "success",
        result: { text: "durable", model: "primary", ok: true },
      },
    ]);
    const second = chatGateway([]);

    assert.equal(
      (await taskCall(new TaskLlmSession(core as never, FENCE, CHAT_PLAN), first.gateway)).text,
      "durable",
    );
    assert.equal(
      (await taskCall(new TaskLlmSession(core as never, FENCE, CHAT_PLAN), second.gateway)).text,
      "durable",
    );
    assert.equal(first.dispatched.length, 1);
    assert.equal(second.dispatched.length, 0);
    assert.equal(claimCalls, 1);
  });

  it("fallback N+1 runs only after durable allowlisted provider rejection", async () => {
    const ensuredModels: string[] = [];
    const completionInputs: CompleteAgentTaskLlmJobInput[] = [];
    const core = {
      ensureAgentTaskLlmJob: async (
        _taskId: string,
        input: { model: string; providerAttemptNo: number },
      ) => {
        ensuredModels.push(input.model);
        return {
          jobId: input.providerAttemptNo === 1 ? JOB_1 : JOB_2,
          status: "ready" as const,
          operationHash: input.providerAttemptNo === 1 ? OP_1 : OP_2,
        };
      },
      claimAgentTaskLlmDispatch: async (_taskId: string, jobId: string) => ({
        granted: true,
        replay: false,
        status: "dispatching" as const,
        operationHash: jobId === JOB_1 ? OP_1 : OP_2,
        requestPayload: { model: jobId === JOB_1 ? "primary" : "backup", messages: [] },
      }),
      completeAgentTaskLlmJob: async (
        _taskId: string,
        _jobId: string,
        input: CompleteAgentTaskLlmJobInput,
      ) => {
        completionInputs.push(input);
        return completed(input);
      },
    };
    const { gateway, dispatched } = chatGateway([
      {
        outcome: "provider_rejection",
        result: { text: "", model: "primary", ok: false, error: "429", statusCode: 429 },
      },
      {
        outcome: "success",
        result: { text: "backup answer", model: "backup", ok: true },
      },
    ]);

    const result = await taskCall(new TaskLlmSession(core as never, FENCE, CHAT_PLAN), gateway);
    assert.equal(result.text, "backup answer");
    assert.deepEqual(ensuredModels, ["primary", "backup"]);
    assert.equal(dispatched.length, 2);
    assert.equal(completionInputs[0]?.outcome, "provider_rejection");
    assert.equal(completionInputs[0]?.result?.statusCode, 429);
    assert.equal(
      "usage" in (completionInputs[0]?.result ?? {}),
      false,
      "usage must not be invented",
    );
  });

  it("ambiguous provider outcome becomes unknown and blocks every fallback", async () => {
    let ensureCalls = 0;
    const core = {
      ensureAgentTaskLlmJob: async () => {
        ensureCalls += 1;
        return { jobId: JOB_1, status: "ready" as const, operationHash: OP_1 };
      },
      claimAgentTaskLlmDispatch: async () => ({
        granted: true,
        replay: false,
        status: "dispatching" as const,
        operationHash: OP_1,
        requestPayload: { model: "primary", messages: [] },
      }),
      completeAgentTaskLlmJob: async () => ({ status: "unknown" as const, replay: false }),
    };
    const { gateway, dispatched } = chatGateway([
      {
        outcome: "unknown",
        result: { text: "", model: "primary", ok: false, error: "timeout" },
      },
    ]);

    await assert.rejects(
      taskCall(new TaskLlmSession(core as never, FENCE, CHAT_PLAN), gateway),
      LlmReplayBlockedError,
    );
    assert.equal(ensureCalls, 1, "backup job must not be ensured after unknown");
    assert.equal(dispatched.length, 1);
  });

  it("waiting_budget stops before claim/provider", async () => {
    let claimed = false;
    const core = {
      ensureAgentTaskLlmJob: async () => ({
        jobId: JOB_1,
        status: "waiting_budget" as const,
        operationHash: OP_1,
        denial: {
          action: "pause" as const,
          reason: "daily cap",
          budget: {
            day: "2026-08-29",
            globalCapUsd: 0,
            globalExposureUsd: 0,
            remainingUsd: 0,
          },
        },
      }),
      claimAgentTaskLlmDispatch: async () => {
        claimed = true;
        throw new Error("must not claim");
      },
      completeAgentTaskLlmJob: async () => {
        throw new Error("must not complete");
      },
    };
    const { gateway, dispatched } = chatGateway([]);
    await assert.rejects(
      taskCall(new TaskLlmSession(core as never, FENCE, CHAT_PLAN), gateway),
      LlmBudgetDeniedError,
    );
    assert.equal(claimed, false);
    assert.equal(dispatched.length, 0);
  });

  it("metered embedding dispatches exact stored envelope and returns durable vector", async () => {
    const storedPayload = { model: "embed-v1", input: "stored exact embedding input" };
    const dispatched: Record<string, unknown>[] = [];
    const gateway: EmbeddingGateway = {
      provider: "openai",
      billingMode: "metered",
      model: "changed-current-model",
      adapter: "openai-compatible",
      adapterVersion: 1,
      endpointProfile: "openai-embeddings",
      embed: async () => {
        throw new Error("legacy embedding path must not run");
      },
      buildRequestPayload: (model, text) => ({ model, input: text }),
      dispatchExact: async (payload) => {
        dispatched.push(payload);
        return {
          outcome: "success",
          result: {
            vector: [0.25, 0.75],
            usage: { inputTokens: 3, outputTokens: 0 },
            resolvedModel: "embed-v1",
          },
        };
      },
    };
    const core = {
      ensureAgentTaskLlmJob: async () => ({
        jobId: EMBEDDING_JOB,
        status: "ready" as const,
        operationHash: EMBEDDING_OP,
      }),
      claimAgentTaskLlmDispatch: async () => ({
        granted: true,
        replay: false,
        status: "dispatching" as const,
        operationHash: EMBEDDING_OP,
        requestPayload: storedPayload,
      }),
      completeAgentTaskLlmJob: async (
        _taskId: string,
        _jobId: string,
        input: CompleteAgentTaskLlmJobInput,
      ) => completed(input),
    };
    const session = new TaskLlmSession(core as never, FENCE, EMBEDDING_PLAN);

    assert.deepEqual(
      await embedWithLedger(gateway, "current input", {
        agentName: "coach",
        feature: "assess-ideas:recall",
        requestKey: "ignored",
        taskLlm: session,
      }),
      [0.25, 0.75],
    );
    assert.deepEqual(dispatched, [storedPayload]);
  });
});
