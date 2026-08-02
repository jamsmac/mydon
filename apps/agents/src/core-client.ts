import type { AutonomyTier, Domain } from "@mydon/shared";

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
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
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
      if (!res.ok) throw new Error(`Core ответил ${res.status} на ${path}`);
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
  }): Promise<unknown> {
    return this.request("/events", { method: "POST", body: JSON.stringify(input) });
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
  entities(params: { domain?: Domain; type?: string; q?: string } = {}): Promise<
    { id: string; type: string; name: string; attrs: Record<string, unknown> }[]
  > {
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
      archivedAt: string | null;
    }[]
  > {
    return this.request("/agents");
  }

  // ── Задачи агента: владелец может поручить агенту дело, как человеку ───────

  /** Открытые задачи, поставленные этому агенту. */
  myTasks(agentName: string): Promise<
    { id: string; title: string; status: string; ownerRef: string | null }[]
  > {
    const qs = new URLSearchParams({ ownerKind: "agent", ownerRef: agentName, open: "1" });
    return this.request(`/tasks?${qs.toString()}`);
  }

  setTaskStatus(
    id: string,
    status: "in_progress" | "done" | "cancelled",
    actor: string,
    resultNote?: string,
  ): Promise<unknown> {
    return this.request(`/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status, actor, ...(resultNote ? { resultNote } : {}) }),
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

  health(): Promise<{ status: string }> {
    return this.request<{ status: string }>("/health");
  }
}
