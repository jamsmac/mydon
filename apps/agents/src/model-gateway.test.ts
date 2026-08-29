import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  CliModelGateway,
  HttpModelGateway,
  harnessPreset,
  isCliProvider,
  llmPosture,
  modelGatewayFromEnv,
  resolveModelChain,
  subscriptionCliEnv,
} from "./model-gateway";

const KEYS = [
  "LLM_ENABLED",
  "LLM_ROUTE",
  "LLM_PROVIDER",
  "LLM_MODEL",
  "LLM_FALLBACK_MODELS",
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "LLM_HTTP_BILLING_MODE",
  "LLM_PRICE_PROVIDER_ID",
  "LLM_CLI_CMD",
  "LLM_CLI_BASE_ARGS",
  "LLM_CLI_PROMPT_VIA",
  "LLM_CLI_MODEL_FLAG",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("resolveModelChain", () => {
  it("основная + запасные по порядку, без дублей и пустых", () => {
    assert.deepEqual(resolveModelChain("gpt-x", "cheap, cheap, free ,"), [
      "gpt-x",
      "cheap",
      "free",
    ]);
  });

  it("только основная", () => {
    assert.deepEqual(resolveModelChain("solo", undefined), ["solo"]);
  });

  it("не настроено → пустая цепочка (LLM-путь выключен)", () => {
    assert.deepEqual(resolveModelChain(undefined, undefined), []);
    assert.deepEqual(resolveModelChain("", "  "), []);
  });

  it("основная не дублируется, если повторена в fallback", () => {
    assert.deepEqual(resolveModelChain("m1", "m1, m2"), ["m1", "m2"]);
  });

  it("выключенная CLI-подписка не добавляет неявную модель", () => {
    assert.deepEqual(resolveModelChain(undefined, undefined, "claude-cli"), []);
    assert.deepEqual(
      resolveModelChain(undefined, undefined, "http"),
      [],
      "не-CLI без модели — пусто",
    );
  });
});

describe("isCliProvider", () => {
  it("разрешает только Claude CLI с доказуемым OAuth mode", () => {
    assert.equal(isCliProvider("claude-cli"), true);
    assert.equal(isCliProvider("claude-subscription"), true);
    assert.equal(isCliProvider("codex-cli"), false);
    assert.equal(isCliProvider("gemini-cli"), false);
    assert.equal(isCliProvider(" CLI "), false);
    assert.equal(isCliProvider("http"), false);
    assert.equal(isCliProvider(undefined), false);
  });
});

describe("subscriptionCliEnv", () => {
  it("не передаёт платные API credentials в подписочный CLI", () => {
    const source: NodeJS.ProcessEnv = {
      PATH: "/bin",
      HOME: "/tmp/test-home",
      CLAUDE_CODE_OAUTH_TOKEN: "subscription-oauth",
      ANTHROPIC_API_KEY: "paid-anthropic",
      OPENAI_API_KEY: "paid-openai",
      GEMINI_API_KEY: "paid-gemini",
      GOOGLE_API_KEY: "paid-google",
      LLM_API_KEY: "paid-gateway",
      LLM_BASE_URL: "https://paid.invalid",
      CLAUDE_CODE_USE_BEDROCK: "1",
    };

    assert.deepEqual(subscriptionCliEnv(source), {
      PATH: "/bin",
      HOME: "/tmp/test-home",
      CLAUDE_CODE_OAUTH_TOKEN: "subscription-oauth",
    });
    assert.equal(source.ANTHROPIC_API_KEY, "paid-anthropic", "исходное окружение не мутируется");
  });
});

describe("CliModelGateway — fail-closed без overage preflight", () => {
  it("ни прямой вызов, ни OAuth не запускают CLI child", async () => {
    let spawned = false;
    const result = await new CliModelGateway("claude", ["-p"], async () => {
      spawned = true;
      return { code: 0, stdout: "не должен запуститься", stderr: "" };
    }).call("default", { prompt: "x" });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /usage credits\/overage/);
    assert.equal(spawned, false);
  });
});

describe("harnessPreset — CLI dispatch отключён", () => {
  it("не возвращает executable preset ни для одного CLI", () => {
    assert.equal(harnessPreset("claude-cli"), null);
    assert.equal(harnessPreset("claude-subscription"), null);
    assert.equal(harnessPreset("codex-cli"), null);
    assert.equal(harnessPreset("gemini-cli"), null);
    assert.equal(harnessPreset("http"), null);
    assert.equal(harnessPreset(undefined), null);
  });
});

