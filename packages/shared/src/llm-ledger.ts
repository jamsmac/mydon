/**
 * Общий денежный протокол LLM.
 *
 * Потребители не считают доступный бюджет сами и не объявляют вызов
 * бесплатным. Они сообщают Core верхние границы токенов, а Core выбирает
 * действующую цену, атомарно резервирует деньги и возвращает reservation id.
 */

export const LLM_LEDGER_CONSUMERS = ["agents", "bot", "cc", "documents", "embeddings"] as const;
export type LlmLedgerConsumer = (typeof LLM_LEDGER_CONSUMERS)[number];

export const LLM_BUDGET_ACTIONS = ["pause", "downgrade", "ask"] as const;
export type LlmBudgetAction = (typeof LLM_BUDGET_ACTIONS)[number];

export const LLM_SETTLEMENT_OUTCOMES = ["success", "provider_error", "unknown"] as const;
export type LlmSettlementOutcome = (typeof LLM_SETTLEMENT_OUTCOMES)[number];

/** Стабильная идентичность пользовательского запроса, заданная сурфейсом. */
export interface LlmCallContext {
  /** Идемпотентный ключ физической попытки провайдера. */
  requestKey: string;
  /** Объединяет основную и fallback-попытки одного действия. */
  traceKey?: string;
  /** Без промптов и ответов: только технические корреляционные поля. */
  metadata?: Record<string, unknown>;
}

/** Верхние границы, по которым Core рассчитывает резерв по своему прайсу. */
export interface LlmReserveRequest extends LlmCallContext {
  consumer: LlmLedgerConsumer;
  feature: string;
  agentName?: string;
  provider: string;
  model: string;
  inputTokenCeiling: number;
  outputTokenCeiling: number;
}

export interface LlmTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  /** Aggregate cache creation из provider usage; сохраняется для аудита. */
  cacheCreationInputTokens?: number;
  /** Anthropic ephemeral 5-minute cache write breakdown. */
  cacheCreation5mInputTokens?: number;
  /** Anthropic ephemeral 1-hour cache write breakdown. */
  cacheCreation1hInputTokens?: number;
  /** Запуски server-side code execution; стоимость оценивает Core. */
  codeExecutionRequests?: number;
}

export interface LlmSettlementRequest {
  outcome: LlmSettlementOutcome;
  usage?: LlmTokenUsage;
  providerRequestId?: string;
  resolvedModel?: string;
  /**
   * Факт для provider_reported; у token-тарифа только lower-bound кандидат
   * при anomaly. Отсутствие не означает нулевую цену.
   */
  providerReportedUsd?: number;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface LlmBudgetSnapshot {
  day: string;
  globalCapUsd: number;
  globalExposureUsd: number;
  remainingUsd: number;
  agentCapUsd?: number;
  agentExposureUsd?: number;
}

export interface LlmReservation {
  id: string;
  requestKey: string;
  day: string;
  reservedUsd: number;
  replay: boolean;
  budget: LlmBudgetSnapshot;
}

/** Порт, который пакеты получают в composition root, не импортируя Core. */
export interface LlmLedger {
  reserve(request: LlmReserveRequest): Promise<LlmReservation>;
  settle(reservationId: string, request: LlmSettlementRequest): Promise<void>;
  /** Сетевой результат неизвестен: резерв нельзя освобождать. */
  fail(
    reservationId: string,
    request: Omit<LlmSettlementRequest, "outcome"> & { outcome?: "provider_error" | "unknown" },
  ): Promise<void>;
  /** Допустимо только до передачи запроса провайдеру. */
  release(reservationId: string, reason: string): Promise<void>;
}

export interface LlmReserveResponse {
  allowed: boolean;
  status: string;
  action: LlmBudgetAction;
  reason?: string;
  /**
   * Такой requestKey уже дошёл до закрытого состояния. Ledger не хранит
   * provider output, поэтому безопасно повторить физический вызов нельзя.
   */
  replayBlocked?: boolean;
  reservation?: Omit<LlmReservation, "budget">;
  budget: LlmBudgetSnapshot;
}

/** Core отказал именно по денежной политике. Платный fallback запрещён. */
export class LlmBudgetDeniedError extends Error {
  readonly code = "llm_budget_denied";

