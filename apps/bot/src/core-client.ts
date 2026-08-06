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
  /** Роли сотрудника: по ним фильтруется меню и проверяются права. */
  roles?: string[];
  tgUsername: string | null;
  tgChatId: string | null;
  active: string;
}

export interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  ownerKind: "human" | "agent";
  /** null при ownerKind='human' — задача свободна, её разбирают из пула. */
  ownerRef: string | null;
  status: "todo" | "in_progress" | "done" | "cancelled";
  priority: "low" | "normal" | "high" | "urgent";
  due: string | null;
  resultNote: string | null;
  /** По какому объекту работа: автомат, точка, склад. */
  entityId: string | null;
}

/** Строка сводки сроков — то же, что отдаёт Core в /maintenance/due. */
export interface MaintenanceDueRow {
  planId: string;
  targetId: string;
  targetName: string;
  kind: string;
  kindLabel: string;
  partKind: string | null;
  partLabel: string | null;
  title: string | null;
  nextDueOn: string | null;
  lastDoneOn: string | null;
  taskLeadDays: number;
  daysLeft: number | null;
  countLeft: number | null;
  status: "ok" | "soon" | "due" | "overdue" | "unknown";
  assigneeId: string | null;
  autoTask: boolean;
}

/**
 * Таймаут загрузки фото. Отдельный от общего: 10 секунд достаточно для JSON,
 * но не для мегабайтного снимка с точки на 3G.
 */
const PHOTO_TIMEOUT_MS = 60_000;

/**
 * Расхождение при пересчёте склада (§5.4): было → стало. delta<0 — недостача
 * (потеря), delta>0 — излишек. value — |delta| × закупочная цена, сум;
 * noPrice — цены нет в прайсе, деньгам тогда доверять нельзя.
 */
export interface VendingStockAdjustment {
  product: string;
  before: number;
  after: number;
  delta: number;
  value: number;
  noPrice: boolean;
}

/** Строка статьи расхода — как её видит бот (Core хранит ещё qty/unitPrice, боту не нужны). */
export interface VendingCashLine {
  label: string;
  amount: number;
}

/** Статья с подытогом — «корзинка», «базар» (может повторяться для разных закупок). */
export interface VendingCashCategory {
  name: string;
  lines: VendingCashLine[];
  subtotal: number;
}

/** Касса закупа (§5.8): получил → статьи → остаток. Снимок, не леджер. */
export interface VendingCashSession {
  id: string;
  receivedAmount: number;
  categories: VendingCashCategory[];
  totalSpent: number;
  remainder: number;
  createdBy: string | null;
  createdAt: string;
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

  // ── Сигналы GLOBERENT для брифинга (перенос PROMACH) ──
  // Берём ровно те поля, что нужны счётчикам briefing.ts, — не полные типы Core.

  /** «К сроку ≤ 7 дней» из финансового свода GLOBERENT. */
  globerentDueSoon(): Promise<{ dueSoonIn: unknown[]; dueSoonOut: unknown[] }> {
    return this.request<{ dueSoonIn: unknown[]; dueSoonOut: unknown[] }>(
      "/finance/summary/globerent",
    );
  }

  /** Договоры купли-продажи: статус, оплата (сум-эквивалент) и провенанс. */
  globerentContracts(): Promise<{ status: string; paidUzs: number; createdFrom: string | null }[]> {
    return this.request<{ status: string; paidUzs: number; createdFrom: string | null }[]>(
      "/contracts?domain=globerent",
    );
  }

  /** Единицы техники: стадия продажи и когда карточку трогали в последний раз. */
  globerentUnits(): Promise<{ salesStage: string | null; updatedAt: string }[]> {
    return this.request<{ salesStage: string | null; updatedAt: string }[]>(
      "/units?domain=globerent",
    );
  }

  /**
   * Записать остатки склада вендинга (инвентаризация, §5.4). Перезапись по
   * товару; `adjustments` — расхождение с предыдущим остатком (недостача при
   * delta<0, излишек при delta>0), пусто — если товар вводится впервые или
   * количество не изменилось.
   */
  setVendingStock(items: { product: string; quantity: number }[]): Promise<{
    items: number;
    adjustments: VendingStockAdjustment[];
  }> {
    return this.request("/vending/stock", {
      method: "POST",
      body: JSON.stringify({ items }),
    });
  }

