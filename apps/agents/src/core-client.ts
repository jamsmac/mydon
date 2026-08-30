import type { EnsureTaskInput, MaintenanceDueRow } from "./maintenance-monitor";
import type {
  AutonomyTier,
  Domain,
  LlmBudgetAction,
  LlmBudgetSnapshot,
  LlmTokenUsage,
} from "@mydon/shared";
import type { ClaimedOutboxDelivery } from "./outbox-dispatcher";
import type { TaskLlmJobKind, TaskLlmWorkflowPlan } from "./task-llm-workflow";

/** Сводка Core — на её основе навыки решают, есть ли повод что-то предлагать. */
export interface AgentsBriefing {
  overdueMoney: number;
  idleMachines: number;
  pendingApprovals: number;
  contractsDueSoon: number;
  contractsBadDate: number;
  overdueTasks: number;
}

/** Просроченная позиция обязательств (форма Core: money_flow). */
export interface OverdueRow {
  id: string;
  amount: string;
  currency: string;
  date: string;
  direction: string;
  status: string;
  counterpartyId?: string | null;
}

export interface AgentsObligations {
  domain: Domain;
  totals: unknown[];
  overdue: OverdueRow[];
  overdueTotal: number;
  overdueTruncated: boolean;
}

export type AgentTaskCheckpointKind = "no_signal" | "proposal";

/** Durable результат чистой фазы навыка, сохранённый до любых effects. */
export interface AgentTaskCheckpoint {
  id: string;
  skill: string;
  kind: AgentTaskCheckpointKind;
  action?: string;
  facts?: Record<string, unknown>;
  next?: string[];
}

export type AgentTaskExecutionStatus = "active" | "ready" | "committed" | "abandoned";

export interface AgentTaskExecution {
  id: string;
  status: AgentTaskExecutionStatus;
  skill: string;
  workflowVersion: number;
  plan: TaskLlmWorkflowPlan;
  planHash: string;
  inputSnapshot?: AgentTaskInputSnapshot;
  checkpoint?: AgentTaskCheckpoint;
}

/** Immutable public retrieval evidence persisted by Core before paid ranking. */
export interface AgentTaskInputSnapshot {
  kind: string;
  payload: Record<string, unknown>;
  hash: string;
}

export interface EnsureAgentTaskInputSnapshotInput {
  agentName: string;
  runId: string;
  executionAttemptId: string;
  kind: string;
  payload: Record<string, unknown>;
}

export interface CheckpointAgentTaskInput {
  agentName: string;
  runId: string;
  executionAttemptId: string;
  skill: string;
  kind: AgentTaskCheckpointKind;
  action?: string;
  facts?: Record<string, unknown>;
  next?: string[];
}

export type AgentTaskCommittedOutcome =
  "no_signal" | "no_change" | "approval_requested" | "executed";

export interface CommitAgentTaskOutcomeInput {
  agentName: string;
  runId: string;
  executionAttemptId: string;
  outcome: AgentTaskCommittedOutcome;
  note: string;
  action?: string;
  facts?: Record<string, unknown>;
  next?: string[];
  tier?: AutonomyTier;
  memorySignature?: string;
  executionDetail?: string;
}

export interface CommitAgentTaskOutcomeResult {
  status: "committed" | "capped" | "blocked";
  approvalId?: string;
  replay?: boolean;
}

/** Durable lease, которым Core отдал agent-task одному worker. */
export interface AgentTaskClaim {
  runId: string;
  /** Не меняется при stale takeover: база idempotency key платных вызовов. */
  executionAttemptId: string;
  generation: number;
  claimedAt: string;
  /** Snapshot hash minted by Core at claim and repeated by /start. */
  taskInputHash?: string;
  /** Atomic claim snapshot; list results are stale after the lease is won. */
  taskInput: { title: string; description?: string; domain?: Domain };
  /** Present after execution /start, including active takeover resume. */
  execution?: AgentTaskExecution;
  /** Есть после crash/takeover: навык нельзя вызывать повторно. */
  checkpoint?: AgentTaskCheckpoint;
}

export type AgentTaskInvocation = "assigned" | "scheduled";

export interface EnsureScheduledAgentTaskInput {
  agentName: string;
  skill: string;
  cron: string;
  scheduledAt: string;
}

