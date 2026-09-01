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

export const LLM_SPEND_STATUSES = ["reserved", "settled", "failed", "released", "denied"] as const;
export type LlmSpendStatus = (typeof LLM_SPEND_STATUSES)[number];

export type LlmMonitoringCostBasis =
  "actual" | "lower_bound" | "upper_bound" | "estimate" | "unknown";

/** Secret-free health summary of the durable settlement outbox. */
export interface LlmSettlementOutboxMonitoring {
  available: boolean;
  pendingCount: number;
  retryingCount: number;
  processingCount: number;
  deadCount: number;
  fallbackCount: number;
  exactCount: number;
  oldestPendingAt: string | null;
  nextRetryAt: string | null;
  maxAttempts: number;
}

/**
 * One secret-free settlement-spool incident suitable for an operational
 * alert. The fingerprint is a second SHA-256 over safe file identity metadata;
 * request keys, reservation ids, payloads and filesystem paths never leave the
 * producer-local spool.
 */
export interface LlmSettlementOutboxAlertIncident {
  fingerprint: string;
  producer: string;
  state: "fallback_stuck" | "dead";
  recordKind: "pre_reserve" | "fallback" | "exact" | "corrupt";
  operation: "recover_pre_dispatch" | "settle" | "fail" | "release" | "unknown";
  category: "attempts_exhausted" | "corrupt" | "exact_conflict" | "terminal_close" | null;
  occurredAt: string;
}

/** Availability is explicit so a missing/read-only mount cannot look healthy. */
export interface LlmSettlementOutboxAlertMonitoring {
  available: boolean;
  /** False when a concurrent rename or transient I/O error made the snapshot incomplete. */
  complete: boolean;
  /** Dead files remain unresolved until an operator reconciles/removes them. */
  unresolvedDeadCount: number;
  incidents: LlmSettlementOutboxAlertIncident[];
}

/**
 * Secret-free operational snapshot for the System panel.
 *
 * `knownCostUsd` is the settled amount accounted from provider facts. It may
 * combine exact costs with explicitly marked lower/upper estimates. It
 * deliberately does not substitute a reserve when the provider outcome is
 * unknown. Budget admission continues to use the more conservative
 * `globalExposureUsd`.
 */
export interface LlmLedgerMonitoring {
  generatedAt: string;
  /** Current calendar day in Asia/Tashkent. */
  day: string;
  settlementOutbox: LlmSettlementOutboxMonitoring;
  budget: {
    globalCapUsd: number;
    knownCostUsd: number;
    globalExposureUsd: number;
    /** Reservations that are still open on the current ledger day. */
    reservedUsd: number;
    remainingUsd: number;
    /** Present when the cap is invalid; monitoring and admission fail closed. */
    configError?: string;
  };
  latestCompleted: {
    provider: string;
    consumer: LlmLedgerConsumer;
    feature: string;
    requestedModel: string;
    resolvedModel: string | null;
    status: "settled" | "failed";
    outcome: LlmSettlementOutcome | null;
    costUsd: number | null;
    costBasis: LlmMonitoringCostBasis;
    completedAt: string;
  } | null;
  stuckReservations: {
    thresholdMinutes: number;
    count: number;
    reservedUsd: number;
    oldestReservedAt: string | null;
  };
  failuresToday: {
    count: number;
    providerErrorCount: number;
    unknownCount: number;
    last: {
      failedAt: string;
      provider: string;
      requestedModel: string;
      resolvedModel: string | null;
      outcome: "provider_error" | "unknown";
      /** Fixed safe category, never the stored provider error text. */
      reason: string | null;
    } | null;
  };
  openCircuits: Array<{
    provider: string;
    openedAt: string;
    resetsAt: string;
    /** Fixed safe category, never raw settlement metadata/reason. */
    reason: string | null;
  }>;
  /**
   * Есть ли у выбранной метрируемой модели действующая каталожная цена.
   *
   * Когда LLM включён метрируемым маршрутом, но цены на `provider/model` в
   * каталоге нет, `reserve` fail-closed отклоняет КАЖДЫЙ вызов: LLM «включён»,
   * но молча не работает. Этот блок делает такое состояние видимым в статусе —
   * а не только в отдельных отказах ledger, которые владелец не видит. Поля
   * не-секретны: `provider/model` берутся из белого списка настроек.
   */
  catalogPrice: {
    /** Метрируемый (платный) маршрут включён: LLM_ENABLED=1 и route требует цены. */
    meteredEnabled: boolean;
    provider: string;
    model: string;
    /** false при `meteredEnabled` → все вызовы LLM будут отклонены Core. */
    hasActivePrice: boolean;
  };
}

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

/**
 * Recovery port for a reserve whose HTTP outcome was ambiguous, but whose
 * provider request was definitely not dispatched.
 */