  /**
   * Записать кассу закупа: получил → статьи → остаток (§5.8). Снимок, а не
   * леджер — одна запись на поход на базар.
   */
  recordVendingCash(
    receivedAmount: number,
    categories: { name: string; amount: number }[],
  ): Promise<VendingCashSession> {
    return this.request<VendingCashSession>("/vending/cash", {
      method: "POST",
      body: JSON.stringify({
        receivedAmount,
        categories: categories.map((c) => ({
          name: c.name,
          lines: [{ label: c.name, amount: c.amount }],
        })),
      }),
    });
  }

  /** Прошлые кассы закупа — свежие сверху (§5.8). */
  vendingCashSessions(): Promise<VendingCashSession[]> {
    return this.request<VendingCashSession[]>("/vending/cash");
  }

  /** Накладные закупа (материализованы при одобрении, §5.7). */
  vendingOrders(): Promise<VendingOrder[]> {
    return this.request<VendingOrder[]>("/vending/orders");
  }

  /**
   * Принять накладную на склад: приход += (заказанное − распределено). Пусто
   * orderId → последняя. `distributed` — сколько сразу ушло в автоматы, минуя
   * склад (§5.7); без него весь order идёт на склад, как раньше.
   */
  receiveVendingOrder(
    orderId?: string,
    distributed?: Record<string, number>,
  ): Promise<{
    received: boolean;
    orderId?: string;
    replenished: number;
    units: number;
    distributedUnits: number;
    unmatchedDistribution: string[];
    reason?: string;
  }> {
    return this.request("/vending/orders/receive", {
      method: "POST",
      body: JSON.stringify({
        ...(orderId ? { orderId } : {}),
        ...(distributed ? { distributed } : {}),
      }),
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
  ): Promise<
    {
      actorKind: "human" | "agent" | "system";
      action: string;
      actorRef: string | null;
      ts: string;
    }[]
  > {
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
  createCollection(
    machineId: string,
    operatorId: string,
  ): Promise<{ id: string; collectedAt: string }> {
    return this.request<{ id: string; collectedAt: string }>("/collections", {
      method: "POST",
      body: JSON.stringify({ machineId, operatorId }),
    });
  }

  people(): Promise<PersonRow[]> {
    return this.request<PersonRow[]>("/people");
  }

  // ── Обслуживание: журнал работ, узлы автоматов ─────────────────────────────

  /**
   * Объекты, где сотрудник работал недавно, — верхний уровень пикера.
   * Закрепления за объектами нет, но маршрут дня повторяется.
   */
  recentObjects(personId: string, limit = 5): Promise<{ id: string; name: string }[]> {
    return this.request(`/maintenance/recent-objects?personId=${personId}&limit=${limit}`);
  }

  /** Записать факт работы. Без outcome — работа начата и не закрыта. */
  createMaintenanceLog(input: {
    entityId: string;
    kind: string;
    partKind?: string;
    /** Норматив, по которому работа сделана: без него срок не сдвинется. */
    planId?: string;
    personId?: string;
    taskId?: string;
    outcome?: "done" | "partial" | "failed";
    note?: string;
    counterValue?: number;
    createdBy?: string;
  }): Promise<{ id: string }> {
    return this.request("/maintenance/log", { method: "POST", body: JSON.stringify(input) });
  }

  /** Замена узла: закрыть старый период и открыть новый одной транзакцией. */
  swapPart(input: {
    machineId: string;
    partKind: string;
    slot?: number;
    newSerial?: string;
    reason?: string;
    personId?: string;
    note?: string;
    createdBy?: string;
  }): Promise<{ log: { id: string }; removed: { serialNumber: string | null } | null }> {
    return this.request("/maintenance/part-swap", { method: "POST", body: JSON.stringify(input) });
  }

  /** Что подходит к сроку. Статус считается на чтении, нигде не хранится. */
  maintenanceDue(): Promise<MaintenanceDueRow[]> {
    return this.request("/maintenance/due");
  }

  /** Свободные задачи — общий пул, из которого разбирают работу. */
  unassignedTasks(): Promise<TaskRow[]> {
    return this.request<TaskRow[]>("/tasks?unassigned=1");
  }

  /**
   * Взять свободную задачу. false — успел другой: это не ошибка, а обычное
   * утро при одном дайджесте на всех.
   */
  async claimTask(id: string, personId: string): Promise<boolean> {
    try {
      await this.request(`/tasks/${id}/claim`, {
        method: "POST",
        body: JSON.stringify({ personId }),
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Погасить приглашение и привязать Telegram. Ошибка — текст для сотрудника:
   * Core уже объяснил, что не так, и придумывать своё сообщение незачем.
   */
  async redeemInvite(code: string, chatId: string): Promise<PersonRow | { error: string }> {
    try {
      return await this.request<PersonRow>("/people/redeem", {
        method: "POST",
        body: JSON.stringify({ code, chatId }),
      });
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Не получилось" };
    }
  }

  /** Выпустить приглашение сотруднику. Код возвращается один раз. */
  issueInvite(
    personId: string,
    roles: string[],
    actor: string,
  ): Promise<{ code: string; expiresAt: string; name: string }> {
    return this.request(`/people/${personId}/invite`, {
      method: "POST",
      body: JSON.stringify({ roles, actor }),
    });
  }

  /** Отозвать доступ: снять привязку, роли и погасить живые приглашения. */
  revokeAccess(personId: string, actor = "owner"): Promise<PersonRow> {
    return this.request<PersonRow>(`/people/${personId}/revoke`, {
      method: "POST",
      body: JSON.stringify({ actor }),
    });
  }

  /** Вернуть свою задачу в общий пул. */
  releaseTask(id: string, personId: string): Promise<unknown> {
    return this.request(`/tasks/${id}/release`, {
      method: "POST",
      body: JSON.stringify({ personId }),
    });
  }

  /** Занять ключ одноразовой рассылки: true ровно один раз. */
  async claimNotification(key: string): Promise<boolean> {
    const r = await this.request<{ claimed: boolean }>("/rules/claim", {
      method: "POST",
      body: JSON.stringify({ key }),
    });
    return r.claimed;
  }

  /** Заявка на ремонт от сотрудника. Свободная — её разберут из общего пула. */
  createTask(input: {
    title: string;
    ownerKind: "human" | "agent";
    entityId?: string;
    description?: string;
    priority?: "low" | "normal" | "high" | "urgent";
    createdBy?: string;
  }): Promise<TaskRow> {
    return this.request<TaskRow>("/tasks", { method: "POST", body: JSON.stringify(input) });
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
    /** В какой момент снято: before | after | plate | counter. */
    stage?: string;
  }): Promise<{ id: string; url: string }> {
    const form = new FormData();
    form.append("ownerType", input.ownerType);
    form.append("ownerId", input.ownerId);
    form.append("kind", "photo");
    form.append("createdBy", input.createdBy);
    if (input.stage) form.append("stage", input.stage);
    const blob = input.mime
      ? new Blob([new Uint8Array(input.bytes)], { type: input.mime })
      : new Blob([new Uint8Array(input.bytes)]);
    form.append("file", blob, input.filename);
    const res = await fetch(`${this.baseUrl}/attachments`, {
      method: "POST",
      // Свой таймаут, а не общий: 10 секунд хватает JSON-запросу, но не
      // мегабайтной фотографии с точки на 3G. По общему таймауту загрузка
      // срывалась бы ровно там, где она особенно нужна.
      signal: AbortSignal.timeout(PHOTO_TIMEOUT_MS),
      headers: this.serviceToken ? { "x-service-token": this.serviceToken } : {},
      body: form,
    });
    if (!res.ok) throw new Error(`Core ответил ${res.status} на /attachments`);
    return (await res.json()) as { id: string; url: string };
  }

  /** Вложения записи: сколько фото «до» и «после» уже приложено к задаче. */
  attachmentsOfOwner(
    ownerType: string,
    ownerId: string,
  ): Promise<{ id: string; kind: string; stage: string | null }[]> {
    return this.request(
      `/attachments?ownerType=${encodeURIComponent(ownerType)}&ownerId=${encodeURIComponent(ownerId)}`,
    );
  }

  // ── Кофе-бункеры: ручные кофемашины, ежедневная заливка/мойка ────────────

  /** Точки с кофемашинами. */
  coffeeLocations(): Promise<{ id: string; name: string; isActive: boolean }[]> {
    return this.request("/coffee/locations");
  }

  /** Позиция бункера 1–8 → допустимые ингредиенты (для подсказки технику при выборе). */
  coffeeBunkerConfig(): Promise<
    { position: number; ingredientId: string; ingredientName: string }[]
  > {
    return this.request("/coffee/bunker-config");
  }

  /** Занести заливку бункера («Ввод данных»). */
  submitCoffeeRefill(input: {
    locationId: string;
    position: number;
    containerNumber?: number;
    ingredientId?: string;
    filledWeight: number;
    measuredBefore?: number;
    packageCount?: number;
    enteredDate: string;
    createdBy?: string;
  }): Promise<{ id: string }> {
    return this.request("/coffee/refill", { method: "POST", body: JSON.stringify(input) });
  }

  /** Отметить мойку/обслуживание бункера или машины целиком. */
  recordCoffeeWash(input: {
    locationId: string;
    position?: number;
    kind?: "wash" | "clean" | "replace" | "service";
    note?: string;
    performedBy?: string;
  }): Promise<{ id: string }> {
    return this.request("/coffee/wash", { method: "POST", body: JSON.stringify(input) });
  }

  /** Возврат набора: строка «позиция. набор. вес» из привычного формата группы. */
  recordContainerReturn(input: {
    position: number;
    containerNumber: number;
    weight: number;
    returnedDate: string;
    locationNote?: string;
    createdBy?: string;
  }): Promise<{ id: string }> {
    return this.request("/coffee/container-return", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** Сводка продаж автоматов — те же цифры, что на дашборде VendHub. */
  salesSummary(): Promise<{
    today: { qty: number; amount: number };
    yesterday: { qty: number; amount: number };
    days30: { qty: number; amount: number };
    lastSaleDt: string | null;
    configured: boolean;
  }> {
    return this.request("/sales/summary");
  }

  /**
   * Кофе-факты для LLM-помощника (порт AssistantCore.coffeeConsumption30d):
   * расход за 30 дней одним объектом — вопросы «сколько кофе ушло?» получают
   * цифры из снимка, а не выдумку.
   */
  async coffeeConsumption30d(): Promise<{
    totalGrams: number;
    totalCost: number | null;
    topLocation: string | null;
  }> {
    const iso = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" });
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 30);
    const rep = await this.coffeeContainerConsumption(iso(fromDate), iso(new Date()));
    return {
      totalGrams: rep.totalGrams,
      totalCost: rep.totalCost,
      topLocation: rep.locations[0]?.locationName ?? null,
    };
  }

  /** Фактический расход по наборам за период (заливка − возврат через тару). */
  coffeeContainerConsumption(
    from: string,
    to: string,
  ): Promise<{
    from: string;
    to: string;
    rows: unknown[];
    locations: {
      locationId: string;
      locationName: string;
      grams: number;
      cost: number | null;
      pairs: number;
      unknownPairs: number;
    }[];
    totalGrams: number;
    totalCost: number | null;
  }> {
    return this.request(`/coffee/container-consumption?from=${from}&to=${to}`);
  }

  /** Расходники точки за день (вода/стаканчики/крышки) — upsert по (точка, дата). */
  recordCoffeeConsumable(input: {
    locationId: string;
    loggedDate: string;
    water?: number;
    cups?: number;
    lids?: number;
    createdBy?: string;
  }): Promise<{ id: string }> {
    return this.request("/coffee/consumables", { method: "POST", body: JSON.stringify(input) });
  }

  /** Последняя запись автора среди заливок/возвратов/расходников («ошибся»). */
  coffeeLastEntry(createdBy: string): Promise<{
    entry: {
      kind: "refill" | "container_return" | "consumable";
      id: string;
      at: string;
      text: string;
    } | null;
  }> {
    return this.request(`/coffee/last-entry?createdBy=${encodeURIComponent(createdBy)}`);
  }

  /**
   * Удалить свою запись журнала (бот «ошибся — исправить»). `personRef` идёт
   * и как actor (в аудит), и как страховка «только свои записи» на стороне Core.
   */
  deleteCoffeeEntry(
    kind: "refill" | "container_return" | "consumable",
    id: string,
    personRef: string,
  ): Promise<{ ok: boolean }> {
    const path =
      kind === "refill"
        ? "refill"
        : kind === "container_return"
          ? "container-return"
          : "consumable";
    const q = `actor=${encodeURIComponent(personRef)}&by=${encodeURIComponent(personRef)}`;
    return this.request(`/coffee/${path}/${id}?${q}`, { method: "DELETE" });
  }

  // ── Кофе-бункеры: чтение для утреннего брифинга (§ мониторинг) ────────────

  /** Недолив по последней заливке каждого (точка, бункер) против эталона. */
  coffeeFillStatus(): Promise<{ status: "ok" | "underfill" | "unknown" }[]> {
    return this.request("/coffee/fill-status");
  }

  /** Сверка факт/ожидание расхода ингредиентов по всем точкам за период. */
  coffeeReconcileAll(
    from: string,
    to: string,
  ): Promise<{ rows: { reconcile: { status: "ok" | "anomaly" | "unknown" } }[] }[]> {
    return this.request(`/coffee/reconcile?from=${from}&to=${to}`);
  }

  /** Планы обслуживания со статусом «пора/не пора». */
  coffeeWashScheduleStatus(): Promise<{ status: "ok" | "overdue" | "unknown" }[]> {
    return this.request("/coffee/wash-schedule");
  }
}
