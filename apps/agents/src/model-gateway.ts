import { requireClaudeSubscriptionEnv, type LlmTokenUsage } from "@mydon/shared";
import { httpBillingMode } from "./llm-ledger";

/**
 * Шлюз к языковой модели (шаг дорожной карты #3).
 *
 * Два пути за одной абстракцией `ModelGateway`:
 *  • HTTP (OpenAI-совместимый) — метрируемое API или AI-gateway (OmniRoute).
 *    Меняется только `LLM_BASE_URL`, код агентов — нет.
 *  • CLI subscription распознаётся, но fail-closed заблокирована:
 *    `claude auth status --json` не сообщает, включены ли платные usage credits.
 *
 * Выключено по умолчанию: не задан ни `LLM_PROVIDER`, ни `LLM_BASE_URL` → шлюза
 * нет → LLM-путь off, агенты работают на детерминированных навыках. Ноль трат,
 * ноль живых зависимостей, пока владелец сознательно не подключит модель.
 */

/** Запрос к модели. */
export interface ModelRequest {
  /** Системная роль (страж инъекций + инструкция навыка). */
  system?: string;
  /** Пользовательский промпт (задача + обёрнутый недоверенный контент). */
  prompt: string;
  /** Потолок токенов ответа. */
  maxTokens?: number;
}

/** Результат вызова модели. */
export interface ModelResult {
  text: string;
  model: string;
  /** Стоимость, которую сообщил сам провайдер. Отсутствие — не ноль. */
  costUsd?: number;
  /** Стандартный usage OpenAI-compatible ответа. */
  usage?: LlmTokenUsage;
  /** id физического ответа провайдера. */
  providerRequestId?: string;
  /** Модель из ответа; может отличаться от запрошенного alias. */
  resolvedModel?: string;
  ok: boolean;
  error?: string;
}

export type ModelBillingMode = "metered" | "subscription" | "local";

/** Абстракция шлюза — за ней HTTP-провайдер или фейк в тестах. */
export interface ModelGateway {
  /** Канонический provider id для прайса Core. */
  readonly provider: string;
  /** HTTP по умолчанию metered; бесплатность всегда явная. */
  readonly billingMode: ModelBillingMode;
  call(model: string, req: ModelRequest): Promise<ModelResult>;
}

/**
 * Цепочка моделей: основная (`LLM_MODEL`) + запасные (`LLM_FALLBACK_MODELS`,
 * через запятую). callModel пробует по порядку — первая ответившая даёт ответ.
 * Дубли и пустые отбрасываются; пустая цепочка означает «модель не настроена».
 */
const CLI_PROVIDERS = new Set(["claude-cli", "claude-subscription"]);
const UNSAFE_SUBSCRIPTION_PROVIDERS = new Set(["codex-cli", "gemini-cli", "cli"]);
const CLI_SUBSCRIPTION_DISABLED_REASON =
  "Claude CLI subscription заблокирована: auth status не доказывает, что usage credits/overage выключены";

/** Провайдер — подписочный CLI-харнесс (claude -p), а не HTTP. */
export function isCliProvider(provider: string | undefined = process.env.LLM_PROVIDER): boolean {
  return CLI_PROVIDERS.has((provider ?? "").trim().toLowerCase());
}

