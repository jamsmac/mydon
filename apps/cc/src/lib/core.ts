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
/** Приход товара/сырья из синка mydon-stock. */
export interface PurchaseRow {
  id: string;
  dt: string;
  product: string;
  unit: string | null;
  qty: string;
  unitPrice: string | null;
  total: string | null;
  note: string | null;
  expiryDate: string | null;
}

/** Продажа (дневная позиция) из синка mydon-stock. */
export interface SaleRow {
  id: string;
  dt: string;
  machineSerial: string;
  machineId: string | null;
  machineName: string | null;
  /** Точка (адрес) автомата из карточки — колонка «Точка» в форме. */
  point: string | null;
  product: string;
  qty: string;
  amount: string;
  source: string;
  /** Направление бизнеса (пока vendhub). */
  domain: string;
  /** Валюта суммы (пока UZS). */
  currency: string;
}

/** Инкассация: строка списка с именами автомата и оператора. */
export interface CollectionRow {
  id: string;
  machineId: string;
  machineName: string | null;
  operatorName: string | null;
  collectedAt: string;
  receivedAt: string | null;
  amount: string | null;
  status: "collected" | "received" | "cancelled";
  source: string;
  notes: string | null;
}

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

// ── Сырой слой источников ──
// Строки лежат так, как пришли из чужой системы: те же колонки, тот же порядок,
// значения строками. Поэтому здесь нет типизации полей отчёта — их состав
// диктует источник, а не мы.

/** Снимок отчёта: что и когда сняли. */
export interface RawSnapshotMeta {
  id: string;
  sourceCode: string;
  reportCode: string;
  fetchedAt: string;
  periodFrom: string | null;
  periodTo: string | null;
  account: string | null;
  rowsTotal: number | null;
  columns: string[];
  rows: number;
  importedBy: string | null;
  note: string | null;
}

export type RawFreshnessState = "never" | "stale" | "fresh";

/** Расшифровка кодов одной колонки этой выгрузки. */
export interface RawDecoder {
  /** Номер колонки в текущем снимке. */
  column: number;
  values: Record<string, string>;
  /** Коды, смысл которых не подтверждён: показываем вопросом, а не фактом. */
  unconfirmed: string[];
}

/** Отрезок стоянки автомата на одной точке. */
export interface MachineStay {
  point: string;
  from: string;
  to: string;
  orders: number;
  /** Пересекается с соседним отрезком — значит это не переезд, а путаница. */
  overlaps: boolean;
}

/** История стоянок одного автомата. */
export interface MachineStays {
  serial: string;
  entityId: string | null;
  entityName: string | null;
  stays: MachineStay[];
  moves: number;
}

/** Отрезок, на котором у автомата держалась одна цена товара. */
export interface PricePeriod {
  price: number;
  from: string;
  to: string;
  orders: number;
}

/** Цены одного товара на одном автомате. */
export interface MachineProductPrice {
  serial: string;
  entityId: string | null;
  entityName: string | null;
  product: string;
  productEntityId: string | null;
  productEntityName: string | null;
  price: number | null;
  periods: PricePeriod[];
  changes: number;
  orders: number;
  /** Заказы по другой цене вперемешку с основной — признак подмены кнопки. */
  mismatched: number;
  lastOrderAt: string | null;
}

/** Один автомат в сквозном срезе по товару. */
export interface ProductPriceMachine {
  serial: string;
  entityId: string | null;
  entityName: string | null;
  price: number;
  since: string;
  orders: number;
  lastOrderAt: string;
  active: boolean;
  gap: number;
  ordersSince: number;
  lost: number;
}

/** Цены одного товара по всем автоматам. */
export interface ProductPriceSpread {
  product: string;
  entityId: string | null;
  entityName: string | null;
  reference: number | null;
  referenceSince: string | null;
  machines: ProductPriceMachine[];
  behind: number;
  lost: number;
}

/** Разбор цен по всей выгрузке. */
export interface PriceReview {
  products: ProductPriceSpread[];
  lost: number;
  lastOrderAt: string | null;
  unreadable: number;
}

/** Откуда взялась величина журнала: первоисточник, реестр, наш разбор, сверка. */
export type FieldOrigin = "source" | "registry" | "derived" | "cross";
/** Состояние величины по отношению к сверке. */
export type FieldState = "source" | "unchecked" | "matched" | "mismatch" | "absent";

/** Куда ведёт ссылка «посмотреть первоисточник». */
export interface FieldLink {
  kind: "raw" | "prices" | "goods" | "payments" | "stays" | "card";
  ref?: string;
}

/** Одна величина журнала со своей родословной. */
export interface JournalField {
  label: string;
  value: string | null;
  origin: FieldOrigin;
  state: FieldState;
  note?: string | null;
  link?: FieldLink | null;
}

/** Группа величин в раскрытой строке журнала. */
export interface JournalGroup {
  title: string;
  origin: FieldOrigin;
  subtitle: string;
  fields: JournalField[];
}