export interface EnsureScheduledAgentTaskResult {
  taskId: string;
  clientKey: string;
  scheduledAt: string;
  created: boolean;
  replay: boolean;
}

export interface StartAgentTaskExecutionInput {
  agentName: string;
  runId: string;
  executionAttemptId: string;
  claimedTaskInputHash: string;
  skill: string;
  workflowVersion: number;
  plan: TaskLlmWorkflowPlan;
}

export interface StartAgentTaskExecutionResult {
  started: true;
  replay: boolean;
  execution: AgentTaskExecution;
}

export type TaskLlmJobStatus =
  "waiting_budget" | "ready" | "dispatching" | "succeeded" | "rejected" | "unknown" | "cancelled";

export interface TaskLlmStoredResult {
  kind: "success" | "provider_rejection";
  payload: Record<string, unknown>;
  resultHash: string;
}

export interface EnsureAgentTaskLlmJobInput {
  agentName: string;
  runId: string;
  executionAttemptId: string;
  stepKey: string;
  providerAttemptNo: number;
  kind: TaskLlmJobKind;
  feature: string;
  adapter: string;
  adapterVersion: number;
  endpointProfile: string;
  provider: string;
  model: string;
  inputTokenCeiling: number;
  outputTokenCeiling: number;
  requestPayload: Record<string, unknown>;
}

export interface TaskLlmBudgetDenial {
  action: LlmBudgetAction;
  reason: string;
  budget: LlmBudgetSnapshot;
}

export interface EnsureAgentTaskLlmJobResult {
  jobId: string;
  status: TaskLlmJobStatus;
  operationHash: string;
  result?: TaskLlmStoredResult;
  denial?: TaskLlmBudgetDenial;
}

export interface ClaimAgentTaskLlmDispatchInput {
  agentName: string;
  runId: string;
  executionAttemptId: string;
  dispatchToken: string;
}

export interface ClaimAgentTaskLlmDispatchResult {
  granted: boolean;
  replay: boolean;
  status: TaskLlmJobStatus;
  operationHash: string;
  requestPayload?: Record<string, unknown>;
  result?: TaskLlmStoredResult;
}

export interface TaskLlmCompletionPayload {
  text?: string;
  vector?: number[];
  error?: string;
  statusCode?: number;
  usage?: LlmTokenUsage;
  providerRequestId?: string;
  resolvedModel?: string;
  providerReportedUsd?: number;
}

export interface CompleteAgentTaskLlmJobInput {
  dispatchToken: string;
  outcome: "success" | "provider_rejection" | "unknown";
  result?: TaskLlmCompletionPayload;
}

export interface CompleteAgentTaskLlmJobResult {
  status: TaskLlmJobStatus;
  replay: boolean;
  result?: TaskLlmStoredResult;
}

/** HTTP response from Core was explicit (and therefore not a lost response). */
export class AgentsCoreHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`Core ответил ${status} на ${path}`);
    this.name = "AgentsCoreHttpError";
  }
}

/**
 * Клиент агентов к MYDON Core.
 *
 * Ключевое правило ТЗ (Фаза 5): агенты больше не действуют напрямую —
 * они пишут событие и создают запрос на согласование. Прямых действий нет.
 */
