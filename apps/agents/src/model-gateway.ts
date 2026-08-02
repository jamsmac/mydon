/**
 * Шлюз к языковой модели (шаг дорожной карты #3).
 *
 * MYDON не привязывается к одному провайдеру: агенты говорят с моделью по
 * OpenAI-совместимому протоколу (`/chat/completions`). За этим адресом может
 * стоять что угодно — локальная модель, облачный провайдер или AI-gateway
 * (напр. OmniRoute) с маршрутизацией и fallback между провайдерами. Меняется
 * только `LLM_BASE_URL`, код агентов — нет.
 *
 * Выключено по умолчанию: не задан `LLM_BASE_URL` → шлюза нет → LLM-путь off,
 * агенты работают как раньше (детерминированные навыки). Ноль трат, ноль живых
 * зависимостей, пока владелец сознательно не подключит модель.
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
export function resolveModelChain(
  model: string | undefined = process.env.LLM_MODEL,
  fallbacks: string | undefined = process.env.LLM_FALLBACK_MODELS,
): string[] {
  const chain: string[] = [];
  const primary = (model ?? "").trim();
  if (primary) chain.push(primary);
  for (const f of (fallbacks ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!chain.includes(f)) chain.push(f);
  }
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

/**
 * Шлюз из окружения. Не задан `LLM_BASE_URL` → `null`: LLM-путь выключен.
 * Так добавление модели — сознательное действие владельца, а не поведение
 * по умолчанию (то же правило, что и с исполнителями/бюджетом).
 */
export function modelGatewayFromEnv(): ModelGateway | null {
  const baseUrl = (process.env.LLM_BASE_URL ?? "").trim();
  if (!baseUrl) return null;
  return new HttpModelGateway(baseUrl, (process.env.LLM_API_KEY ?? "").trim());
}

/** Строка для стартового лога: включён ли LLM-путь и какие модели в цепочке. */
export function llmPosture(): string {
  const chain = resolveModelChain();
  if (modelGatewayFromEnv() === null || chain.length === 0) {
    return "LLM-путь выключен — работают детерминированные навыки (LLM_BASE_URL/LLM_MODEL не заданы)";
  }
  return `LLM-путь включён: цепочка моделей ${chain.join(" → ")}`;
}
