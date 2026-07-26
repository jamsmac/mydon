import type { AutonomyTier } from "@mydon/shared";

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

  health(): Promise<{ status: string }> {
    return this.request<{ status: string }>("/health");
  }
}