export interface LlmLedgerReserveRecovery {
  recoverPreDispatch(requestKey: string): Promise<void>;
}

export interface LlmReserveResponse {
  allowed: boolean;
  status: LlmSpendStatus;
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
 * Safe public classification for an exact close/recovery operation.
 *
 * It never retains a response body, service token, request payload or the
 * original transport error as `cause`, so consumers may use it for retry/dead
 * routing without leaking ledger secrets into logs or durable records.
 */
export class LlmLedgerCloseError extends LlmLedgerUnavailableError {
  readonly retryable: boolean;
  readonly httpStatus?: number;

  constructor(message: string, retryable: boolean, httpStatus?: number) {
    super(message);
    this.name = "LlmLedgerCloseError";
    this.retryable = retryable;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
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
  /** Exact close retries, including the first attempt. Clamped to 1..5. */
  closeRetryAttempts?: number;
  /** Initial exponential backoff for close retries. Clamped to 0..1000 ms. */
  closeRetryBaseDelayMs?: number;
  /** Test seam for bounded close-retry waits. */
  closeRetryWaitImpl?: (delayMs: number) => Promise<void>;
}

/**
 * HTTP-адаптер единственного ledger в Core.
 *
 * Reserve всегда делает ровно одну HTTP-попытку: после потери ответа нельзя
 * скрыто решать, можно ли вызывающему продолжать provider dispatch. Settle/fail/release,
 * напротив, идемпотентны в Core по exact payload, поэтому их транспорт ограниченно
 * повторяет тот же path и тот же сериализованный JSON.
 */
export class CoreLlmLedgerClient implements LlmLedger, LlmLedgerReserveRecovery {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly closeRetryAttempts: number;
  private readonly closeRetryBaseDelayMs: number;
  private readonly closeRetryWaitImpl: (delayMs: number) => Promise<void>;

  constructor(private readonly config: CoreLlmLedgerConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.timeoutMs = config.timeoutMs ?? 5_000;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.closeRetryAttempts = boundedInteger(config.closeRetryAttempts, 3, 1, 5);
    this.closeRetryBaseDelayMs = boundedInteger(config.closeRetryBaseDelayMs, 100, 0, 1_000);
    this.closeRetryWaitImpl = config.closeRetryWaitImpl ?? wait;
  }

  async reserve(request: LlmReserveRequest): Promise<LlmReservation> {
    const body = await this.postOnce("/llm-ledger/reservations", serializeBody(request));
    const response = parseReserveResponse(body, request.requestKey);
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
    await this.close(
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
    await this.close(`/llm-ledger/reservations/${encodeURIComponent(reservationId)}/release`, {
      reason,
    });
  }

  async recoverPreDispatch(requestKey: string): Promise<void> {
    const response = await this.close("/llm-ledger/reservations/recover-pre-dispatch", {
      requestKey,
    });
    if (!isUnknownRecord(response) || typeof response.status !== "string") {
      throw new LlmLedgerCloseError("LLM-ledger: неверный ответ reserve recovery", true);
    }
    // A missing row is not proof that the original reserve can never commit.
    // Keep the durable marker and retry later instead of acknowledging it.
    if (response.status === "missing") {
      throw new LlmLedgerCloseError("LLM-ledger: reserve ещё не найден для recovery", true);
    }
    if (!LLM_SPEND_STATUSES.includes(response.status as LlmSpendStatus)) {
      throw new LlmLedgerCloseError("LLM-ledger: неизвестный статус reserve recovery", true);
    }
  }

  private async close(path: string, body: unknown): Promise<unknown> {
    // Serialize once so every retry is byte-for-byte the same operation.
    let serializedBody: string;
    try {
      serializedBody = serializeBody(body);
    } catch (error) {
      throw closeError(error, false);
    }
    for (let attempt = 1; attempt <= this.closeRetryAttempts; attempt += 1) {
      try {
        return await this.postOnce(path, serializedBody);
      } catch (error) {
        const exhausted = attempt === this.closeRetryAttempts;
        if (!(error instanceof LlmLedgerRequestError) || !error.retryable || exhausted) {
          throw closeError(error);
        }
        const exponentialBackoffMs = this.closeRetryBaseDelayMs * 2 ** (attempt - 1);
        const delayMs = Math.min(
          Math.max(exponentialBackoffMs, error.retryAfterMs ?? 0),
          MAX_CLOSE_RETRY_DELAY_MS,
        );
        try {
          await this.closeRetryWaitImpl(delayMs);
        } catch {
          throw new LlmLedgerCloseError("LLM-ledger: не удалось дождаться close retry", true);
        }
      }
    }
    throw new LlmLedgerCloseError("LLM-ledger: close retry завершился без ответа", true);
  }

  private async postOnce(path: string, serializedBody: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.config.serviceToken ? { "x-service-token": this.config.serviceToken } : {}),
        },
        body: serializedBody,
        // A consumed/aborted signal cannot be reused by a retry.
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Fetch errors are deliberately not retained as cause: a custom transport
      // may include headers or the request body in its error text.
      throw new LlmLedgerRequestError("Не удалось связаться с LLM-ledger в Core", true);
    }

