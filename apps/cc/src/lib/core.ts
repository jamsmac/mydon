import "server-only";

/**
 * Клиент MYDON Core для оболочки.
 *
 * Ходит на сервере, внутри docker-сети — наружу Core не открыт.
 * Кэш выключен намеренно: панель показывает состояние дел, а устаревшая
 * сводка про долги хуже, чем её отсутствие.
 */
const BASE = process.env.CORE_API_URL ?? "http://127.0.0.1:3001";

export class CoreUnavailable extends Error {
  constructor(readonly detail: string) {
    super("Core недоступен");
  }
}

async function get<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    throw new CoreUnavailable(err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) throw new CoreUnavailable(`HTTP ${res.status} на ${path}`);
  return (await res.json()) as T;
}

export interface Briefing {
  generatedAt: string;
  tz: string;
  overdueMoney: number;
  idleMachines: number;
  pendingApprovals: number;
  contractsDueSoon: number;
  contractsBadDate?: number;
}

export interface Approval {
  id: string;
  agent: string;
  action: string;
  tier: string;
  decision: "pending" | "approved" | "rejected" | "clarify";
  createdAt: string;
  decidedAt: string | null;
}

export interface Entity {
  id: string;
  /** Направление, которому принадлежит запись (из поиска Core). */
  domain?: string | null;
  type: string;
  name: string;
  externalRef: string | null;
  attrs: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  actorKind: "human" | "agent" | "system";
  actorRef: string | null;
  action: string;
  target: string | null;
  ts: string;
}

export interface Obligations {
  domain: string;
  totals: { direction: "in" | "out"; status: string; count: number; amount: string }[];
  overdue: { id: string; amount: string; currency: string; date: string; status: string }[];
}

/** Настройки агента — то, что владелец видит и меняет в карточке. */
export interface AgentCard {
  id: string;
  name: string;
  business: string;
  status: "active" | "paused" | "draft" | "deprecated";
  description: string | null;
  mission: string | null;
  nonGoals: string[];
  autonomyDefault: "T0" | "T1" | "T2" | "T3" | "T4";
  skills: string[];
  schedule: { cron: string; skill: string }[];
  budgetPerDayUsd: string | null;
  archivedAt: string | null;
  updatedAt: string;
}

/** Запись в Core. Ошибку отдаём словами: её увидит владелец, а не разработчик. */
async function send<T>(path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
      ...(body !== undefined
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });
  } catch (err) {
    throw new CoreUnavailable(err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) {
    // Core объясняет отказ по-человечески (например про неверное расписание) —
    // показываем это объяснение, а не голый код ошибки.
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { message?: unknown };
      const m = body.message;
      if (typeof m === "string") detail = m;
      else if (Array.isArray(m) && m.length > 0) detail = m.map(String).join("; ");
    } catch {
      // тело не JSON — оставляем код
    }
    throw new CoreUnavailable(detail);
  }
  return (await res.json()) as T;
}

/** Задача: одна очередь на людей и агентов. */
export interface Task {
  id: string;
  title: string;
  description: string | null;
  ownerKind: "human" | "agent";
  ownerRef: string | null;
  domain: string | null;
  status: "todo" | "in_progress" | "done" | "cancelled";
  priority: "low" | "normal" | "high" | "urgent";
  due: string | null;
  source: string | null;
  createdBy: string | null;
  resultNote: string | null;
  /** Оценка владельца после «сделано»: excellent / accepted / redo. */
  quality: "excellent" | "accepted" | "redo" | null;
  completedAt: string | null;
  createdAt: string;
}

export interface TaskComment {
  id: string;
  taskId: string;
  authorRef: string;
  body: string;
  createdAt: string;
}

/** Сотрудник. Telegram-привязка появляется после его /start у бота. */
export interface Person {
  id: string;
  name: string;
  role: string | null;
  /** Направление, куда нанят. */
  domain: string | null;
  email: string | null;
  phone: string | null;
  tgUsername: string | null;
  tgChatId: string | null;
  active: string;
  createdAt: string;
}

/** Нагрузка исполнителя — для картины по людям. */
export interface Workload {
  ownerKind: "human" | "agent";
  ownerRef: string | null;
  open: number;
  overdue: number;
  doneLast7d: number;
  excellent: number;
  redo: number;
  doneOnTime: number;
  doneWithDue: number;
}

export const core = {
  briefing: () => get<Briefing>("/registry/briefing"),
  agents: () => get<AgentCard[]>("/agents"),

  // ── Задачи ──
  tasks: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return get<Task[]>(`/tasks${qs ? `?${qs}` : ""}`);
  },
  task: (id: string) => get<Task>(`/tasks/${id}`),
  taskComments: (id: string) => get<TaskComment[]>(`/tasks/${id}/comments`),
  workload: () => get<Workload[]>("/tasks/workload"),
  createTask: (input: Record<string, unknown>) => send<Task>("/tasks", "POST", input),
  rateTask: (id: string, quality: "excellent" | "accepted" | "redo") =>
    send<Task>(`/tasks/${id}/quality`, "POST", { quality }),
  setTaskStatus: (id: string, input: Record<string, unknown>) =>
    send<Task>(`/tasks/${id}`, "PATCH", input),
  addTaskComment: (id: string, input: Record<string, unknown>) =>
    send<TaskComment>(`/tasks/${id}/comments`, "POST", input),

  // ── Сотрудники ──
  people: (all = false) => get<Person[]>(`/people${all ? "?all=1" : ""}`),
  person: (id: string) => get<Person>(`/people/${id}`),
  createPerson: (input: Record<string, unknown>) => send<Person>("/people", "POST", input),
  updatePerson: (id: string, input: Record<string, unknown>) =>
    send<Person>(`/people/${id}`, "PATCH", input),
  agent: (name: string) => get<AgentCard>(`/agents/${encodeURIComponent(name)}`),
  createAgent: (input: Record<string, unknown>) => send<AgentCard>("/agents", "POST", input),
  updateAgent: (name: string, patch: Record<string, unknown>) =>
    send<AgentCard>(`/agents/${encodeURIComponent(name)}`, "PATCH", patch),
  archiveAgent: (name: string) => send<AgentCard>(`/agents/${encodeURIComponent(name)}`, "DELETE"),
  pendingApprovals: () => get<Approval[]>("/approvals/pending"),
  allApprovals: () => get<Approval[]>("/approvals"),
  audit: (limit = 40) => get<AuditEntry[]>(`/audit?limit=${limit}`),
  obligations: (domain: string) => get<Obligations>(`/registry/obligations/${domain}`),
  byType: (domain: string, type: string) => get<Entity[]>(`/registry/${domain}/${type}`),
  search: (q: string, domain?: string) => {
    const p = new URLSearchParams({ q });
    if (domain) p.set("domain", domain);
    return get<Entity[]>(`/entities?${p.toString()}`);
  },
  entitiesOf: (domain: string) => get<Entity[]>(`/entities?domain=${domain}`),
  entitiesOfType: (domain: string, type: string) =>
    get<Entity[]>(`/entities?domain=${domain}&type=${encodeURIComponent(type)}`),
  entity: (id: string) => get<Entity>(`/entities/${id}`),
  updateEntity: (id: string, input: Record<string, unknown>) =>
    send<Entity>(`/entities/${id}`, "PATCH", input),
  /** Сводка реестра: сколько каких записей в каждом направлении. */
  registryOverview: () => get<{ domain: string; type: string; n: number }[]>("/registry/overview"),
};