/** Одна продажа в журнале. */
export interface JournalOrder {
  idx: number;
  externalId: string;
  ts: string;
  machine: string;
  machineEntityId: string | null;
  machineName: string | null;
  product: string;
  productEntityId: string | null;
  amount: string;
  payment: string;
  paymentLabel: string | null;
  paymentConfirmed: boolean;
  status: string;
  state: FieldState;
  groups: JournalGroup[];
}

/** Страница журнала продаж. */
export interface Journal {
  snapshot: RawSnapshotMeta | null;
  total: number;
  page: number;
  size: number;
  orders: JournalOrder[];
  externalIdColumn: number;
  sourceUrl: string;
  checked: number;
  mismatched: number;
}

/** Месяц одного канала оплаты — строка, с которой идут сверять выписку. */
export interface PaymentMonth {
  month: string;
  orders: number;
  revenue: number;
}

/** Автомат в разрезе одного канала оплаты. */
export interface PaymentMachine {
  serial: string;
  entityId: string | null;
  entityName: string | null;
  orders: number;
  revenue: number;
}

/** Канал оплаты так, как его называет источник. */
export interface PaymentChannel {
  code: string;
  /** Как называет его источник. null — расшифровки нет. */
  label: string | null;
  /** Смысл подтверждён. false — показывать вопросом, а не фактом. */
  confirmed: boolean;
  orders: number;
  revenue: number;
  unreadable: number;
  firstOrderAt: string;
  lastOrderAt: string;
  months: PaymentMonth[];
  machines: PaymentMachine[];
}

/** Срез по каналам оплаты — основание для сверки с платёжными системами. */
export interface PaymentReview {
  channels: PaymentChannel[];
  orders: number;
  revenue: number;
  unconfirmedRevenue: number;
  /** Номер колонки канала в этой выгрузке — для ухода в сами заказы. */
  column: number;
  lastOrderAt: string | null;
}

/** Что мешает выбить чек по карточке: поля нет или оно заполнено неверно. */
export interface FiscalGap {
  field: string;
  flaw: "нет" | "неверно";
  why: string;
}

/** Подсказка «похоже, это тот же напиток под другим именем». */
export interface ProductLookalike {
  name: string;
  /** Основание подсказки — словами и с числами. */
  reason: string;
  entityId: string | null;
  entityName: string | null;
  revenue: number;
  orders: number;
}

/** Товар глазами источника: сколько принёс и можно ли по нему выбить чек. */
export interface SourceProduct {
  name: string;
  orders: number;
  revenue: number;
  unreadable: number;
  firstOrderAt: string;
  lastOrderAt: string;
  entityId: string | null;
  entityName: string | null;
  dismissed: boolean;
  decidedBy: string | null;
  /** Что мешает выбить чек. Пусто — соберётся. */
  gaps: FiscalGap[];
  lookalikes: ProductLookalike[];
}

/** Разбор ассортимента источника. */
export interface ProductReview {
  products: SourceProduct[];
  revenue: number;
  blockedRevenue: number;
  noCard: number;
  incomplete: number;
  lastOrderAt: string | null;
}

/** Состав колонок изменился между двумя последними выгрузками. */
export interface RawDrift {
  prevFetchedAt: string;
  added: string[];
  removed: string[];
  reordered: boolean;
}

export interface RawReportState {
  sourceCode: string;
  reportCode: string;
  title: string;
  ru: string;
  path: string;
  /** Откуда запись: из кода или заведена владельцем. */
  origin: "code" | "owner";
  /** Роли колонок, действующие сейчас. Пусто — состав отчёта ещё не видели. */
  roles: Record<string, unknown>;
  snapshots: number;
  lastFetchedAt: string | null;
  freshness: RawFreshnessState;
  rows: number;
  rowsTotal: number | null;
  columns: number;
}

export interface RawSourceState {
  code: string;
  title: string;
  subtitle: string;
  url: string;
  origin: "code" | "owner";
  connected: boolean;
  reports: RawReportState[];
}

export interface RawMappingValue {
  key: string;
  label: string;
  count: number;
  entityId: string | null;
  entityName: string | null;
  decidedBy: string | null;
  dismissed: boolean;
  /** Карточки, в которые это значение можно записать одним нажатием. */
  targets?: { id: string; name: string }[];
}

export interface RawMappingGroup {
  kind: "machine" | "product" | "point";
  label: string;
  column: string | null;
  bindable: boolean;
  matched: number;
  unmatched: number;
  values: RawMappingValue[];
}