    const retryAfterMs = retryableHttpStatus(response.status)
      ? parseRetryAfter(response.headers.get("retry-after"))
      : undefined;

    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new LlmLedgerRequestError(
        `Не удалось прочитать ответ LLM-ledger (HTTP ${response.status})`,
        response.ok || retryableHttpStatus(response.status),
        retryAfterMs,
        response.status,
      );
    }
    let parsed: unknown = null;
    if (text.trim() !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new LlmLedgerRequestError(
          `LLM-ledger вернул не-JSON (HTTP ${response.status})`,
          response.ok || retryableHttpStatus(response.status),
          retryAfterMs,
          response.status,
        );
      }
    }
    if (!response.ok) {
      // Do not echo a potentially sensitive proxy/Core body into caller logs.
      throw new LlmLedgerRequestError(
        `LLM-ledger отказал (HTTP ${response.status})`,
        retryableHttpStatus(response.status),
        retryAfterMs,
        response.status,
      );
    }
    return parsed;
  }
}

const MAX_CLOSE_RETRY_DELAY_MS = 2_000;

class LlmLedgerRequestError extends LlmLedgerUnavailableError {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}

function closeError(error: unknown, defaultRetryable = true): LlmLedgerCloseError {
  if (error instanceof LlmLedgerRequestError) {
    // Auth drift is not worth an immediate HTTP hot-loop, but it is recoverable
    // after SERVICE_TOKEN/config repair. Mark it durable-retryable for outbox.
    const durableRetryable =
      error.retryable || error.httpStatus === 401 || error.httpStatus === 403;
    return new LlmLedgerCloseError(error.message, durableRetryable, error.httpStatus);
  }
  if (error instanceof LlmLedgerUnavailableError) {
    return new LlmLedgerCloseError(error.message, defaultRetryable);
  }
  return new LlmLedgerCloseError("LLM-ledger: close operation failed", defaultRetryable);
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function retryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

const HTTP_WEEKDAY = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
const HTTP_WEEKDAY_LONG = "(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)";
const HTTP_MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
const IMF_FIXDATE_PATTERN = new RegExp(
  `^${HTTP_WEEKDAY}, (\\d{2}) (${HTTP_MONTH}) (\\d{4}) (\\d{2}):(\\d{2}):(\\d{2}) GMT$`,
);
const RFC850_DATE_PATTERN = new RegExp(
  `^${HTTP_WEEKDAY_LONG}, (\\d{2})-(${HTTP_MONTH})-(\\d{2}) (\\d{2}):(\\d{2}):(\\d{2}) GMT$`,
);
const ASCTIME_DATE_PATTERN = new RegExp(
  `^${HTTP_WEEKDAY} (${HTTP_MONTH}) ((?:\\d{2})|(?: [1-9])) (\\d{2}):(\\d{2}):(\\d{2}) (\\d{4})$`,
);
const HTTP_MONTH_INDEX: ReadonlyMap<string, number> = new Map([
  ["Jan", 0],
  ["Feb", 1],
  ["Mar", 2],
  ["Apr", 3],
  ["May", 4],
  ["Jun", 5],
  ["Jul", 6],
  ["Aug", 7],
  ["Sep", 8],
  ["Oct", 9],
  ["Nov", 10],
  ["Dec", 11],
]);

function parseRetryAfter(value: string | null, nowMs = Date.now()): number | undefined {
  if (value === null) return undefined;
  const normalized = value.trim();
  if (normalized === "") return undefined;

  if (/^\d+$/.test(normalized)) {
    const seconds = Number(normalized);
    if (!Number.isFinite(seconds)) return undefined;
    return Math.min(seconds * 1_000, Number.MAX_SAFE_INTEGER);
  }

  const imfFixdateMatch = IMF_FIXDATE_PATTERN.exec(normalized);
  const rfc850Match = RFC850_DATE_PATTERN.exec(normalized);
  const asctimeMatch = ASCTIME_DATE_PATTERN.exec(normalized);
  if (imfFixdateMatch === null && rfc850Match === null && asctimeMatch === null) return undefined;

  const timestamp = imfFixdateMatch
    ? parseHttpTimestamp(
        imfFixdateMatch[1],
        imfFixdateMatch[2],
        imfFixdateMatch[3],
        imfFixdateMatch[4],
        imfFixdateMatch[5],
        imfFixdateMatch[6],
      )
    : rfc850Match
      ? parseRfc850Timestamp(rfc850Match, nowMs)
      : parseHttpTimestamp(
          asctimeMatch?.[2],
          asctimeMatch?.[1],
          asctimeMatch?.[6],
          asctimeMatch?.[3],
          asctimeMatch?.[4],
          asctimeMatch?.[5],
        );
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - nowMs);
}

