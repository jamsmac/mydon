import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertClaudeCliSubscriptionStatus,
  assertClaudeSubscriptionAccount,
  assertClaudeSubscriptionInit,
  assertClaudeSubscriptionOverageDisabled,
  requireClaudeSubscriptionEnv,
  sanitizeSubscriptionEnv,
  SUBSCRIPTION_PAID_ENV_KEYS,
} from "./subscription-env";

describe("sanitizeSubscriptionEnv", () => {
  it("убирает API/cloud bypass, сохраняет subscription OAuth/PATH/HOME и не мутирует source", () => {
    const source: Record<string, string | undefined> = {
      PATH: "/bin",
      HOME: "/tmp/test-home",
      CLAUDE_CODE_OAUTH_TOKEN: "subscription-oauth",
      KEEP_ME: "safe",
    };
    for (const key of SUBSCRIPTION_PAID_ENV_KEYS) source[key] = `paid:${key}`;
    const before = { ...source };

    const clean = sanitizeSubscriptionEnv(source);

    for (const key of SUBSCRIPTION_PAID_ENV_KEYS) {
      assert.equal(clean[key], undefined, `${key} не должен попасть в subscription child`);
    }
    assert.equal(clean.CLAUDE_CODE_OAUTH_TOKEN, "subscription-oauth");
    assert.equal(clean.PATH, "/bin");
    assert.equal(clean.HOME, "/tmp/test-home");
    assert.equal(clean.KEEP_ME, "safe");
    assert.deepEqual(source, before, "исходный env не мутируется");
  });

  it("требует явный OAuth и не полагается на сохранённый CLI auth", () => {
    assert.throws(
      () => requireClaudeSubscriptionEnv({ PATH: "/bin", HOME: "/tmp/home" }),
      /CLAUDE_CODE_OAUTH_TOKEN.*обязателен/,
    );

    assert.deepEqual(
      requireClaudeSubscriptionEnv({
        PATH: "/bin",
        HOME: "/tmp/home",
        CLAUDE_CODE_OAUTH_TOKEN: "  subscription-oauth  ",
        ANTHROPIC_API_KEY: "paid",
        FUTURE_PAID_BACKEND_FLAG: "1",
        SERVICE_TOKEN: "internal-service-secret",
        TELEGRAM_BOT_TOKEN: "telegram-secret",
        OURVEND_PASSWORD: "vendor-secret",
        NOTION_TOKEN: "notion-secret",
        LC_ALL: "ru_RU.UTF-8",
      }),
      {
        PATH: "/bin",
        HOME: "/tmp/home",
        CLAUDE_CODE_OAUTH_TOKEN: "subscription-oauth",
        LC_ALL: "ru_RU.UTF-8",
      },
    );
  });

  it("принимает только доказанный first-party OAuth для SDK и CLI", () => {
    assert.doesNotThrow(() =>
      assertClaudeSubscriptionAccount({
        tokenSource: "CLAUDE_CODE_OAUTH_TOKEN",
        apiProvider: "firstParty",
      }),
    );
    assert.doesNotThrow(() =>
      assertClaudeCliSubscriptionStatus({
        loggedIn: true,
        authMethod: "oauth_token",
        apiProvider: "firstParty",
      }),
    );

    for (const account of [
      { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "bedrock" },
      { tokenSource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" },
      {
        tokenSource: "CLAUDE_CODE_OAUTH_TOKEN",
        apiProvider: "firstParty",
        apiKeySource: "apiKeyHelper",
      },
    ]) {
      assert.throws(() => assertClaudeSubscriptionAccount(account), /auth не доказан/);
    }
    for (const status of [
      { loggedIn: false, authMethod: "oauth_token", apiProvider: "firstParty" },
      { loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" },
      { loggedIn: true, authMethod: "oauth_token", apiProvider: "vertex" },
      {
        loggedIn: true,
        authMethod: "oauth_token",
        apiProvider: "firstParty",
        apiKeySource: "settings",
      },
    ]) {
      assert.throws(() => assertClaudeCliSubscriptionStatus(status), /auth не доказан/);
    }

    assert.doesNotThrow(() =>
      assertClaudeSubscriptionInit({ type: "system", subtype: "init", apiKeySource: "oauth" }),
    );
    assert.doesNotThrow(() =>
      assertClaudeSubscriptionInit({ type: "system", subtype: "init", apiKeySource: "none" }),
    );
    assert.throws(
      () =>
        assertClaudeSubscriptionInit({
          type: "system",
          subtype: "init",
          apiKeySource: "user",
        }),
      /apiKeySource=none\|oauth/,
    );
  });

  it("до model turn требует явно выключенные usage credits/overage", () => {
    const disabled = {
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: {
        extra_usage: {
          is_enabled: false,
          monthly_limit: null,
          used_credits: null,
          utilization: null,
        },
      },
    };
    assert.doesNotThrow(() => assertClaudeSubscriptionOverageDisabled(disabled));

    for (const unsafe of [
      {
        ...disabled,
        rate_limits: { extra_usage: { is_enabled: true, monthly_limit: 100 } },
      },
      { ...disabled, rate_limits: { extra_usage: null } },
      { ...disabled, rate_limits: {} },
      { ...disabled, rate_limits_available: false, rate_limits: null },
      { ...disabled, subscription_type: null },
      { ...disabled, subscription_type: "future-plan-with-unknown-semantics" },
    ]) {
      assert.throws(
        () => assertClaudeSubscriptionOverageDisabled(unsafe),
        /preflight|usage credits\/overage/,
      );
    }
  });
});
