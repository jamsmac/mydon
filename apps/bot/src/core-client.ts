import type { Domain } from "@mydon/shared";

export interface Briefing {
  generatedAt: string;
  tz: string;
  overdueMoney: number;
  idleMachines: number;
  pendingApprovals: number;
  contractsDueSoon: number;
}

export interface ApprovalRow {
  id: string;
  agent: string;
  action: string;
  tier: string;
  decision: string;
  createdAt: string;
}

export interface EntityRow {
  id: string;
  type: string;
  name: string;
  externalRef: string | null;
  attrs: Record<string, unknown>;
}

export interface PendingNotifications {
  since: string;
  events: number;
  notifications: { ruleId: string; urgency: string; text: string; eventId: string }[];
}

/** Тонкий клиент к MYDON Core. Бот не ходит в БД напрямую — только через API. */
export class CoreClient {
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
      if (!res.ok) {
        throw new Error(`Core ответил ${res.status} на ${path}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  briefing(): Promise<Briefing> {
    return this.request<Briefing>("/registry/briefing");
  }

  pendingApprovals(): Promise<ApprovalRow[]> {
    return this.request<ApprovalRow[]>("/approvals/pending");
  }

  decide(id: string, decision: "approved" | "rejected" | "clarify", actor: string) {
    return this.request(`/approvals/${id}/decide`, {
      method: "POST",
      body: JSON.stringify({ decision, actor }),
    });
  }

  searchEntities(params: { domain?: Domain; type?: string; q?: string }): Promise<EntityRow[]> {
    const qs = new URLSearchParams();
    if (params.domain) qs.set("domain", params.domain);
    if (params.type) qs.set("type", params.type);
    if (params.q) qs.set("q", params.q);
    return this.request<EntityRow[]>(`/entities?${qs.toString()}`);
  }

  obligations(domain: Domain): Promise<{ domain: Domain; totals: unknown[]; overdue: unknown[] }> {
    return this.request(`/registry/obligations/${domain}`);
  }

  /** Последние действия из журнала — память помощника («что было»). */
  recent(
    limit = 10,
  ): Promise<{ actorKind: "human" | "agent" | "system"; action: string; actorRef: string | null; ts: string }[]> {
    return this.request(`/audit?limit=${limit}`);
  }

  /** Уведомления, которые правила сочли срочными, с момента `since` (FR-2). */
  pendingNotifications(since: Date): Promise<PendingNotifications> {
    return this.request<PendingNotifications>(
      `/rules/pending?immediate=1&since=${encodeURIComponent(since.toISOString())}`,
    );
  }
}
