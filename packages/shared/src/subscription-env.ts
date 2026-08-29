/**
 * Credentials/endpoints, которые могут незаметно переключить subscription
 * harness на metered API, Bedrock, Vertex или Foundry.
 *
 * Список намеренно exact: `CLAUDE_CODE_OAUTH_TOKEN`, PATH, HOME и обычные
 * настройки подписочного CLI должны сохраниться.
 */
export const SUBSCRIPTION_PAID_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_WORKSPACE_ID",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_REGION",
  "GOOGLE_CLOUD_API_KEY",
  "GOOGLE_OAUTH_ACCESS_TOKEN",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "VERTEX_AI_API_KEY",
  "VERTEX_PROJECT_ID",
  "VERTEX_LOCATION",
  "CLOUD_ML_REGION",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_TENANT_ID",
  "AZURE_FEDERATED_TOKEN_FILE",
  "FOUNDRY_API_KEY",
  "FOUNDRY_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "CODEX_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OPENROUTER_API_KEY",
  "LLM_API_KEY",
  "LLM_BASE_URL",
] as const;

/** Clone + exact deny-list. Исходный env никогда не мутируется. */
export function sanitizeSubscriptionEnv(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const clean = { ...source };
  for (const key of SUBSCRIPTION_PAID_ENV_KEYS) delete clean[key];
  return clean;
}

/**
 * A subscription launch is provable only with an explicit Claude subscription
 * OAuth token. Falling back to auth persisted in ~/.claude is forbidden: that
 * profile may contain apiKeyHelper or cloud/API credentials.
 */
export function requireClaudeSubscriptionEnv(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const oauthToken = source.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (!oauthToken) {
    throw new Error(
      "CLAUDE_CODE_OAUTH_TOKEN обязателен для Claude subscription; сохранённый CLI auth не используется",
    );
  }
  const child: Record<string, string | undefined> = { CLAUDE_CODE_OAUTH_TOKEN: oauthToken };
  const allow = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LANGUAGE",
    "TZ",
    "TERM",
    "COLORTERM",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
  ]);
  for (const [key, value] of Object.entries(source)) {
    if (allow.has(key) || key.startsWith("LC_")) child[key] = value;
  }
  return child;
}

function authRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Claude subscription auth preflight вернул неверный ответ");
  }
  return value as Record<string, unknown>;
}

/** Validate `Query.accountInfo()` before iterating the Agent SDK query. */
export function assertClaudeSubscriptionAccount(value: unknown): void {
  const account = authRecord(value);
  if (
    account.apiProvider !== "firstParty" ||
    account.tokenSource !== "CLAUDE_CODE_OAUTH_TOKEN" ||
    (typeof account.apiKeySource === "string" && account.apiKeySource.trim() !== "")
  ) {
    throw new Error(
      "Claude subscription auth не доказан: нужны firstParty + CLAUDE_CODE_OAUTH_TOKEN без apiKeySource",
    );
  }
}

const CLAUDE_SUBSCRIPTION_TYPES = new Set(["pro", "max", "team", "enterprise"]);

/**
 * Prove that this Claude.ai subscription cannot fall through to separately
 * billed usage credits. The control response is intentionally validated
 * fail-closed: an absent/changed/partially unavailable shape is not evidence
 * that overage is disabled.
 *
 * Source shape: Agent SDK 0.3.220
 * `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`.
 */
export function assertClaudeSubscriptionOverageDisabled(value: unknown): void {
  const usage = authRecord(value);
  if (
    typeof usage.subscription_type !== "string" ||
    !CLAUDE_SUBSCRIPTION_TYPES.has(usage.subscription_type) ||
    usage.rate_limits_available !== true
  ) {
    throw new Error(
      "Claude subscription usage preflight не доказал plan rate limits; вызов заблокирован",
    );
  }

  const rateLimits = authRecord(usage.rate_limits);
  const extraUsage = authRecord(rateLimits.extra_usage);
  if (extraUsage.is_enabled !== false) {
    throw new Error(
      "Claude subscription usage credits/overage должны быть явно выключены; вызов заблокирован",
    );
  }
}

/** Validate `claude --setting-sources '' auth status --json`. */
export function assertClaudeCliSubscriptionStatus(value: unknown): void {
  const status = authRecord(value);
  if (
    status.loggedIn !== true ||
    status.authMethod !== "oauth_token" ||
    status.apiProvider !== "firstParty" ||
    (typeof status.apiKeySource === "string" && status.apiKeySource.trim() !== "")
  ) {
    throw new Error(
      "Claude CLI subscription auth не доказан: нужны loggedIn oauth_token + firstParty без apiKeySource",
    );
  }
}

/** Validate the Agent SDK `system/init` message before accepting a result. */
export function assertClaudeSubscriptionInit(value: unknown): void {
  const message = authRecord(value);
  if (
    message.type !== "system" ||
    message.subtype !== "init" ||
    (message.apiKeySource !== "oauth" && message.apiKeySource !== "none")
  ) {
    throw new Error("Claude SDK init не подтвердил apiKeySource=none|oauth");
  }
}
