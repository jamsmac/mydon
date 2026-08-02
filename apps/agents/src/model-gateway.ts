import { spawn } from "node:child_process";

/**
 * Шлюз к языковой модели (шаг дорожной карты #3).
 *
 * Два пути за одной абстракцией `ModelGateway`:
 *  • HTTP (OpenAI-совместимый) — метрируемое API или AI-gateway (OmniRoute).
 *    Меняется только `LLM_BASE_URL`, код агентов — нет.
 *  • CLI (`claude -p`) — ПОДПИСКА через харнесс: промпт идёт STDIN, не shell,
 *    подписка не тарифицируется по токенам. Это «Stage 0» плана мозга.
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
  /** Стоимость в USD, если шлюз её сообщил (напр. OmniRoute). Иначе 0. */
  costUsd: number;
  ok: boolean;
  error?: string;
}

/** Абстракция шлюза — за ней HTTP-провайдер или фейк в тестах. */
export interface ModelGateway {
  call(model: string, req: ModelRequest): Promise<ModelResult>;
}

/**
 * Цепочка моделей: основная (`LLM_MODEL`) + запасные (`LLM_FALLBACK_MODELS`,
 * через запятую). callModel пробует по порядку — первая ответившая даёт ответ.
 * Дубли и пустые отбрасываются; пустая цепочка означает «модель не настроена».
 */
const CLI_PROVIDERS = new Set(["claude-cli", "claude-subscription", "cli"]);

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
  for (const f of (fallbacks ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!chain.includes(f)) chain.push(f);
  }
  // CLI-подписка без явной модели → «default»: харнесс возьмёт модель сам.
  if (chain.length === 0 && isCliProvider(provider)) return ["default"];
  return chain;
}

/** Стоимость из поля usage, если провайдер её вернул. Не выдумываем цену. */
function reportedCost(data: unknown): number {
  const usage = (data as { usage?: Record<string, unknown> })?.usage;
  const raw = usage?.cost_usd ?? usage?.cost ?? (data as { cost?: unknown })?.cost;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * OpenAI-совместимый HTTP-шлюз. Работает с любым сервером, отдающим
 * `POST {baseUrl}/chat/completions` в формате OpenAI (OmniRoute, LM Studio, …).
 */
export class HttpModelGateway implements ModelGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey = "",
    private readonly timeoutMs = 30_000,
  ) {}

  async call(model: string, req: ModelRequest): Promise<ModelResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
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
        return { text: "", model, costUsd: 0, ok: false, error: `шлюз ответил ${res.status}` };
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: unknown } }[];
      };
      const text = data?.choices?.[0]?.message?.content;
      return { text: typeof text === "string" ? text : "", model, costUsd: reportedCost(data), ok: true };
    } catch (err) {
      return { text: "", model, costUsd: 0, ok: false, error: err instanceof Error ? err.message : String(err) };
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
export type CliSpawn = (cmd: string, args: string[], input: string, timeoutMs: number) => Promise<CliRun>;

/**
 * По умолчанию: spawn с промптом через STDIN, а не через shell/argv. Это защита
 * от инъекции команд — недоверенный текст не собирается в командную строку.
 */
function defaultCliSpawn(cmd: string, args: string[], input: string, timeoutMs: number): Promise<CliRun> {
  return new Promise<CliRun>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`таймаут CLI ${cmd}`));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

/**
 * CLI-шлюз: подписочный путь через харнесс `claude -p` (Stage 0 плана мозга).
 * Промпт идёт STDIN, не shell — команда не собирается из недоверенного текста.
 * Подписка не тарифицируется по токенам → `costUsd = 0`. Аутентификация — через
 * окружение (`CLAUDE_CODE_OAUTH_TOKEN`), наш код токенов не трогает.
 */
export class CliModelGateway implements ModelGateway {
  constructor(
    private readonly cmd = "claude",
    private readonly baseArgs: readonly string[] = ["-p"],
    private readonly spawnImpl: CliSpawn = defaultCliSpawn,
    private readonly timeoutMs = 120_000,
  ) {}

  async call(model: string, req: ModelRequest): Promise<ModelResult> {
    const input = [req.system, req.prompt].filter(Boolean).join("\n\n");
    const args = [...this.baseArgs];
    if (model && model !== "default") args.push("--model", model);
    try {
      const run = await this.spawnImpl(this.cmd, args, input, this.timeoutMs);
      if (run.code !== 0) {
        return { text: "", model, costUsd: 0, ok: false, error: `${this.cmd} код ${run.code}: ${run.stderr.slice(0, 200)}` };
      }
      return { text: run.stdout.trim(), model, costUsd: 0, ok: true };
    } catch (err) {
      return { text: "", model, costUsd: 0, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * Шлюз из окружения. `LLM_PROVIDER=claude-cli` → подписочный CLI. Иначе задан
 * `LLM_BASE_URL` → HTTP-шлюз. Ничего не задано → `null`: LLM-путь выключен.
 * Подключение модели — сознательное действие владельца, а не поведение по умолчанию.
 */
export function modelGatewayFromEnv(): ModelGateway | null {
  if (isCliProvider()) return new CliModelGateway();
  const baseUrl = (process.env.LLM_BASE_URL ?? "").trim();
  if (baseUrl) return new HttpModelGateway(baseUrl, (process.env.LLM_API_KEY ?? "").trim());
  return null;
}

/** Строка для стартового лога: включён ли LLM-путь и как. */
export function llmPosture(): string {
  const chain = resolveModelChain();
  if (modelGatewayFromEnv() === null || chain.length === 0) {
    return "LLM-путь выключен — работают детерминированные навыки (LLM_PROVIDER/LLM_BASE_URL не заданы)";
  }
  const via = isCliProvider() ? "подписка (claude -p)" : "HTTP-шлюз";
  return `LLM-путь включён (${via}): цепочка моделей ${chain.join(" → ")}`;
}
