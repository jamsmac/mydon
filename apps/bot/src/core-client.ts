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

/** Сотрудник. tgChatId появляется, когда он нажал «Старт» у бота. */
export interface PersonRow {
  id: string;
  name: string;
  role: string | null;
  tgUsername: string | null;
  tgChatId: string | null;
  active: string;
}

export interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  ownerKind: "human" | "agent";
  ownerRef: string | null;
  status: "todo" | "in_progress" | "done" | "cancelled";
  priority: "low" | "normal" | "high" | "urgent";
  due: string | null;
  resultNote: string | null;
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

  obligations(domain: Domain): Promise<{
    domain: Domain;
    totals: unknown[];
    overdue: unknown[];
    /** Сколько просрочек всего — список может быть урезан Core. */
    overdueTotal: number;
    /** true — показаны не все: в отчёте это надо оговорить, а не выдавать за полный. */
    overdueTruncated: boolean;
  }> {
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

  // ── Задачи и сотрудники ───────────────────────────────────────────────────
  // Сотрудник работает с задачами прямо в Telegram: ставить ему пароли и учить
  // веб-панели бессмысленно — Telegram у него уже есть и уже открыт.

  /** Привязка по «Старту»: возвращает сотрудника или отметку, что не нашли. */
  linkTelegram(chatId: string, username: string | null): Promise<PersonRow | { linked: false }> {
    return this.request(`/people/link`, {
      method: "POST",
      body: JSON.stringify({ chatId, ...(username ? { username } : {}) }),
    });
  }

  /** Кто написал: сотрудник или посторонний. */
  personByChat(chatId: string): Promise<PersonRow | { found: false }> {
    return this.request(`/people/by-chat/${encodeURIComponent(chatId)}`);
  }

  /** Открытые задачи исполнителя — то, что он видит по команде «мои задачи». */
  myTasks(ownerKind: "human" | "agent", ownerRef: string): Promise<TaskRow[]> {
    const qs = new URLSearchParams({ ownerKind, ownerRef, open: "1" });
    return this.request<TaskRow[]>(`/tasks?${qs.toString()}`);
  }

  task(id: string): Promise<TaskRow> {
    return this.request<TaskRow>(`/tasks/${id}`);
  }

  setTaskStatus(
    id: string,
    status: "todo" | "in_progress" | "done" | "cancelled",
    actor: string,
    resultNote?: string,
  ): Promise<TaskRow> {
    return this.request<TaskRow>(`/tasks/${id}`, {
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

  /** Кому пора напомнить (срок близко или прошёл, ещё не напоминали). */
  tasksDueSoon(hours = 24): Promise<TaskRow[]> {
    return this.request<TaskRow[]>(`/tasks/due-soon?hours=${hours}`);
  }

  /** Отметка «напомнили» — ставится ПОСЛЕ фактической отправки. */
  markReminded(id: string): Promise<unknown> {
    return this.request(`/tasks/${id}/reminded`, { method: "POST" });
  }

  /** Задачи, о возврате которых исполнителю ещё не сообщили. */
  redoUnnotified(): Promise<TaskRow[]> {
    return this.request<TaskRow[]>("/tasks/redo-unnotified");
  }

  /** Отметка «о переделке сообщили» — ставится ПОСЛЕ фактической отправки. */
  markRedoNotified(id: string): Promise<unknown> {
    return this.request(`/tasks/${id}/redo-notified`, { method: "POST" });
  }

  people(): Promise<PersonRow[]> {
    return this.request<PersonRow[]>("/people");
  }
}
