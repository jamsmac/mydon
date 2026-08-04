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
  ): Promise<{ id: string; title: string; status: string; ownerRef: string | null }[]> {
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
  rememberMemory(source: string, skill: string, signature: string): Promise<unknown> {
    return this.recordEvent({ source, type: `agent.memory:${skill}`, payload: { signature } });
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
    return this.request<{ machines: number; slots: number }>("/vending/ingest", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  /** Отдать собранные продажи в Core (история для прогноза расхода). */
  ingestVendingSales(payload: {
    capturedAt?: string;
    periodStart: string;
    periodEnd: string;
    productSales: { serial: string; product: string; quantity: number }[];
    machineSales: { serial: string; totalAmount: number; totalCount: number }[];
  }): Promise<{ productRows: number; machineRows: number }> {
    return this.request<{ productRows: number; machineRows: number }>("/vending/ingest-sales", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  health(): Promise<{ status: string }> {
    return this.request<{ status: string }>("/health");
  }

  // ── Кофе-бункеры: проактивный мониторинг (порт monitor-stock донора) ──
  // Чистое чтение — коффе-сервис уже считает недолив и расхождение расхода
  // (CC «Сверка», задачи 47/49); монитор здесь только эмитит события по
  // порогам, решение «немедленно или в брифинг» остаётся за правилами (rules.ts).

  /** Недолив по последней заливке каждого (точка, бункер) против эталона. */
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