export class AgentsCoreClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 10_000,
    /** Внутренний токен Core: агенты пишут события и меняют задачи. */
    private readonly serviceToken = "",
    /**
     * Таймаут ПРИЁМА данных — отдельно от обычных запросов.
     *
     * Обычный вызов Core отвечает за миллисекунды, и 10 секунд там — здоровая
     * страховка от зависшего соединения. Приём слотов/продаж — другая работа:
     * это одна транзакция на сотни строк, и её длительность растёт с парком и
     * с ценой похода в базу. 24.08.2026 после перевода базы на внешний
     * Postgres по TLS (`verify-full`) приём перестал укладываться в 10 секунд —
     * агент рвал соединение («This operation was aborted»), помечал сбор
     * `failed` с `machines_ok=0` и не запускал ни продажи, ни детектор
     * заливок, ХОТЯ Core транзакцию дописывал. Три часа спустя всё повторялось.
     *
     * Минуты хватает с запасом: приём укладывался в 9–12 секунд ещё до
     * пакетной записи, а с ней — в единицы секунд.
     */
    private readonly ingestTimeoutMs = 60_000,
  ) {}

  private async request<T>(
    path: string,
    init?: RequestInit,
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(this.serviceToken ? { "x-service-token": this.serviceToken } : {}),
          ...(init?.headers ?? {}),
        },
      });
      if (!res.ok) throw new AgentsCoreHttpError(res.status, path);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Запрос на согласование — единственный способ агента что-либо изменить. */
  requestApproval(input: {
    agent: string;
    action: string;
    tier: AutonomyTier;
    payload?: Record<string, unknown>;
    /** Stable logical effect key; Core deduplicates concurrent cron replicas by it. */
    clientKey?: string;
  }): Promise<{ id: string }> {
    return this.request<{ id: string }>("/approvals", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** Событие в шину — факт, что агент отработал. */
  recordEvent(input: {
    source: string;
    type: string;
    payload?: Record<string, unknown>;
    /** Stable logical effect key; Core deduplicates retries by it. */
    clientKey?: string;
  }): Promise<unknown> {
    return this.request("/events", { method: "POST", body: JSON.stringify(input) });
  }

  /** Единицы техники GLOBERENT — поля для монитора инвариантов конвейера. */
  globerentUnits(): Promise<
    { code: string; name: string; status: string; declarationNumber: string | null }[]
  > {
    return this.request("/units?domain=globerent");
  }

  /** Договоры GLOBERENT — статус и оплата для монитора инвариантов. */
  globerentContracts(): Promise<
    {
      id: string;
      contractNo: string;
      status: string;
      totalWithVat: string;
      paidUzs: number;
      createdFrom: string | null;
    }[]
  > {
    return this.request("/contracts?domain=globerent");
  }

  /** Обновить курсы валют из ЦБ РУз — Core сам ходит в cbu.uz (коннектор). */
  refreshFx(): Promise<{ updated: string[]; skipped: { currency: string; reason: string }[] }> {
    return this.request("/finance/fx/refresh", {
      method: "POST",
      body: JSON.stringify({ actorRef: "agent:fx-refresh" }),
    });
  }

  /** Сколько действий (agent.action) агент совершил с момента `since`. */
  async countAgentActions(source: string, since: Date): Promise<number> {
    const qs = new URLSearchParams({ source, type: "agent.action", since: since.toISOString() });
    const { count } = await this.request<{ count: number }>(`/events/count?${qs.toString()}`);
    return count;
  }

  // ── Чтение данных: агент смотрит факты ПЕРЕД тем, как что-то предлагать ──
  // Без этого навык слал бы согласование «в пустоту», приучая владельца
  // одобрять не глядя. Очередь должна оставаться сигналом, а не лентой.

  /** Сводка по системе — есть ли вообще повод для предложения. */
  briefing(): Promise<AgentsBriefing> {
    return this.request<AgentsBriefing>("/registry/briefing");
  }

  /** Обязательства направления: просрочка с суммами и датами. */
  obligations(domain: Domain): Promise<AgentsObligations> {
    return this.request<AgentsObligations>(`/registry/obligations/${domain}`);
  }

  /** Записи реестра (автоматы, контрагенты, договоры). */
  entities(
    params: { domain?: Domain; type?: string; q?: string } = {},
  ): Promise<{ id: string; type: string; name: string; attrs: Record<string, unknown> }[]> {
    const qs = new URLSearchParams();
    if (params.domain) qs.set("domain", params.domain);
    if (params.type) qs.set("type", params.type);
    if (params.q) qs.set("q", params.q);
    const suffix = qs.toString();
    return this.request(`/entities${suffix ? `?${suffix}` : ""}`);
  }

  // ── Настройки агентов: источник истины — база Core, а не файлы образа ──
  // Файлы-паспорта остаются начальным сидом; правки владельца в карточке
  // переживают обновление системы только потому, что живут в базе.

  /** Перенести паспорта-файлы в базу. Идемпотентно: существующих не трогает. */
  seedAgents(agents: unknown[]): Promise<{ seeded: number; skipped: number }> {
    return this.request<{ seeded: number; skipped: number }>("/agents/seed", {
      method: "POST",
      body: JSON.stringify({ agents }),
    });
  }

  /** Настройки агентов из базы — то, что владелец видит и меняет в карточке. */
  listAgents(): Promise<
    {
      name: string;
      business: string;
      status: string;
      description: string | null;
      autonomyDefault: "T0" | "T1" | "T2" | "T3" | "T4";
      skills: unknown;
      schedule: unknown;
      budgetPerDayUsd: string | null;
      budgetOnExceeded: string | null;
      webSources: unknown;
      breakGlass: unknown;
      ideaChannels: unknown;
      archivedAt: string | null;
    }[]
  > {
    return this.request("/agents");
  }

  // ── Задачи агента: владелец может поручить агенту дело, как человеку ───────

  /** Открытые задачи, поставленные этому агенту. */
  myTasks(
    agentName: string,
    invocation: AgentTaskInvocation = "assigned",
  ): Promise<{ id: string; title: string; status: string; ownerRef: string | null }[]> {
    const qs = new URLSearchParams({
      ownerKind: "agent",
      ownerRef: agentName,
      open: "1",
      agentInvocation: invocation,
    });
    return this.request(`/tasks?${qs.toString()}`);
  }

  /** Materialize or exact-replay one planned cron occurrence in Core. */
  ensureScheduledAgentTask(
    input: EnsureScheduledAgentTaskInput,
  ): Promise<EnsureScheduledAgentTaskResult> {
    return this.request("/tasks/agent-schedule/ensure", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /**
   * Атомарно забрать задачу. null означает, что другой worker уже
   * владеет ею; в этом случае до LLM доходить нельзя.
   */
  async claimAgentTask(
    id: string,
    agentName: string,
    invocation: AgentTaskInvocation = "assigned",
  ): Promise<AgentTaskClaim | null> {
    const response = await this.request<
      | { claimed: false }
      | {
          claimed: true;
          runId: string;
          executionAttemptId: string;
          generation: number;
          claimedAt: string;
          taskInputHash?: string;
          taskInput?: { title?: unknown; description?: unknown; domain?: unknown };
          execution?: AgentTaskExecution | null;
          checkpoint?: AgentTaskCheckpoint | null;
        }
    >(`/tasks/${id}/agent-run/claim`, {
      method: "POST",
      body: JSON.stringify({ agentName, invocation }),
    });
    if (!response.claimed) return null;
    const claimedTitle = response.taskInput?.title;
    const claimedDescription = response.taskInput?.description;
    const claimedDomain = response.taskInput?.domain;
    if (
      typeof claimedTitle !== "string" ||
      claimedTitle.trim().length === 0 ||
      claimedTitle.length > 512
    ) {
      throw new Error(`Core claim задачи ${id} не содержит валидный taskInput.title`);
    }
    if (
      claimedDescription !== undefined &&
      (typeof claimedDescription !== "string" || claimedDescription.length > 4000)
    ) {
      throw new Error(`Core claim задачи ${id} содержит невалидный taskInput.description`);
    }
    if (
      claimedDomain !== undefined &&
      (typeof claimedDomain !== "string" ||
        !(["globerent", "vendhub", "personal", "mydon"] as const).includes(claimedDomain as Domain))
    ) {
      throw new Error(`Core claim задачи ${id} содержит невалидный taskInput.domain`);
    }
    return {
      runId: response.runId,
      executionAttemptId: response.executionAttemptId,
      generation: response.generation,
      claimedAt: response.claimedAt,
      taskInput: {
        title: claimedTitle,
        ...(typeof claimedDescription === "string" && claimedDescription.length > 0
          ? { description: claimedDescription }
          : {}),
        ...(claimedDomain !== undefined ? { domain: claimedDomain as Domain } : {}),
      },
      ...(response.taskInputHash ? { taskInputHash: response.taskInputHash } : {}),
      ...(response.execution ? { execution: response.execution } : {}),
      ...(response.checkpoint ? { checkpoint: response.checkpoint } : {}),
    };
  }

  /** Create or exact-resume the immutable workflow execution before provider work. */
  startAgentTaskExecution(
    id: string,
    input: StartAgentTaskExecutionInput,
  ): Promise<StartAgentTaskExecutionResult> {
    return this.request(`/tasks/${id}/agent-run/start`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** Persist or exact-replay public retrieval evidence before a dependent paid call. */
  async ensureAgentTaskInputSnapshot(
    id: string,
    input: EnsureAgentTaskInputSnapshotInput,
  ): Promise<AgentTaskInputSnapshot> {
    const response = await this.request<{
      snapshotted: true;
      replay: boolean;
      snapshot: AgentTaskInputSnapshot;
    }>(`/tasks/${id}/agent-run/input-snapshot`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    return response.snapshot;
  }

  /** Ensure one physical provider attempt and its budget authorization. */
  ensureAgentTaskLlmJob(
    id: string,
    input: EnsureAgentTaskLlmJobInput,
  ): Promise<EnsureAgentTaskLlmJobResult> {
    return this.request(`/tasks/${id}/agent-run/llm-jobs/ensure`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** CAS grant; callers may retry only the same token after a lost response. */
  claimAgentTaskLlmDispatch(
    taskId: string,
    jobId: string,
    input: ClaimAgentTaskLlmDispatchInput,
  ): Promise<ClaimAgentTaskLlmDispatchResult> {
    return this.request(`/tasks/${taskId}/agent-run/llm-jobs/${jobId}/claim-dispatch`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** Late completion is token-fenced, not current-run-fenced. */
  completeAgentTaskLlmJob(
    taskId: string,
    jobId: string,
    input: CompleteAgentTaskLlmJobInput,
  ): Promise<CompleteAgentTaskLlmJobResult> {
    return this.request(`/tasks/${taskId}/agent-run/llm-jobs/${jobId}/complete`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /**
   * Зафиксировать proposal/no-signal под CAS-fence до approval,
   * memory, executor и любого внешнего effect.
   */
  async checkpointAgentTask(
    id: string,
    input: CheckpointAgentTaskInput,
  ): Promise<AgentTaskCheckpoint> {
    const response = await this.request<{
      checkpointed: true;
      replay: boolean;
      checkpoint: AgentTaskCheckpoint;
    }>(`/tasks/${id}/agent-run/checkpoint`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    return response.checkpoint;
  }

  /**
   * Атомарный Core commit: fence + action cap + internal effects +
   * task result + external outbox. Повтор возвращает тот же итог.
   */
  async commitAgentTaskOutcome(
    id: string,
    input: CommitAgentTaskOutcomeInput,
  ): Promise<CommitAgentTaskOutcomeResult> {
    const { outcome, ...fenceAndPayload } = input;
    const response = await this.request<{
      committed: boolean;
      capped: boolean;
      replay: boolean;
      status: "done" | "todo" | "blocked";
      approvalId?: string;
    }>(`/tasks/${id}/agent-run/commit`, {
      method: "POST",
      // Core names the wire field `kind`; `outcome` is the Agents-facing API.
      body: JSON.stringify({ ...fenceAndPayload, kind: outcome }),
    });
    if (response.status === "blocked") {
      return { status: "blocked", replay: response.replay };
    }
    if (response.capped) return { status: "capped", replay: response.replay };
    if (!response.committed) {
      throw new Error(`Core не зафиксировал outcome задачи ${id}`);
    }
    return {
      status: "committed",
      replay: response.replay,
      ...(response.approvalId ? { approvalId: response.approvalId } : {}),
    };
  }

  /** Забрать один durable external-effect intent для отдельного dispatcher. */
  async claimOutbox(destination: string, workerRef: string): Promise<ClaimedOutboxDelivery | null> {
    const response = await this.request<{ delivery: ClaimedOutboxDelivery | null }>(
      "/outbox/claim",
      { method: "POST", body: JSON.stringify({ destination, workerRef }) },
    );
    return response.delivery;
  }

  /** CAS-завершение outbox delivery по lease token; exact retry безопасен. */
  completeOutbox(
    id: string,
    leaseToken: string,
    status: "sent" | "skipped" | "unknown" | "dead",
    options: { providerRef?: string; error?: string } = {},
  ): Promise<unknown> {
    return this.request(`/outbox/${id}/complete`, {
      method: "POST",
      body: JSON.stringify({ leaseToken, status, ...options }),
    });
  }

  /** Вернуть задачу в очередь; false — lease уже перешёл новой generation. */
  async releaseAgentTask(
    id: string,
    agentName: string,
    runId: string,
    executionAttemptId: string,
    reason?:
      | "budget_denied"
      | "execution_unknown"
      | "workflow_changed"
      | "route_unavailable"
      | "unsupported",
    detail?: string,
  ): Promise<boolean> {
    const response = await this.request<{ released: boolean }>(`/tasks/${id}/agent-run/release`, {
      method: "POST",
      body: JSON.stringify({
        agentName,
        runId,
        executionAttemptId,
        ...(reason ? { reason } : {}),
        ...(detail ? { detail } : {}),
      }),
    });
    return response.released;
  }

  /** CAS-heartbeat: false означает, что generation уже перехватил другой worker. */
  async heartbeatAgentTask(id: string, agentName: string, runId: string): Promise<boolean> {
    const response = await this.request<{ renewed: boolean }>(`/tasks/${id}/agent-run/heartbeat`, {
      method: "POST",
      body: JSON.stringify({ agentName, runId }),
    });
    return response.renewed;
  }

  setTaskStatus(
    id: string,
    status: "in_progress" | "done" | "cancelled",
    actor: string,
    resultNote?: string,
    agentRunId?: string,
  ): Promise<unknown> {
    return this.request(`/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        status,
        actor,
        ...(resultNote ? { resultNote } : {}),
        ...(agentRunId ? { agentRunId } : {}),
      }),
    });
  }

  addTaskComment(id: string, body: string, author: string): Promise<unknown> {
    return this.request(`/tasks/${id}/comments`, {
      method: "POST",
      body: JSON.stringify({ body, author }),
    });
  }

  // ── Заметки: артефакт исполнителя ─────────────────────────────────────────
  // Исполнитель навыка оставляет реальный, видимый владельцу след — заметку в
  // Core — и проверяет себя, ПЕРЕЧИТАВ её. Пара «записать → найти» и есть
  // само-проверка из контракта исполнителя.

  /**
   * Создать заметку. Идемпотентно по заголовку: Core делает upsert, поэтому
   * повторный прогон по тому же поводу не плодит дубли, а обновляет запись.
   */
  createNote(input: { title?: string; body: string; tags?: string[] }): Promise<{
    id: string;
    title: string | null;
    body: string;
  }> {
    return this.request("/notes", { method: "POST", body: JSON.stringify(input) });
  }

  /** Найти заметки по тексту — независимая перечитка для само-проверки. */
  findNotes(q: string): Promise<{ id: string; title: string | null; body: string }[]> {
    return this.request(`/notes?q=${encodeURIComponent(q)}`);
  }

  /** События заданного типа (с полезной нагрузкой) — для семантической памяти. */
  listEvents(type: string): Promise<{ payload: unknown }[]> {
    const qs = new URLSearchParams({ type });
    return this.request(`/events?${qs.toString()}`);
  }

  /**
   * Действующие глобальные тумблеры системы (мозг/RAG/пауза/бюджет): база
   * важнее env, env важнее дефолта. Агенты накладывают их на своё окружение,
   * чтобы правки владельца из панели действовали без рестарта.
   */
  systemConfig(): Promise<{ key: string; value: string; source: "db" | "env" | "default" }[]> {
    return this.request("/system/config");
  }

  // ── Дельта-память агента ──────────────────────────────────────────────────
  // Агент помнит СВОЙ прошлый результат по журналу Core (последнее событие
  // agent.memory:<навык>), а не в памяти процесса: иначе после рестарта он
  // «забыл бы» и повторил бы то же самое предложение. Хранится сигнатура
  // прошлого повода — по ней runner решает, изменилось ли что-то.

  /** Сигнатура прошлого результата навыка или null (ещё не было). */
  async recallMemory(source: string, skill: string): Promise<string | null> {
    const qs = new URLSearchParams({ source, type: `agent.memory:${skill}` });
    const { event } = await this.request<{ event: { payload?: unknown } | null }>(
      `/events/latest?${qs.toString()}`,
    );
    const sig = (event?.payload as { signature?: unknown } | undefined)?.signature;
    return typeof sig === "string" ? sig : null;
  }

  /** Запомнить сигнатуру текущего результата навыка (после успешной подачи). */
  rememberMemory(
    source: string,
    skill: string,
    signature: string,
    clientKey?: string,
  ): Promise<unknown> {
    return this.recordEvent({
      source,
      type: `agent.memory:${skill}`,
      payload: { signature },
      ...(clientKey ? { clientKey } : {}),
    });
  }

  /**
   * Последнее действие любого агента (событие agent.action) — что coach судит.
   * Нет действий → null. Источник возвращаем, чтобы coach не судил сам себя.
   */
  async latestAgentAction(): Promise<{ source: string; skill: string; action: string } | null> {
    const qs = new URLSearchParams({ type: "agent.action" });
    const { event } = await this.request<{ event: { source?: string; payload?: unknown } | null }>(
      `/events/latest?${qs.toString()}`,
    );
    if (!event) return null;
    const p = (event.payload ?? {}) as { skill?: unknown; action?: unknown };
    const skill = typeof p.skill === "string" ? p.skill : "";
    if (!skill) return null;
    return {
      source: String(event.source ?? ""),
      skill,
      action: typeof p.action === "string" ? p.action : "",
    };
  }

  // ── Сбор вендинга: коллектор Ourvend кладёт слоты и ведёт журнал запусков ──
  // Коннектор дергает сам коллектор (слой агентов), а факты — планограмма и
  // журнал сбора — живут в Core. Приём закрыт тем же service-token, что и
  // остальные записи агентов.

  /** Открыть запись запуска сбора (status=running). */
  startVendingSync(): Promise<{ id: string }> {
    return this.request<{ id: string }>("/vending/sync/start", { method: "POST", body: "{}" });
  }

  /** Закрыть запись сбора итогом. */
  finishVendingSync(
    id: string,
    input: {
      status: "success" | "partial" | "failed";
      machinesTotal: number;
      machinesOk: number;
      durationMs: number;
      error?: string;
    },
  ): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`/vending/sync/${id}/finish`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** Отдать собранные слоты в Core (upsert планограммы + история). */
  ingestVendingSlots(payload: {
    capturedAt?: string;
    machines: {
      serial: string;
      alias?: string;
      slots: { coilId: string; product: string; capacity: number; quantity: number }[];
    }[];
  }): Promise<{ machines: number; slots: number }> {
    // Длинный таймаут: одна транзакция Core на сотни слотов (см. ingestTimeoutMs).
    return this.request<{ machines: number; slots: number }>(
      "/vending/ingest",
      { method: "POST", body: JSON.stringify(payload) },
      this.ingestTimeoutMs,
    );
  }

  /**
   * Прогнать детектор заливок по свежим снимкам слотов (П4, R-P4-2). Коллектор
   * дергает его сразу после успешного ingestVendingSlots — заливка попадает в
   * журнал в тот же цикл сбора, а не только когда её руками прогонят из панели.
   *
   * Дефолт окна — 2 суток, как `DETECT_DAYS_DEFAULT` в Core: прогон
   * идемпотентен по (автомат, конец окна), а перекрытие подбирает заливки,
   * пропущенные во время простоя сбора.
   */
  detectRefillEvents(days = 2): Promise<{
    machines: number;
    events: number;
    matched: number;
    skipped: { serial: string; reason: string }[];
  }> {
    return this.request<{
      machines: number;
      events: number;
      matched: number;
      skipped: { serial: string; reason: string }[];
    }>(
      "/vending/refill-events/detect",
      { method: "POST", body: JSON.stringify({ days }) },
      // Детектор читает окно снимков по всему парку — та же длинная работа.
      this.ingestTimeoutMs,
    );
  }

  /** Отдать собранные продажи в Core (история для прогноза расхода). */
  ingestVendingSales(payload: {
    capturedAt?: string;
    periodStart: string;
    periodEnd: string;
    productSales: { serial: string; product: string; quantity: number }[];
    machineSales: { serial: string; totalAmount: number; totalCount: number }[];
  }): Promise<{ productRows: number; machineRows: number }> {
    return this.request<{ productRows: number; machineRows: number }>(
      "/vending/ingest-sales",
      { method: "POST", body: JSON.stringify(payload) },
      this.ingestTimeoutMs,
    );
  }

  // ── Учётный снапшот OurVend (П2 плана поглощения mydon-stock) ─────────────

  /** Докуда дотянулся собственный снапшот (вотермарки помашинные). */
  ourvendSnapshotStatus(): Promise<{
    lastSaleDt: string | null;
    lastStockDt: string | null;
    perMachineSale: { machineSerial: string; last: string }[];
  }> {
    return this.request<{
      lastSaleDt: string | null;
      lastStockDt: string | null;
      perMachineSale: { machineSerial: string; last: string }[];
    }>("/ourvend/status");
  }

  /** Отдать пачку дней продаж и/или снимков остатков (перезапись днями). */
  pushOurvendSnapshot(payload: {
    sales?: {
      dt: string;
      machineSerial: string;
      rows: { product: string; qty: number; amount: number }[];
    }[];
    stock?: { dt: string; machineSerial: string; rows: { product: string; qty: number }[] }[];
  }): Promise<{
    saleDays: number;
    saleRows: number;
    stockDays: number;
    stockRows: number;
    quarantined: number;
  }> {
    return this.request<{
      saleDays: number;
      saleRows: number;
      stockDays: number;
      stockRows: number;
      quarantined: number;
    }>(
      "/ourvend/snapshot",
      { method: "POST", body: JSON.stringify(payload) },
      // Та же работа и та же база: пачка суток, каждые — с удалением прежних
      // строк по (день, автомат) и перезаписью. Догон до 14 дней по всему
      // парку в 10 секунд не обязан укладываться ничуть не больше, чем приём
      // слотов, — и обрыв здесь так же молча оставил бы учётный поток без
      // суток, а паритет — без семи зелёных дней.
      this.ingestTimeoutMs,
    );
  }

  health(): Promise<{ status: string }> {
    return this.request<{ status: string }>("/health");
  }

  // ── Кофе-бункеры: проактивный мониторинг (порт monitor-stock донора) ──
  // Чистое чтение — коффе-сервис уже считает недолив и расхождение расхода
  // (CC «Сверка», задачи 47/49); монитор здесь только эмитит события по
  // порогам, решение «немедленно или в брифинг» остаётся за правилами (rules.ts).

  /** Недолив по последней заливке каждого (точка, бункер) против эталона. */
  // ── Обслуживание: сроки и постановка задач ─────────────────────────────────

  /** Что подходит к сроку. Статус считается на чтении, нигде не хранится. */
  maintenanceDue(): Promise<MaintenanceDueRow[]> {
    return this.request("/maintenance/due");
  }

  /**
   * Идемпотентная постановка задачи на день. Повторный прогон монитора
   * в тот же день дубля не создаёт — ставку делает уникальный индекс в БД.
   */
  async ensureTaskForDay(input: EnsureTaskInput): Promise<{ created: boolean; taskId?: string }> {
    const row = await this.request<{ id?: string } | null>("/tasks/ensure-for-day", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return row?.id ? { created: true, taskId: row.id } : { created: false };
  }

  coffeeFillStatus(): Promise<CoffeeFillStatusRow[]> {
    return this.request("/coffee/fill-status");
  }

  /** Сверка факт/ожидание расхода ингредиентов по всем точкам за период. */
  coffeeReconcileAll(from: string, to: string): Promise<CoffeeReconcileGroup[]> {
    return this.request(`/coffee/reconcile?from=${from}&to=${to}`);
  }

  /** Автопривязка точек к карточкам автоматов: только однозначные совпадения. */
  autoLinkCoffeeLocations(): Promise<{ linked: number; ambiguous: string[]; unmatched: string[] }> {
    return this.request("/coffee/location-link/auto", { method: "POST", body: JSON.stringify({}) });
  }
}

export interface CoffeeFillStatusRow {
  locationId: string;
  locationName: string;
  position: number;
  ingredientId: string | null;
  ingredientName: string | null;
  netFillWeight: number | null;
  targetFillWeight: number | null;
  status: "ok" | "underfill" | "unknown";
  fillRatio: number | null;
}

export interface CoffeeReconcileRow {
  ingredientId: string;
  ingredientName: string;
  actualGrams: number | null;
  expectedGrams: number | null;
  costActual: number | null;
  costExpected: number | null;
  reconcile: {
    status: "ok" | "anomaly" | "unknown";
    deltaGrams: number | null;
    deltaRatio: number | null;
  };
}

export interface CoffeeReconcileGroup {
  locationId: string;
  locationName: string;
  rows: CoffeeReconcileRow[];
}
