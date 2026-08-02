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

/** Позиция сводного закупа (§5.5) — как отдаёт Core GET /vending/purchase. */
export interface VendingPurchaseItem {
  product: string;
  need: number;
  buy: number;
  pack: number;
  order: number;
  price: number;
  costRounded: number;
  noPrice: boolean;
  noSales: boolean;
}

/** Сводный закуп: позиции + денежные итоги (§5.4–5.5). */
export interface VendingPurchase {
  items: VendingPurchaseItem[];
  excludedNoSales: VendingPurchaseItem[];
  noPrice: string[];
  totalBuy: number;
  totalOrder: number;
  costExact: number;
  costRounded: number;
  overpay: number;
}

/** Накладная закупа (материализована при одобрении заявки, §5.7). */
export interface VendingOrder {
  id: string;
  approvalId: string;
  status: "approved" | "ordered" | "received" | "cancelled";
  positions: number;
  totalOrder: number;
  costRounded: number;
  createdBy: string | null;
  createdAt: string;
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
    /** Внутренний токен Core: нужен на мутации (approvals, ack, задачи). */
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

  /** Сводный закуп вендинга: что заказать, суммы, что на разбор (§5.4–5.5). */
  vendingPurchase(): Promise<VendingPurchase> {
    return this.request<VendingPurchase>("/vending/purchase");
  }

  /** Записать остатки склада вендинга (инвентаризация, §5.4). Перезапись по товару. */
  setVendingStock(items: { product: string; quantity: number }[]): Promise<{ items: number }> {
    return this.request<{ items: number }>("/vending/stock", {
      method: "POST",
      body: JSON.stringify({ items }),
    });
  }

  /** Накладные закупа (материализованы при одобрении, §5.7). */
  vendingOrders(): Promise<VendingOrder[]> {
    return this.request<VendingOrder[]>("/vending/orders");
  }

  /** Принять накладную на склад: приход += заказанное (§5.7). Пусто → последняя. */
  receiveVendingOrder(orderId?: string): Promise<{
    received: boolean;
    orderId?: string;
    replenished: number;
    units: number;
    reason?: string;
  }> {
    return this.request("/vending/orders/receive", {
      method: "POST",
      body: JSON.stringify(orderId ? { orderId } : {}),
    });
  }

  /** Отправить закуп на утверждение владельцу (§5.7). */
  submitVendingPurchase(createdBy?: string): Promise<{
    submitted: boolean;
    approvalId?: string;
    positions: number;
    costRounded: number;
    reason?: string;
  }> {
    return this.request("/vending/purchase/submit", {
      method: "POST",
      body: JSON.stringify(createdBy ? { createdBy } : {}),
    });
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

  /** Отметить уведомления доставленными — после успешной отправки владельцу. */
  ackNotifications(keys: string[]): Promise<{ acked: number }> {
    return this.request<{ acked: number }>("/rules/ack", {
      method: "POST",
      body: JSON.stringify({ keys }),
    });
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

  /** Автоматы направления — для клавиатуры инкассации. */
  machines(domain = "vendhub"): Promise<{ id: string; name: string }[]> {
    return this.request<{ id: string; name: string }[]>(`/entities?domain=${domain}&type=machine`);
  }

  /** Оператор зафиксировал сбор денег с автомата. */
  createCollection(machineId: string, operatorId: string): Promise<{ id: string; collectedAt: string }> {
    return this.request<{ id: string; collectedAt: string }>("/collections", {
      method: "POST",
      body: JSON.stringify({ machineId, operatorId }),
    });
  }

  people(): Promise<PersonRow[]> {
    return this.request<PersonRow[]>("/people");
  }

  /**
   * Завести карточку реестра. `createdFrom` заполнен → карточка ляжет
   * черновиком на утверждение владельцу (сотрудник заводит, владелец
   * подтверждает — главное правило MYDON).
   */
  createEntity(input: {
    domain: string;
    type: string;
    name: string;
    attrs?: Record<string, unknown>;
    createdFrom: string;
  }): Promise<{ id: string; name: string }> {
    return this.request<{ id: string; name: string }>("/entities", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** Дописать поля карточки (например единицу измерения). */
  updateEntity(id: string, attrs: Record<string, unknown>): Promise<unknown> {
    return this.request(`/entities/${id}`, { method: "PATCH", body: JSON.stringify({ attrs }) });
  }

  /** Склады направления — для клавиатуры инвентаризации. */
  warehouses(domain: Domain = "vendhub"): Promise<EntityRow[]> {
    return this.searchEntities({ domain, type: "warehouse" });
  }

  /** Ингредиенты направления — для выбора при инвентаризации/приходе. */
  ingredients(domain: Domain = "vendhub"): Promise<EntityRow[]> {
    return this.searchEntities({ domain, type: "ingredient" });
  }

  /** Остаток пары «склад × ингредиент» — показать перед вводом факта. */
  stockBalance(
    warehouseId: string,
    ingredientId: string,
  ): Promise<{
    warehouseId: string;
    warehouseName: string;
    ingredientId: string;
    ingredientName: string;
    baseUnit: string | null;
    qty: number | null;
    unconvertible: number;
  }> {
    const qs = new URLSearchParams({ warehouseId, ingredientId });
    return this.request(`/stock/balance?${qs.toString()}`);
  }

  /** Приход сырья: движение на склад. Цена/поставщик — по желанию. */
  addIntake(input: {
    warehouseId: string;
    ingredientId: string;
    qty: number;
    unit: string;
    createdBy?: string;
    unitPrice?: number;
    supplier?: string;
    note?: string;
  }): Promise<{ id: string }> {
    return this.request("/stock/movement", {
      method: "POST",
      body: JSON.stringify({ kind: "intake", ...input }),
    });
  }

  /** Инвентаризация: записать факт пересчёта — сервер сам считает дельту. */
  stocktake(input: {
    warehouseId: string;
    ingredientId: string;
    actual: number;
    unit?: string;
    countedBy?: string;
    note?: string;
  }): Promise<{
    changed: boolean;
    before: number;
    actual: number;
    delta: number;
    unit: string;
    ingredientName: string;
    warehouseName: string;
    movementId: string | null;
  }> {
    return this.request("/stock/stocktake", { method: "POST", body: JSON.stringify(input) });
  }

  /**
   * Загрузить фото и привязать к записи. Идёт multipart (файл нельзя в JSON),
   * поэтому не через общий request: свой fetch с тем же service-token.
   */
  async uploadPhoto(input: {
    ownerType: string;
    ownerId: string;
    bytes: Buffer;
    mime: string | null;
    filename: string;
    createdBy: string;
  }): Promise<{ id: string; url: string }> {
    const form = new FormData();
    form.append("ownerType", input.ownerType);
    form.append("ownerId", input.ownerId);
    form.append("kind", "photo");
    form.append("createdBy", input.createdBy);
    const blob = input.mime
      ? new Blob([new Uint8Array(input.bytes)], { type: input.mime })
      : new Blob([new Uint8Array(input.bytes)]);
    form.append("file", blob, input.filename);
    const res = await fetch(`${this.baseUrl}/attachments`, {
      method: "POST",
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: this.serviceToken ? { "x-service-token": this.serviceToken } : {},
      body: form,
    });
    if (!res.ok) throw new Error(`Core ответил ${res.status} на /attachments`);
    return (await res.json()) as { id: string; url: string };
  }
}
