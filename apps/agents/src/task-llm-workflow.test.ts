import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { EMBEDDING_ENDPOINT_PROFILE } from "./embedding";
import { CHAT_ENDPOINT_PROFILE, bindHttpEndpoint } from "./model-gateway";
import { buildTaskLlmWorkflowPlan } from "./task-llm-workflow";

const ENV_KEYS = [
  "LLM_PROVIDER",
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "LLM_MODEL",
  "LLM_FALLBACK_MODELS",
  "LLM_HTTP_BILLING_MODE",
  "LLM_PRICE_PROVIDER_ID",
  "EMBED_BASE_URL",
  "EMBED_API_KEY",
  "EMBED_MODEL",
  "EMBED_BILLING_MODE",
  "EMBED_PRICE_PROVIDER_ID",
] as const;

const original = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function configureChat(): void {
  process.env.LLM_BASE_URL = "https://gateway.invalid";
  process.env.LLM_HTTP_BILLING_MODE = "metered";
  process.env.LLM_PRICE_PROVIDER_ID = "openai";
  process.env.LLM_MODEL = "m1";
  process.env.LLM_FALLBACK_MODELS = "m2,m3,m4";
}

describe("versioned task LLM workflow plan", () => {
  it("assess-ideas allowlists one recall embedding and a bounded chat chain", () => {
    configureChat();
    process.env.EMBED_BASE_URL = "https://gateway.invalid";
    process.env.EMBED_BILLING_MODE = "metered";
    process.env.EMBED_PRICE_PROVIDER_ID = "openai";
    process.env.EMBED_MODEL = "embed-v1";
    const chatProfile = bindHttpEndpoint(
      CHAT_ENDPOINT_PROFILE,
      "https://gateway.invalid",
    ).endpointProfile;
    const embeddingProfile = bindHttpEndpoint(
      EMBEDDING_ENDPOINT_PROFILE,
      "https://gateway.invalid",
    ).endpointProfile;

    assert.deepEqual(buildTaskLlmWorkflowPlan("assess-ideas"), {
      version: 1,
      steps: [
        {
          stepKey: "assess-ideas:recall",
          kind: "embedding",
          feature: "assess-ideas:recall",
          adapter: "openai-compatible",
          adapterVersion: 1,
          endpointProfile: embeddingProfile,
          provider: "openai",
          models: ["embed-v1"],
        },
        {
          stepKey: "assess-ideas",
          kind: "chat",
          feature: "assess-ideas",
          adapter: "openai-compatible",
          adapterVersion: 1,
          endpointProfile: chatProfile,
          provider: "openai",
          models: ["m1", "m2", "m3"],
        },
      ],
    });
  });

  it("coach-review versions eval/propose independently", () => {
    configureChat();
    const plan = buildTaskLlmWorkflowPlan("coach-review");
    assert.equal(plan.version, 1);
    assert.deepEqual(
      plan.steps.map((step) => step.stepKey),
      ["coach-review:eval", "coach-review:propose"],
    );
    assert.ok(plan.steps.every((step) => step.models.length === 3));
  });

  it("deterministic and explicitly local routes keep an empty durable provider plan", () => {
    configureChat();
    process.env.LLM_HTTP_BILLING_MODE = "local";
    assert.deepEqual(buildTaskLlmWorkflowPlan("coach-review"), { version: 1, steps: [] });
    assert.deepEqual(buildTaskLlmWorkflowPlan("watch-receivables"), { version: 1, steps: [] });
  });

  it("does not invent a provider model when the configured model chain is empty", () => {
    process.env.LLM_BASE_URL = "https://gateway.invalid";
    process.env.LLM_HTTP_BILLING_MODE = "metered";
    process.env.LLM_PRICE_PROVIDER_ID = "openai";
    delete process.env.LLM_MODEL;
    delete process.env.LLM_FALLBACK_MODELS;

    assert.deepEqual(buildTaskLlmWorkflowPlan("coach-review"), { version: 1, steps: [] });
  });
});
