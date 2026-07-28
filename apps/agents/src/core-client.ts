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
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
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

  health(): Promise<{ status: string }> {
    return this.request<{ status: string }>("/health");
  }
}