  constructor(
    readonly action: LlmBudgetAction,
    readonly reason: string,
    readonly budget: LlmBudgetSnapshot,
  ) {
    super(reason);
    this.name = "LlmBudgetDeniedError";
  }
}

/** Ledger недоступен или вернул неизвестный контракт. Fail-closed. */
export class LlmLedgerUnavailableError extends Error {
  readonly code = "llm_ledger_unavailable";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LlmLedgerUnavailableError";
  }
}

/**
 * Ledger узнал уже принятую физическую попытку и запретил повторный dispatch.
 * Это не временная сетевая ошибка: task worker должен остановить попытку до
 * явного решения владельца, иначе он будет бесконечно крутить тот же replay.
 */
export class LlmReplayBlockedError extends Error {
  readonly code = "llm_replay_blocked";

  constructor(
    readonly requestKey: string,
    message = `LLM-запрос ${requestKey} уже был принят; повторный provider call запрещён`,
  ) {
    super(message);
    this.name = "LlmReplayBlockedError";
  }
}

export function isLlmLedgerBlockingError(
  error: unknown,
): error is LlmBudgetDeniedError | LlmLedgerUnavailableError | LlmReplayBlockedError {
  return (
    error instanceof LlmBudgetDeniedError ||
    error instanceof LlmLedgerUnavailableError ||
    error instanceof LlmReplayBlockedError
  );
}

export interface CoreLlmLedgerConfig {
  baseUrl: string;
  serviceToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * HTTP-адаптер единственного ledger в Core.
 *
 * Он намеренно не делает автоматических retry: повтор сетевой ошибки settle
 * может быть безопасен благодаря идемпотентности Core, но retry reserve после
 * неизвестного ответа должен оставаться решением вызывающего кода с тем же
 * requestKey, а не скрытым поведением транспорта.
 */
export class CoreLlmLedgerClient implements LlmLedger {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: CoreLlmLedgerConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.timeoutMs = config.timeoutMs ?? 5_000;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async reserve(request: LlmReserveRequest): Promise<LlmReservation> {
    const body = await this.post("/llm-ledger/reservations", request);
    const response = parseReserveResponse(body);
    if (response.replayBlocked) {
      throw new LlmReplayBlockedError(
        request.requestKey,
        response.reason ??
          `LLM-запрос ${request.requestKey} уже закрыт; повторный provider call запрещён`,
      );
    }
    if (!response.allowed || response.reservation === undefined) {
      throw new LlmBudgetDeniedError(
        response.action,
        response.reason ?? "Core не разрешил платный вызов LLM",
        response.budget,
      );
    }
    return { ...response.reservation, budget: response.budget };
  }

  async settle(reservationId: string, request: LlmSettlementRequest): Promise<void> {
    await this.post(
      `/llm-ledger/reservations/${encodeURIComponent(reservationId)}/settle`,
      request,
    );
  }

  async fail(
    reservationId: string,
    request: Omit<LlmSettlementRequest, "outcome"> & { outcome?: "provider_error" | "unknown" },
  ): Promise<void> {
    await this.settle(reservationId, { ...request, outcome: request.outcome ?? "unknown" });
  }

  async release(reservationId: string, reason: string): Promise<void> {
    await this.post(`/llm-ledger/reservations/${encodeURIComponent(reservationId)}/release`, {
      reason,
    });
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.config.serviceToken ? { "x-service-token": this.config.serviceToken } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new LlmLedgerUnavailableError("Не удалось связаться с LLM-ledger в Core", {
        cause,
      });
    }