/** Текстовый ответ Core — для выгрузки CSV, который нельзя разбирать как JSON. */
export async function coreText(path: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { cache: "no-store", signal: AbortSignal.timeout(30000) });
  } catch (err) {
    throw new CoreUnavailable(err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) throw new CoreUnavailable(`HTTP ${res.status} на ${path}`);
  return res.text();
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
  createEntity: (input: Record<string, unknown>) => send<Entity>("/entities", "POST", input),
  updateEntity: (id: string, input: Record<string, unknown>) =>
    send<Entity>(`/entities/${id}`, "PATCH", input),
  deleteEntity: (id: string) => send<{ ok: boolean }>(`/entities/${id}`, "DELETE"),
  collections: (params: Record<string, string> = {}) => {
    const q = new URLSearchParams(params).toString();
    return get<CollectionRow[]>(`/collections${q ? `?${q}` : ""}`);
  },
  collectionsSummary: (days = 30) =>
    get<{ pending: number; receivedCount: number; receivedSum: number; days: number }>(
      `/collections/summary?days=${days}`,
    ),
  receiveCollection: (id: string, amount: number) =>
    send<CollectionRow>(`/collections/${id}/receive`, "POST", { amount, manager: "owner" }),
  cancelCollection: (id: string) =>
    send<CollectionRow>(`/collections/${id}/cancel`, "POST", { manager: "owner" }),
  salesSummary: () =>
    get<{
      today: { qty: number; amount: number };
      yesterday: { qty: number; amount: number };
      days30: { qty: number; amount: number };
      lastSaleDt: string | null;
      configured: boolean;
    }>("/sales/summary"),
  sales: (days = 7, limit = 300) => get<SaleRow[]>(`/sales?days=${days}&limit=${limit}`),
  salesSilent: (days = 2) =>
    get<{ machineId: string | null; serial: string; name: string | null; lastDt: string }[]>(
      `/sales/silent?days=${days}`,
    ),
  supplySummary: () =>
    get<{
      purchases30: { count: number; total: number };
      emptyPositions: number;
      lowPositions: number;
      lastStockDt: string | null;
    }>("/supply/summary"),
  purchases: (days = 30, limit = 300) =>
    get<PurchaseRow[]>(`/supply/purchases?days=${days}&limit=${limit}`),
  machineStockLevels: () =>
    get<{ machineSerial: string; machineId: string | null; machineName: string | null; dt: string; product: string; qty: number }[]>(
      "/supply/machine-stock",
    ),
  /** Сводка реестра: сколько каких записей в каждом направлении. */
  registryOverview: () => get<{ domain: string; type: string; n: number }[]>("/registry/overview"),

  // ── Источники (сырой слой) ──
  rawSources: () => get<{ sources: RawSourceState[] }>("/raw/sources"),
  rawRows: (source: string, report: string, params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return get<{
      snapshot: RawSnapshotMeta | null;
      total: number;
      rows: { idx: number; cells: string[] }[];
      page?: number;
      size?: number;
      decoders: RawDecoder[];
      drift?: RawDrift | null;
    }>(`/raw/report/${encodeURIComponent(source)}/${encodeURIComponent(report)}/rows${qs ? `?${qs}` : ""}`);
  },
  rawStays: (source: string, report: string) =>
    get<{ machines: MachineStays[] }>(
      `/raw/stays/${encodeURIComponent(source)}/${encodeURIComponent(report)}`,
    ),
  /**
   * Приём выгрузки. Ключ тот же, что у скрипта: сырой слой не знает, кто принёс
   * строки, и правила приёма у всех одни.
   */
  importRaw: (key: string, input: Record<string, unknown>) =>
    send<{ snapshotId: string; rows: number; total: number }>(
      `/raw/import/${encodeURIComponent(key)}`,
      "POST",
      input,
    ),
  saveRawSource: (input: {
    code: string;
    title: string;
    subtitle?: string;
    url?: string;
    archived?: boolean;
  }) => send<{ ok: true }>("/raw/source", "POST", input),
  saveRawReport: (input: {
    source: string;
    code: string;
    title: string;
    ru?: string;
    path?: string;
    archived?: boolean;
  }) => send<{ ok: true }>("/raw/report", "POST", input),
  setRawRoles: (source: string, report: string, roles: Record<string, string>) =>
    send<{ ok: true }>(
      `/raw/roles/${encodeURIComponent(source)}/${encodeURIComponent(report)}`,
      "POST",
      { roles },
    ),
  rawJournal: (source: string, report: string, params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return get<Journal>(
      `/raw/journal/${encodeURIComponent(source)}/${encodeURIComponent(report)}${qs ? `?${qs}` : ""}`,
    );
  },
  rawPayments: (source: string, report: string) =>
    get<PaymentReview>(`/raw/payments/${encodeURIComponent(source)}/${encodeURIComponent(report)}`),
  rawProducts: (source: string, report: string) =>
    get<ProductReview>(`/raw/products/${encodeURIComponent(source)}/${encodeURIComponent(report)}`),
  rawPrices: (source: string, report: string) =>
    get<PriceReview>(`/raw/prices/${encodeURIComponent(source)}/${encodeURIComponent(report)}`),
  rawMachinePrices: (source: string, report: string, serial: string) =>
    get<{ items: MachineProductPrice[] }>(
      `/raw/prices/${encodeURIComponent(source)}/${encodeURIComponent(report)}/machine/${encodeURIComponent(serial)}`,
    ),
  rawMapping: (source: string, report: string) =>
    get<{ snapshot: RawSnapshotMeta | null; groups: RawMappingGroup[] }>(
      `/raw/mapping/${encodeURIComponent(source)}/${encodeURIComponent(report)}`,
    ),
  rawLink: (input: {
    source: string;
    kind: "machine" | "product" | "point";
    label: string;
    entityId?: string;
    note?: string;
  }) => send<{ ok: true }>("/raw/link", "POST", input),
};