function parseRfc850Timestamp(match: RegExpExecArray, nowMs: number): number {
  const shortYear = Number(match[3]);
  const now = new Date(nowMs);
  let year = Math.floor(now.getUTCFullYear() / 100) * 100 + shortYear;
  let timestamp = parseHttpTimestamp(
    match[1],
    match[2],
    String(year),
    match[4],
    match[5],
    match[6],
  );
  const fiftyYearsAhead = new Date(nowMs);
  fiftyYearsAhead.setUTCFullYear(fiftyYearsAhead.getUTCFullYear() + 50);
  if (timestamp > fiftyYearsAhead.getTime()) {
    year -= 100;
    timestamp = parseHttpTimestamp(match[1], match[2], String(year), match[4], match[5], match[6]);
  }
  return timestamp;
}

function parseHttpTimestamp(
  dayValue: string | undefined,
  monthValue: string | undefined,
  yearValue: string | undefined,
  hourValue: string | undefined,
  minuteValue: string | undefined,
  secondValue: string | undefined,
): number {
  const day = Number(dayValue);
  const month = HTTP_MONTH_INDEX.get(monthValue ?? "");
  const year = Number(yearValue);
  const hour = Number(hourValue);
  const minute = Number(minuteValue);
  const second = Number(secondValue);
  if (
    month === undefined ||
    !Number.isInteger(year) ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 60
  ) {
    return Number.NaN;
  }
  return utcTimestamp(year, month, day, hour, minute, second);
}

function utcTimestamp(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number {
  const ordinarySecond = Math.min(second, 59);
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month, day);
  parsed.setUTCHours(hour, minute, ordinarySecond, 0);
  const timestamp = parsed.getTime();
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month ||
    parsed.getUTCDate() !== day ||
    parsed.getUTCHours() !== hour ||
    parsed.getUTCMinutes() !== minute ||
    parsed.getUTCSeconds() !== ordinarySecond
  ) {
    return Number.NaN;
  }
  // HTTP permits 23:59:60 for a leap second; represent it as the next instant.
  return timestamp + (second === 60 ? 1_000 : 0);
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isInteger(value)) return fallback;
  return Math.min(Math.max(value, minimum), maximum);
}

function serializeBody(body: unknown): string {
  try {
    const serialized = JSON.stringify(body);
    if (serialized === undefined) {
      throw new TypeError("JSON.stringify returned undefined");
    }
    return serialized;
  } catch {
    // A user-supplied toJSON error may contain request data; do not retain it as cause.
    throw new LlmLedgerUnavailableError("LLM-ledger: не удалось сериализовать запрос");
  }
}

async function wait(delayMs: number): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function parseReserveResponse(value: unknown, expectedRequestKey: string): LlmReserveResponse {
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
    !isSpendStatus(status) ||
    !isBudgetAction(action) ||
    (raw.replayBlocked !== undefined && typeof raw.replayBlocked !== "boolean")
  ) {
    throw new LlmLedgerUnavailableError("LLM-ledger вернул несовместимый ответ reserve");
  }

  const reservation = raw.reservation === undefined ? undefined : parseReservation(raw.reservation);
  const replayBlocked = raw.replayBlocked === true;
  const allowedShapeIsValid =
    allowed &&
    status === "reserved" &&
    !replayBlocked &&
    reservation !== undefined &&
    reservation.requestKey === expectedRequestKey &&
    reservation.day === budget.day;
  const deniedShapeIsValid =
    !allowed && reservation === undefined && (replayBlocked || status === "denied");
  if (!allowedShapeIsValid && !deniedShapeIsValid) {
    throw new LlmLedgerUnavailableError("LLM-ledger вернул противоречивый ответ reserve");
  }
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

function isSpendStatus(value: unknown): value is LlmSpendStatus {
  return typeof value === "string" && (LLM_SPEND_STATUSES as readonly string[]).includes(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Безопасная верхняя граница токенов по UTF-8 байтам плюс протокольный запас.
 * Точная токенизация не нужна для reserve: недооценка опаснее небольшого
 * консервативного остатка, который settle затем заменит фактом.
 */
export function inputTokenCeiling(text: string, protocolOverheadTokens = 2_048): number {
  return new TextEncoder().encode(text).byteLength + protocolOverheadTokens;
}