    const text = await response.text();
    let parsed: unknown = null;
    if (text.trim() !== "") {
      try {
        parsed = JSON.parse(text);
      } catch (cause) {
        throw new LlmLedgerUnavailableError(`LLM-ledger вернул не-JSON (HTTP ${response.status})`, {
          cause,
        });
      }
    }
    if (!response.ok) {
      const reason = errorMessage(parsed) ?? `HTTP ${response.status}`;
      throw new LlmLedgerUnavailableError(`LLM-ledger отказал: ${reason}`);
    }
    return parsed;
  }
}

function parseReserveResponse(value: unknown): LlmReserveResponse {
  if (value === null || typeof value !== "object") {
    throw new LlmLedgerUnavailableError("LLM-ledger вернул пустой ответ reserve");
  }
  const raw = value as Record<string, unknown>;
  const allowed = raw.allowed;
  const status = raw.status;
  const action = raw.action;
  const budget = parseBudget(raw.budget);
  if (
    typeof allowed !== "boolean" ||
    typeof status !== "string" ||
    !isBudgetAction(action) ||
    (raw.replayBlocked !== undefined && typeof raw.replayBlocked !== "boolean")
  ) {
    throw new LlmLedgerUnavailableError("LLM-ledger вернул несовместимый ответ reserve");
  }

  const reservation = raw.reservation === undefined ? undefined : parseReservation(raw.reservation);
  return {
    allowed,
    status,
    action,
    ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
    ...(typeof raw.replayBlocked === "boolean" ? { replayBlocked: raw.replayBlocked } : {}),
    ...(reservation ? { reservation } : {}),
    budget,
  };
}

function parseBudget(value: unknown): LlmBudgetSnapshot {
  if (value === null || typeof value !== "object") {
    throw new LlmLedgerUnavailableError("LLM-ledger не вернул состояние бюджета");
  }
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.day !== "string" ||
    !isNonNegativeNumber(raw.globalCapUsd) ||
    !isNonNegativeNumber(raw.globalExposureUsd) ||
    !isNonNegativeNumber(raw.remainingUsd)
  ) {
    throw new LlmLedgerUnavailableError("LLM-ledger вернул неверное состояние бюджета");
  }
  return {
    day: raw.day,
    globalCapUsd: raw.globalCapUsd,
    globalExposureUsd: raw.globalExposureUsd,
    remainingUsd: raw.remainingUsd,
    ...(isNonNegativeNumber(raw.agentCapUsd) ? { agentCapUsd: raw.agentCapUsd } : {}),
    ...(isNonNegativeNumber(raw.agentExposureUsd)
      ? { agentExposureUsd: raw.agentExposureUsd }
      : {}),
  };
}

function parseReservation(value: unknown): Omit<LlmReservation, "budget"> {
  if (value === null || typeof value !== "object") {
    throw new LlmLedgerUnavailableError("LLM-ledger не вернул reservation");
  }
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== "string" ||
    typeof raw.requestKey !== "string" ||
    typeof raw.day !== "string" ||
    !isNonNegativeNumber(raw.reservedUsd) ||
    typeof raw.replay !== "boolean"
  ) {
    throw new LlmLedgerUnavailableError("LLM-ledger вернул неверный reservation");
  }
  return {
    id: raw.id,
    requestKey: raw.requestKey,
    day: raw.day,
    reservedUsd: raw.reservedUsd,
    replay: raw.replay,
  };
}

function isBudgetAction(value: unknown): value is LlmBudgetAction {
  return typeof value === "string" && (LLM_BUDGET_ACTIONS as readonly string[]).includes(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function errorMessage(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const message = (value as Record<string, unknown>).message;
  if (typeof message === "string") return message;
  if (Array.isArray(message)) {
    const parts = message.filter((item): item is string => typeof item === "string");
    return parts.length > 0 ? parts.join("; ") : null;
  }
  return null;
}

/**
 * Безопасная верхняя граница токенов по UTF-8 байтам плюс протокольный запас.
 * Точная токенизация не нужна для reserve: недооценка опаснее небольшого
 * консервативного остатка, который settle затем заменит фактом.
 */
export function inputTokenCeiling(text: string, protocolOverheadTokens = 2_048): number {
  return new TextEncoder().encode(text).byteLength + protocolOverheadTokens;
}