export function resolveModelChain(
  model: string | undefined = process.env.LLM_MODEL,
  fallbacks: string | undefined = process.env.LLM_FALLBACK_MODELS,
  provider: string | undefined = process.env.LLM_PROVIDER,
): string[] {
  const chain: string[] = [];
  const primary = (model ?? "").trim();
  if (primary) chain.push(primary);
  for (const f of (fallbacks ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (!chain.includes(f)) chain.push(f);
  }
  // `provider` остался в сигнатуре для обратной совместимости; CLI
  // больше не может неявно добавить модель в цепочку.
  void provider;
  return chain;
}

/** Стоимость из поля usage, если провайдер её вернул. Не выдумываем цену. */
function reportedCost(data: unknown): number | undefined {
  const usage = (data as { usage?: Record<string, unknown> })?.usage;
  const raw = usage?.cost_usd ?? usage?.cost ?? (data as { cost?: unknown })?.cost;
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

/** OpenAI и совместимые шлюзы используют prompt/completion_tokens. */
function reportedUsage(data: unknown): LlmTokenUsage | undefined {
  const raw = (data as { usage?: Record<string, unknown> })?.usage;
  if (!raw) return undefined;
  const inputTokens = nonNegativeInt(raw.prompt_tokens ?? raw.input_tokens);
  const outputTokens = nonNegativeInt(raw.completion_tokens ?? raw.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cacheReadInputTokens = nonNegativeInt(raw.cache_read_input_tokens);
  const cacheCreationInputTokens = nonNegativeInt(raw.cache_creation_input_tokens);
  const cacheCreation =
    raw.cache_creation !== null && typeof raw.cache_creation === "object"
      ? (raw.cache_creation as Record<string, unknown>)
      : undefined;
  const cacheCreation5mInputTokens = nonNegativeInt(cacheCreation?.ephemeral_5m_input_tokens);
  const cacheCreation1hInputTokens = nonNegativeInt(cacheCreation?.ephemeral_1h_input_tokens);
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(cacheCreation5mInputTokens !== undefined ? { cacheCreation5mInputTokens } : {}),
    ...(cacheCreation1hInputTokens !== undefined ? { cacheCreation1hInputTokens } : {}),
  };
}

/**
 * OpenAI-совместимый HTTP-шлюз. Работает с любым сервером, отдающим
 * `POST {baseUrl}/chat/completions` в формате OpenAI (OmniRoute, LM Studio, …).
 */
export class HttpModelGateway implements ModelGateway {
  constructor(
    private readonly baseUrl: string,
    readonly provider: string,
    private readonly apiKey = "",
    private readonly timeoutMs = 30_000,
    readonly billingMode: ModelBillingMode = "metered",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (billingMode === "metered" && provider.trim() === "") {
      throw new Error("Metered HttpModelGateway требует явный price provider id");
    }
  }

  async call(model: string, req: ModelRequest): Promise<ModelResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            ...(req.system ? [{ role: "system", content: req.system }] : []),
            { role: "user", content: req.prompt },
          ],
          ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        }),
      });
      if (!res.ok) {
        return { text: "", model, ok: false, error: `шлюз ответил ${res.status}` };
      }
      const data = (await res.json()) as {
        id?: unknown;
        model?: unknown;
        usage?: Record<string, unknown>;
        cost?: unknown;
        choices?: { message?: { content?: unknown } }[];
      };
      const text = data?.choices?.[0]?.message?.content;
      const costUsd = reportedCost(data);
      const usage = reportedUsage(data);
      return {
        text: typeof text === "string" ? text : "",
        model,
        ok: true,
        ...(costUsd !== undefined ? { costUsd } : {}),
        ...(usage !== undefined ? { usage } : {}),
        ...(typeof data.id === "string" ? { providerRequestId: data.id } : {}),
        ...(typeof data.model === "string" ? { resolvedModel: data.model } : {}),
      };
    } catch (err) {
      return {
        text: "",
        model,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Итог запуска CLI-харнесса. */
export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Запуск CLI — реальный spawn или фейк в тестах. */
export type CliSpawn = (
  cmd: string,
  args: string[],
  input: string,
  timeoutMs: number,
) => Promise<CliRun>;

/**
 * Подписочный CLI не должен незаметно переключиться на платный API из общего
 * `.env` процесса Agents. Передаём минимальный allowlist окружения с явным
 * OAuth; settings и сохранённую аутентификацию отдельно не считаем доказательством
 * subscription mode.
 */
export function subscriptionCliEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return requireClaudeSubscriptionEnv(source);
}

/**
 * Legacy API surface. Dispatch is intentionally disabled until Claude CLI
 * exposes a structured, pre-turn `extra_usage.is_enabled` check. Keeping the
 * class fail-closed also protects callers that instantiate it directly.
 */
export class CliModelGateway implements ModelGateway {
  readonly billingMode = "subscription" as const;

  get provider(): string {
    return `cli:${this.cmd}`;
  }

  constructor(
    private readonly cmd = "claude",
    _baseArgs: readonly string[] = ["-p"],
    _spawnImpl?: CliSpawn,
    _timeoutMs = 120_000,
    /** Совместимый параметр конструктора; production разрешает только STDIN. */
    _promptVia: "stdin" | "arg" = "stdin",
    /** Совместимый параметр конструктора; production разрешает только `--model`. */
    _modelFlag = "--model",
  ) {}

  async call(model: string, _req: ModelRequest): Promise<ModelResult> {
    // The CLI exposes auth mode but no machine-readable pre-turn overage
    // state. A successful OAuth check therefore cannot prove that the next
    // turn stays inside the subscription instead of paid usage credits.
    return { text: "", model, ok: false, error: CLI_SUBSCRIPTION_DISABLED_REASON };
  }
}

/** Пресет харнесса: как запускать конкретный CLI подписки. */
export interface HarnessPreset {
  cmd: string;
  baseArgs: string[];
  promptVia: "stdin" | "arg";
  modelFlag: string;
}

/** No CLI preset is executable while overage cannot be proven off. */
export function harnessPreset(
  _provider: string | undefined = process.env.LLM_PROVIDER,
): HarnessPreset | null {
  return null;
}

/**
 * Шлюз из окружения. CLI-провайдеры fail-closed заблокированы. Заданный
 * `LLM_BASE_URL` создаёт HTTP-шлюз. Ничего не задано → `null`: LLM-путь выключен.
 * Подключение модели — сознательное действие владельца, а не поведение по умолчанию.
 */
export function modelGatewayFromEnv(): ModelGateway | null {
  const configuredProvider = (process.env.LLM_PROVIDER ?? "").trim().toLowerCase();
  if (UNSAFE_SUBSCRIPTION_PROVIDERS.has(configuredProvider)) {
    throw new Error(
      `LLM_PROVIDER=${configuredProvider} заблокирован: subscription auth mode не доказан, как и безопасный pre-turn billing mode; используйте metered HTTP через Core ledger`,
    );
  }
  if (isCliProvider()) {
    throw new Error(CLI_SUBSCRIPTION_DISABLED_REASON);
  }
  const baseUrl = (process.env.LLM_BASE_URL ?? "").trim();
  if (baseUrl) {
    const billingMode = httpBillingMode(process.env.LLM_HTTP_BILLING_MODE);
    const priceProviderId = (process.env.LLM_PRICE_PROVIDER_ID ?? "").trim();
    if (billingMode === "metered" && !priceProviderId) {
      throw new Error(
        "LLM_PRICE_PROVIDER_ID обязателен для metered HTTP: provider call заблокирован до reserve",
      );
    }
    return new HttpModelGateway(
      baseUrl,
      priceProviderId,
      (process.env.LLM_API_KEY ?? "").trim(),
      30_000,
      billingMode,
    );
  }
  return null;
}

/** Строка для стартового лога: включён ли LLM-путь и как. */
export function llmPosture(): string {
  const configuredProvider = (process.env.LLM_PROVIDER ?? "").trim().toLowerCase();
  if (UNSAFE_SUBSCRIPTION_PROVIDERS.has(configuredProvider)) {
    return `ОШИБКА конфигурации: ${configuredProvider} не имеет доказанного subscription auth mode; вызовы заблокированы`;
  }
  if (isCliProvider(configuredProvider)) {
    return `ОШИБКА конфигурации: ${CLI_SUBSCRIPTION_DISABLED_REASON}`;
  }
  const chain = resolveModelChain();
  if (chain.length === 0) {
    return "LLM-путь выключен — работают детерминированные навыки (LLM_PROVIDER/LLM_BASE_URL не заданы)";
  }
  const baseUrl = (process.env.LLM_BASE_URL ?? "").trim();
  if (!baseUrl) {
    return "LLM-путь выключен — LLM_BASE_URL не задан";
  }
  const billingMode = httpBillingMode(process.env.LLM_HTTP_BILLING_MODE);
  const priceProviderId = (process.env.LLM_PRICE_PROVIDER_ID ?? "").trim();
  if (billingMode === "metered" && !priceProviderId) {
    return "ОШИБКА конфигурации: LLM_PRICE_PROVIDER_ID не задан; metered HTTP-вызовы заблокированы до provider";
  }
  const via =
    billingMode === "local"
      ? "HTTP-шлюз, явно local"
      : `HTTP-шлюз, metered через Core ledger, price provider=${priceProviderId}`;
  return `LLM-путь включён (${via}): цепочка моделей ${chain.join(" → ")}`;
}