describe("HttpModelGateway — metered OpenAI-compatible", () => {
  it("пинит official OpenAI к Standard tier и current output ceiling", () => {
    const official = new HttpModelGateway(
      "https://api.openai.com/v1",
      "openai",
      "fixture-key",
      1000,
      "metered",
    );
    assert.deepEqual(official.buildRequestPayload("gpt-5.6-sol", { prompt: "p", maxTokens: 99 }), {
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "p" }],
      max_completion_tokens: 99,
      service_tier: "default",
    });

    const compatible = new HttpModelGateway(
      "https://gateway.invalid/v1",
      "fixture-provider",
      "",
      1000,
      "metered",
    );
    assert.deepEqual(
      compatible.buildRequestPayload("legacy-model", { prompt: "p", maxTokens: 99 }),
      {
        model: "legacy-model",
        messages: [{ role: "user", content: "p" }],
        max_tokens: 99,
      },
    );
  });

  it("binds endpoint profile to a canonical secret-free base URL hash", () => {
    const plain = new HttpModelGateway("HTTPS://Gateway.Invalid:443/v1", "fixture-provider");
    const slash = new HttpModelGateway("https://gateway.invalid/v1/", "fixture-provider");
    const different = new HttpModelGateway("https://other.invalid/v1", "fixture-provider");

    assert.equal(plain.endpointProfile, slash.endpointProfile);
    assert.notEqual(plain.endpointProfile, different.endpointProfile);
    assert.match(plain.endpointProfile, /^openai-chat-completions:sha256:[0-9a-f]{64}$/);
    assert.equal(plain.endpointProfile.includes("gateway.invalid"), false);
  });

  it("rejects ambiguous or secret-bearing provider base URLs", () => {
    for (const baseUrl of [
      "ftp://gateway.invalid/v1",
      "https://user:secret@gateway.invalid/v1",
      "https://gateway.invalid/v1?api-version=1",
      "https://gateway.invalid/v1#fragment",
      "/relative/v1",
    ]) {
      assert.throws(() => new HttpModelGateway(baseUrl, "fixture-provider"), /base URL/);
    }
  });

  it("exact dispatch classifies only allowlisted 4xx as rejection and never retries transport", async () => {
    const cases = [
      { status: 429, outcome: "provider_rejection" },
      { status: 408, outcome: "unknown" },
      { status: 503, outcome: "unknown" },
    ] as const;
    for (const testCase of cases) {
      let calls = 0;
      let body = "";
      const gateway = new HttpModelGateway(
        "https://gateway.invalid",
        "fixture-provider",
        "",
        1000,
        "metered",
        async (_url, init) => {
          calls += 1;
          body = String(init?.body);
          return new Response("error", { status: testCase.status });
        },
      );
      const exact = { model: "m", messages: [{ role: "user", content: "exact" }] };
      const outcome = await gateway.dispatchExact(exact);
      assert.equal(outcome.outcome, testCase.outcome);
      assert.equal(calls, 1);
      assert.deepEqual(JSON.parse(body), exact);
    }
  });

  it("invalid 2xx response is ambiguous unknown, not a fallback-safe rejection", async () => {
    const gateway = new HttpModelGateway(
      "https://gateway.invalid",
      "fixture-provider",
      "",
      1000,
      "metered",
      async () =>
        new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    assert.equal((await gateway.dispatchExact({ model: "m", messages: [] })).outcome, "unknown");
  });

  it("сохраняет standard usage/id/model, а отсутствующую цену не подменяет нулём", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl-1",
          model: "resolved-model",
          choices: [{ message: { content: "ответ" } }],
          usage: {
            prompt_tokens: 17,
            completion_tokens: 5,
            total_tokens: 22,
            cache_creation_input_tokens: 7,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const gateway = new HttpModelGateway(
      "https://gateway.invalid",
      "fixture-provider",
      "",
      1000,
      "metered",
      fetchImpl,
    );
    const result = await gateway.call("alias", { prompt: "p", maxTokens: 99 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.usage, {
      inputTokens: 17,
      outputTokens: 5,
      cacheCreationInputTokens: 7,
    });
    assert.equal(result.providerRequestId, "chatcmpl-1");
    assert.equal(result.resolvedModel, "resolved-model");
    assert.equal("costUsd" in result, false, "нет provider cost ≠ $0");
  });

  it("does not coerce fractional or string token counts into durable usage", async () => {
    const gateway = new HttpModelGateway(
      "https://gateway.invalid",
      "fixture-provider",
      "",
      1000,
      "metered",
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "answer" } }],
            usage: { prompt_tokens: "17", completion_tokens: 4.9 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const result = await gateway.call("model", { prompt: "p" });
    assert.equal(result.ok, true);
    assert.equal(result.usage, undefined);
  });

  it("разделяет OpenAI prompt_tokens на uncached и cached input", async () => {
    const gateway = new HttpModelGateway(
      "https://api.openai.com/v1",
      "openai",
      "fixture-key",
      1000,
      "metered",
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "answer" } }],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 7,
              prompt_tokens_details: { cached_tokens: 40 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    assert.deepEqual((await gateway.call("gpt-5.6-sol", { prompt: "p" })).usage, {
      inputTokens: 60,
      outputTokens: 7,
      cacheReadInputTokens: 40,
    });
  });

  it("отделяет GPT-5.6 cache writes от uncached input", async () => {
    const gateway = new HttpModelGateway(
      "https://api.openai.com/v1",
      "openai",
      "fixture-key",
      1000,
      "metered",
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "answer" } }],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 7,
              prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    assert.deepEqual((await gateway.call("gpt-5.6-sol", { prompt: "p" })).usage, {
      inputTokens: 50,
      outputTokens: 7,
      cacheReadInputTokens: 40,
      cacheCreationInputTokens: 10,
    });
  });

  it("передаёт cache creation 5m/1h breakdown, когда compatible gateway его даёт", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ответ" } }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 2,
            cache_creation_input_tokens: 7,
            cache_creation: {
              ephemeral_5m_input_tokens: 3,
              ephemeral_1h_input_tokens: 4,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const gateway = new HttpModelGateway(
      "https://gateway.invalid",
      "fixture-provider",
      "",
      1000,
      "metered",
      fetchImpl,
    );
    assert.deepEqual((await gateway.call("model", { prompt: "p" })).usage, {
      inputTokens: 10,
      outputTokens: 2,
      cacheCreationInputTokens: 7,
      cacheCreation5mInputTokens: 3,
      cacheCreation1hInputTokens: 4,
    });
  });

  it("HTTP по умолчанию metered; local только явный", () => {
    assert.equal(new HttpModelGateway("http://local", "fixture-provider").billingMode, "metered");
    assert.equal(new HttpModelGateway("http://local", "", "", 1000, "local").billingMode, "local");
  });

  it("fromEnv блокирует metered без LLM_PRICE_PROVIDER_ID до HTTP", () => {
    process.env.LLM_BASE_URL = "https://gateway.invalid";
    process.env.LLM_MODEL = "priced-model";
    process.env.LLM_HTTP_BILLING_MODE = "metered";

    assert.throws(() => modelGatewayFromEnv(), /LLM_PRICE_PROVIDER_ID.*заблокирован/);
    assert.match(llmPosture(), /LLM_PRICE_PROVIDER_ID.*заблокированы/);
  });

  it("fromEnv fail-closed блокирует codex/gemini subscription presets", () => {
    process.env.LLM_PROVIDER = "codex-cli";
    assert.throws(() => modelGatewayFromEnv(), /subscription auth mode не доказан/);
    assert.match(llmPosture(), /вызовы заблокированы/);

    process.env.LLM_PROVIDER = "gemini-cli";
    assert.throws(() => modelGatewayFromEnv(), /subscription auth mode не доказан/);
  });

  it("fromEnv блокирует Claude CLI даже с OAuth: overage не доказан", () => {
    process.env.LLM_PROVIDER = "claude-cli";
    assert.throws(() => modelGatewayFromEnv(), /usage credits\/overage/);
    assert.match(llmPosture(), /usage credits\/overage/);

    process.env.CLAUDE_CODE_OAUTH_TOKEN = "subscription-oauth";
    assert.throws(() => modelGatewayFromEnv(), /usage credits\/overage/);
  });

  it("fromEnv передаёт exact pricing profile; local разрешён без него", () => {
    process.env.LLM_BASE_URL = "https://gateway.invalid";
    process.env.LLM_MODEL = "priced-model";
    process.env.LLM_PRICE_PROVIDER_ID = "omniroute-anthropic";
    const metered = modelGatewayFromEnv();
    assert.equal(metered?.provider, "omniroute-anthropic");
    assert.equal(metered?.billingMode, "metered");
    assert.match(llmPosture(), /price provider=omniroute-anthropic/);

    process.env.LLM_HTTP_BILLING_MODE = "local";
    delete process.env.LLM_PRICE_PROVIDER_ID;
    const local = modelGatewayFromEnv();
    assert.equal(local?.provider, "");
    assert.equal(local?.billingMode, "local");
  });

  it("панельный LLM_ENABLED=0 гасит даже полностью заданный HTTP-маршрут", () => {
    process.env.LLM_ENABLED = "0";
    process.env.LLM_ROUTE = "openai-api";
    process.env.LLM_BASE_URL = "https://api.openai.com/v1";
    process.env.LLM_MODEL = "gpt-5.6-sol";
    process.env.LLM_PRICE_PROVIDER_ID = "openai";
    process.env.LLM_API_KEY = "secret";

    assert.equal(modelGatewayFromEnv(), null);
    assert.match(llmPosture(), /LLM_ENABLED=0/);
  });

  it("предпочтительная Codex subscription остаётся fail-closed", () => {
    process.env.LLM_ENABLED = "1";
    process.env.LLM_ROUTE = "codex-subscription";

    assert.throws(() => modelGatewayFromEnv(), /Codex\/ChatGPT subscription.*заблокирована/);
    assert.match(llmPosture(), /Codex\/ChatGPT subscription.*заблокирована/);
  });

  it("OpenAI API route не создаёт gateway без серверного ключа", () => {
    process.env.LLM_ENABLED = "1";
    process.env.LLM_ROUTE = "openai-api";
    process.env.LLM_BASE_URL = "https://api.openai.com/v1";
    process.env.LLM_MODEL = "gpt-5.6-sol";
    process.env.LLM_PRICE_PROVIDER_ID = "openai";

    assert.throws(() => modelGatewayFromEnv(), /LLM_API_KEY.*заблокирован/);
    assert.match(llmPosture(), /LLM_API_KEY.*заблокирован/);
  });

  it("OpenAI API route принимает только exact official endpoint/provider и ключ", () => {
    process.env.LLM_ENABLED = "1";
    process.env.LLM_ROUTE = "openai-api";
    process.env.LLM_BASE_URL = "https://api.openai.com/v1";
    process.env.LLM_MODEL = "gpt-5.6-sol";
    process.env.LLM_PRICE_PROVIDER_ID = "openai";
    process.env.LLM_API_KEY = "server-secret";

    const gateway = modelGatewayFromEnv();
    assert.equal(gateway?.provider, "openai");
    assert.equal(gateway?.billingMode, "metered");
    assert.match(llmPosture(), /price provider=openai/);

    process.env.LLM_BASE_URL = "https://proxy.invalid/v1";
    assert.throws(() => modelGatewayFromEnv(), /api\.openai\.com/);
  });

  it("явный openai-api заменяет скрытый legacy LLM_PROVIDER", () => {
    process.env.LLM_ENABLED = "1";
    process.env.LLM_ROUTE = "openai-api";
    process.env.LLM_PROVIDER = "claude-cli";
    process.env.LLM_BASE_URL = "https://api.openai.com/v1";
    process.env.LLM_MODEL = "gpt-5.6-sol";
    process.env.LLM_PRICE_PROVIDER_ID = "openai";
    process.env.LLM_API_KEY = "server-secret";

    assert.ok(modelGatewayFromEnv() instanceof HttpModelGateway);
    assert.match(llmPosture(), /price provider=openai/);
  });

  it("неизвестный явный route не обходит legacy fail-closed режим", () => {
    process.env.LLM_ROUTE = "custom-http";
    process.env.LLM_BASE_URL = "https://gateway.invalid/v1";
    process.env.LLM_MODEL = "custom-model";
    process.env.LLM_PRICE_PROVIDER_ID = "custom";

    assert.throws(() => modelGatewayFromEnv(), /Неизвестный LLM_ROUTE/);
    assert.match(llmPosture(), /неизвестный LLM_ROUTE/);
  });
});
