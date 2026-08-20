import "server-only";

/**
 * Клиент MYDON Core для оболочки.
 *
 * Ходит на сервере, внутри docker-сети — наружу Core не открыт.
 * Кэш выключен намеренно: панель показывает состояние дел, а устаревшая
 * сводка про долги хуже, чем её отсутствие.
 */
const BASE = process.env.CORE_API_URL ?? "http://127.0.0.1:3001";
/** Внутренний токен Core: панель ходит на сервере, ключ наружу не уходит. */
const SERVICE_TOKEN = process.env.SERVICE_TOKEN ?? "";

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

/** Автомат с дефицитом и статусом планограммы (вендинг). */
/** Карточка автомата: вид и состояние. */
export interface MachineCard {
  entityId: string;
  kind: string;
  status: string;
  statusNote: string | null;
  statusChangedAt: string | null;
  note: string | null;
  createdBy: string | null;
  updatedBy: string | null;
}

export interface VendingMachine {
  serial: string;
  status: "ok" | "no_slots" | "uncalibrated";
  deficit: number;
  capacity: number;
  filled: number;
  fillRate: number;
  slots: number;
}

/** Сводная потребность по товару с разбивкой по автоматам. */
export interface VendingNeed {
  product: string;
  total: number;
  perMachine: Record<string, number>;
}

/** Прогноз «на сколько хватит» по товару (§5.6). */
export interface VendingRunout {
  product: string;
  inMachines: number;
  daily: number;
  /** Дней до нуля; null (из Infinity) — если продаж нет. */
  daysLeft: number | null;
}

/** Позиция сводного закупа (§5.5). */
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
  /** Заполнены только после приёмки — до неё null. */
  distributedUnits: number | null;
  unmatchedDistribution: string[] | null;
}

/** Запуск сбора Ourvend — когда собирали и с каким итогом. */
export interface VendingSyncRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "success" | "partial" | "failed";
  machinesTotal: number;
  machinesOk: number;
  error: string | null;
  durationMs: number | null;
}

/**
 * Заливка снек/дринк-автомата: ПОСТРОЧНАЯ запись (один слот). У журнала нет
 * готовой группировки «точка → позиции → веса» — это склеивает вкладка
 * «Обслуживание» по (machineSerial, performedAt) по разрыву 15 минут между
 * соседними строками, а не по минуте, см. `service-tab.tsx` (Task 9, ревью
 * Task 8, ревью Task 9 находка 1).
 */
export interface VendingRefillRow {
  id: string;
  machineId: string | null;
  machineSerial: string;
  coilId: string | null;
  productId: string | null;
  productName: string;
  qty: number;
  personId: string | null;
  taskId: string | null;
  performedAt: string;
  clientKey: string;
  source: string;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
}

// ── Кофе-бункеры: ручные кофемашины, ежедневная заливка/мойка ────────────

export interface CoffeeLocation {
  id: string;
  name: string;
  isActive: boolean;
  /**
   * ПЕРВЫЙ аппарат на месте — оставлен ради экранов, которые знают про один.
   * Полный состав — в `machines`: на точке может стоять несколько аппаратов.
   */
  entityId: string | null;
  machineName: string | null;
  machineRef: string | null;
  /** Все аппараты, стоящие здесь сейчас (открытый период размещения). */
  machines: { entityId: string; name: string; ref: string | null }[];
  /**
   * На месте стоит хотя бы один аппарат в эксплуатации. Следствие состояния
   * техники, в отличие от ручного `isActive`: аппарат увезли на склад или в
   * ремонт — заливать на точке нечего, и в списке оператора её быть не должно.
   */
  operational: boolean;
}

/** Автомат реестра — кандидат привязки кофе-точки. */
export interface CoffeeMachineCandidate {
  entityId: string;
  name: string;
  ref: string | null;
  point: string | null;
}

export interface CoffeeBunkerIngredient {
  position: number;
  ingredientId: string;
  ingredientName: string;
  /** Закупочная цена за грамм, сум. null — не заведена, себестоимость расхода не считается. */
  purchasePrice: number | null;
  /** Эталонный чистый вес заливки, г. null — не задан, недолив не проверяется. */
  targetFillWeight: number | null;
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
  reconcile: { status: "ok" | "anomaly" | "unknown"; deltaGrams: number | null; deltaRatio: number | null };
}

export interface CoffeeLocationReconcileGroup {
  locationId: string;
  locationName: string;
  rows: CoffeeReconcileRow[];
}

export interface CoffeeWashScheduleRow {
  id: string;
  locationId: string;
  locationName: string;
  position: number | null;
  frequencyDays: number | null;
  frequencyCups: number | null;
  isActive: boolean;
  notes: string | null;
}

export interface CoffeeWashScheduleStatusRow extends CoffeeWashScheduleRow {
  lastWashAt: string | null;
  daysSinceWash: number | null;
  cupsSinceWash: number | null;
  nextDueAt: string | null;
  status: "ok" | "overdue" | "unknown";
}

export interface CoffeeStockLevelRow {
  ingredientId: string;
  ingredientName: string;
  quantity: number;
  countedAt: string;
}

export interface CoffeeTareCell {
  containerNumber: number;
  position: number;
  tareWeight: number | null;
}

export interface CoffeeRefillRow {
  id: string;
  locationId: string;
  locationName: string;
  position: number;
  containerNumber: number | null;
  ingredientId: string | null;
  filledWeight: number;
  measuredBefore: number | null;
  packageCount: number;
  enteredDate: string;
  createdBy: string | null;
  createdAt: string;
}

export interface CoffeeBunkerCell {
  packageCount: number;
  weight: number;
}

export interface CoffeeLocationSummaryRow {
  location: string;
  byPosition: Record<number, CoffeeBunkerCell>;
}

export interface CoffeeConsumableRow {
  location: string;
  water: number;
  cups: number;
  lids: number;
}

/** Возврат набора: брутто с весов, нетто — минус эталонная тара (null без калибровки). */
export interface CoffeeContainerReturnRow {
  id: string;
  position: number;
  containerNumber: number;
  weight: number;
  netWeight: number | null;
  returnedDate: string;
  locationNote: string | null;
  createdBy: string | null;
}

/** Расход по наборам: сводка точки за период (заливка − возврат через тару). */
export interface CoffeeContainerConsumptionLocation {
  locationId: string;
  locationName: string;
  grams: number;
  /** Себестоимость; null — цены ингредиентов не заведены. */
  cost: number | null;
  pairs: number;
  unknownPairs: number;
}

export interface CoffeeContainerConsumptionReport {
  from: string;
  to: string;
  rows: {
    containerNumber: number;
    position: number;
    locationId: string;
    locationName: string;
    fillDate: string;
    returnDate: string;
    fillNet: number | null;
    returnNet: number | null;
    consumedGrams: number | null;
    ingredient: string | null;
  }[];
  locations: CoffeeContainerConsumptionLocation[];
  totalGrams: number;
  totalCost: number | null;
}

/** Период размещения аппарата на точке. endDate=null — стоит сейчас. */
export interface CoffeePlacementRow {
  id: string;
  locationId: string;
  locationName: string;
  entityId: string;
  machineName: string;
  machineRef: string | null;
  /** null — «с неизвестной даты» (бэкфилл существовавших привязок). */
  startDate: string | null;
  endDate: string | null;
  note: string | null;
}

export interface CoffeeWashRow {
  id: string;
  locationId: string;
  locationName: string;
  position: number | null;
  kind: "wash" | "clean" | "replace" | "service";
  note: string | null;
  performedBy: string | null;
  performedAt: string;
}

/** Действующий глобальный тумблер системы (мозг/RAG/пауза/бюджет). */
export interface SystemConfigItem {
  key: string;
  label: string;
  kind: "select" | "text" | "number" | "bool";
  options?: string[];
  placeholder?: string;
  help?: string;
  value: string;
  /** Откуда взято действующее значение: панель (db) / окружение / дефолт. */
  source: "db" | "env" | "default";
}

export interface Approval {
  id: string;
  agent: string;
  action: string;
  tier: string;
  decision: "pending" | "approved" | "rejected" | "clarify";
  createdAt: string;
  decidedAt: string | null;
  /** Что именно предлагается сделать — сырой payload запроса (Core отдаёт всегда). */
  payload?: Record<string, unknown> | null;
}

export interface Entity {
  id: string;
  /** Направление, которому принадлежит запись (из поиска Core). */
  domain?: string | null;
  type: string;
  name: string;
  externalRef: string | null;
  attrs: Record<string, unknown>;
  /**
   * Карточка утверждена владельцем. null — заведена не им и ждёт его слова:
   * видна, но фактом не считается.
   */
  approvedAt?: string | null;
  approvedBy?: string | null;
  /** Откуда карточка взялась: код источника. Пусто — завёл владелец. */
  createdFrom?: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Типизированная точка карточки: координаты числами, проверенные по диапазону
   * на записи. null — координат нет. Источник истины для карты; attrs остаются
   * для совместимости.
   */
  geo?: { lat: number; lng: number; address: string | null } | null;
}

/** Значение поля карточки, предложенное не владельцем. */
export interface EntityDraft {
  id: string;
  entityId: string;
  field: string;
  value: string;
  /** Что стоит в карточке сейчас — владелец видит, что заменяется. */
  current: string | null;
  origin: string;
  setBy: string;
  note: string | null;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  actorKind: "human" | "agent" | "system";
  actorRef: string | null;
  action: string;
  target: string | null;
  ts: string;
}

/** Строка ленты действий сотрудников (GET /registry/actions). */
export interface ActionRow {
  ts: string;
  kind: string;
  label: string;
  personId: string;
  personName: string;
}

export interface Obligations {
  domain: string;
  /** Свод по обязательствам. Валюта обязательна: без неё суммы складывать нельзя. */
  totals: { direction: "in" | "out"; status: string; currency: string; count: number; amount: string }[];
  overdue: { id: string; amount: string; currency: string; date: string; status: string }[];
  /** Всего просрочек (список может быть усечён — тогда это больше его длины). */
  overdueTotal: number;
  overdueTruncated: boolean;
}

// ── Финансовый контур (модель PROMACH поверх money_flow) ──

export interface CurrencyAmount {
  currency: string;
  amount: number;
  count: number;
}

export interface FinanceBucket {
  count: number;
  byCurrency: CurrencyAmount[];
  /** Сумовой эквивалент только приведённых записей. */
  uzs: number;
  /** Записей без курса — в uzs не вошли. */
  unconverted: number;
}

export interface FinanceAging {
  notDue: FinanceBucket;
  d0_30: FinanceBucket;
  d31_60: FinanceBucket;
  d61_90: FinanceBucket;
  d90plus: FinanceBucket;
  noDue: FinanceBucket;
  total: FinanceBucket;
}

/** Запись money_flow с именем контрагента и сумовым эквивалентом. */
export interface FinanceFlow {
  id: string;
  domain: string | null;
  direction: "in" | "out";
  amount: string;
  currency: string;
  source: string;
  purpose: string | null;
  category: string | null;
  method: string | null;
  isOfficial: boolean;
  rate: string | null;
  amountUzs: string | null;
  counterpartyId: string | null;
  counterparty: string | null;
  docNo: string | null;
  dueDate: string | null;
  paidAt: string | null;
  date: string;
  status: string;
  createdAt: string;
  counterpartyEntityName: string | null;
  uzs: number | null;
}

export interface FinanceConcentrationRow {
  key: string;
  name: string;
  uzs: number;
  byCurrency: CurrencyAmount[];
  share: number | null;
}

export interface FinanceConcentration {
  rows: FinanceConcentrationRow[];
  topShare: number | null;
  /** ≥60% на одном должнике — красный термометр (правило OLMA). */
  alarm: boolean;
  totalUzs: number;
  unconverted: number;
}

export interface FinanceMonth {
  month: string;
  inflow: CurrencyAmount[];
  outflow: CurrencyAmount[];
  inflowUzs: number;
  outflowUzs: number;
}

export interface FxCurrent {
  currency: string;
  rate: string;
  source: string;
  note: string | null;
  setBy: string | null;
  createdAt: string;
}

/** Итог обновления курсов из ЦБ РУз: что встало, что пропущено и почему. */
export interface FxRefreshResult {
  updated: string[];
  skipped: { currency: string; reason: string }[];
  fx: FxCurrent[];
}

export interface FinanceSummary {
  domain: string;
  today: string;
  receivables: FinanceAging;
  payables: FinanceAging;
  dueSoonIn: FinanceFlow[];
  dueSoonOut: FinanceFlow[];
  concentration: FinanceConcentration;
  months: FinanceMonth[];
  fx: FxCurrent[];
}

export interface FinanceCounterparty {
  id: string;
  name: string;
  inn: string | null;
}

// ── Склад техники GLOBERENT (перенос warehouse_vehicles PROMACH) ──

export interface UnitReserveRow {
  id: string;
  unitId: string;
  clientId: string | null;
  endDate: string;
  status: string;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface GrUnit {
  id: string;
  domain: string;
  code: string;
  modelId: string | null;
  name: string;
  year: number | null;
  vin: string | null;
  status: string;
  salesStage: string | null;
  lostReason: string | null;
  salesPrice: string | null;
  clientId: string | null;
  contractId: string | null;
  arrivalDate: string | null;
  declarationType: string | null;
  declarationNumber: string | null;
  declarationDate: string | null;
  transportCompany: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  clientName: string | null;
  activeReserve: UnitReserveRow | null;
  /** Себестоимость по привязанным платежам, сумовой эквивалент. */
  costUzs: number;
}

export interface GrPreorder {
  id: string;
  domain: string;
  code: string;
  modelId: string | null;
  name: string;
  qty: number;
  clientId: string | null;
  supplierId: string | null;
  contractRef: string | null;
  factoryPriceUsd: string | null;
  promisedDeliveryDate: string | null;
  status: string;
  cancelledReason: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  clientName: string | null;
}

// ── Импортные контракты GLOBERENT (перенос import_contracts PROMACH) ──

export interface GrImportItem {
  modelId?: string | null;
  name: string;
  qty: number;
  price: number;
}

export interface GrImport {
  id: string;
  domain: string;
  contractNo: string;
  contractDate: string;
  supplierId: string | null;
  currency: string;
  totalAmount: string;
  items: GrImportItem[];
  purpose: string;
  saleContractId: string | null;
  status: string;
  lifecycleStatus: string;
  prepaymentAmount: string | null;
  prepaymentDueDate: string | null;
  prepaymentPaidAt: string | null;
  balanceAmount: string | null;
  balanceDueDate: string | null;
  balancePaidAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  supplierName: string | null;
  unitsTotal: number;
  unitsActive: number;
}

export interface GrImportDetail extends GrImport {
  units: GrUnit[];
}

// ── UZS-договоры GLOBERENT (перенос contracts PROMACH) ──

export interface ContractItemRow {
  equipmentId?: string | null;
  name: string;
  unit?: string;
  qty: number;
  price: number;
}

export interface GrContract {
  id: string;
  domain: string;
  contractNo: string;
  contractDate: string;
  clientId: string | null;
  buyer: Record<string, string | undefined>;
  sellerCompanyId: string | null;
  totalWithVat: string;
  totalVat: string;
  payType: string | null;
  warranty: string | null;
  deliveryDays: number | null;
  items: ContractItemRow[];
  docParams: Record<string, unknown>;
  status: string;
  agentId: string | null;
  agentCommissionAmount: string | null;
  agentCommissionCurrency: string | null;
  createdAt: string;
  updatedAt: string;
  clientName: string | null;
  /** Оплачено в сумовом эквиваленте — валюты не складываются сырыми. */
  paidUzs: number;
  paymentsCount: number;
  actsCount: number;
}

export interface ContractActRow {
  id: string;
  contractId: string;
  actNo: string;
  actDate: string;
  itemRefs: { equipmentId?: string | null; name: string }[];
  signedBySeller: string | null;
  signedByBuyer: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface GrContractDetail extends GrContract {
  payments: FinanceFlow[];
  planned: FinanceFlow[];
  acts: ContractActRow[];
}

// ── Расчётные справочники GLOBERENT: ставки ТН ВЭД и БРВ (перенос PROMACH) ──

export interface TnvedRate {
  id: string;
  code: string;
  nameRu: string;
  vehicleCategory: string;
  /** Доли: 0.05 = 5%. */
  importDutyRate: string;
  customsFeeRate: string;
  exciseRate: string;
  vatRate: string;
  utilizationBrvCount: number;
  extraDutyPerCcUsd: string;
  registrationType: string;
  certCashDefaultUzs: string | null;
  certBankDefaultUzs: string | null;
  grossMassMinKg: number | null;
  grossMassMaxKg: number | null;
  engineTypeConstraint: string | null;
  isActive: boolean;
  notes: string | null;
  validFrom: string | null;
  setBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BrvValue {
  id: string;
  valueUzs: string;
  validFrom: string;
  note: string | null;
  setBy: string | null;
  createdAt: string;
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
  budgetOnExceeded: "pause" | "downgrade" | "ask" | null;
  webSources: { name: string; url: string }[];
  breakGlass: string[];
  ideaChannels: string[];
  archivedAt: string | null;
  updatedAt: string;
}

/**
 * Заголовки записи в Core: тип тела и внутренний токен.
 *
 * Единственное место в панели, где подставляется SERVICE_TOKEN. Экспортируется
 * ради серверных действий, которым нужен свой разбор ответа и потому нельзя
 * пройти через send(): у guard'а Core мутация без токена — 401, а не мягкая
 * деградация, поэтому прямой fetch обязан брать заголовки отсюда.
 */
export function coreWriteHeaders(hasJsonBody = true): Record<string, string> {
  const headers: Record<string, string> = {};
  if (hasJsonBody) headers["Content-Type"] = "application/json";
  if (SERVICE_TOKEN) headers["x-service-token"] = SERVICE_TOKEN;
  return headers;
}

/** Запись в Core. Ошибку отдаём словами: её увидит владелец, а не разработчик. */
async function send<T>(path: string, method: "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown): Promise<T> {
  let res: Response;
  const headers = coreWriteHeaders(body !== undefined);
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
  /** По какому объекту работа: автомат, точка, склад. */
  entityId: string | null;
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
  /** Роли доступа: по ним фильтруется меню бота и проверяются мутации. */
  roles?: string[];
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

/** Расхождение по одному полю одной операции. */
export interface FieldDiff {
  role: string;
  label: string;
  a: string;
  b: string;
}
/** Итог сверки поля. */
export interface FieldSummary {
  role: string;
  label: string;
  agree: number;
  differ: number;
  absent: number;
}
/** Построчная сверка двух источников. */
export interface Reconciliation {
  totalA: number;
  totalB: number;
  matched: number;
  conflicts: { key: string; diffs: FieldDiff[] }[];
  onlyA: string[];
  onlyB: string[];
  onlyACount: number;
  onlyBCount: number;
  duplicatesA: { key: string; count: number }[];
  duplicatesB: { key: string; count: number }[];
  fields: FieldSummary[];
  a: { source: string; report: string; title: string };
  b: { source: string; report: string; title: string };
}

/** Где встретился заказ в объединённом журнале. */
export type Presence = "both" | "onlyA" | "onlyB";

/** Поле объединённого заказа: значения обеих сторон и их согласие. */
export interface UnifiedField {
  role: string;
  label: string;
  compare: "number" | "key" | "exact";
  a: string | null;
  b: string | null;
  agree: boolean | null;
}

/** Заказ объединённого журнала. */
export interface UnifiedOrder {
  key: string;
  presence: Presence;
  conflict: boolean;
  duplicated: boolean;
  fields: UnifiedField[];
}

/** Расхождение дневной выручки: союз против OurVend по одной корзине. */
export interface OurVendConflict {
  day: string;
  serial: string;
  product: string;
  unionOrders: number;
  unionRevenue: number;
  ourvendRevenue: number;
  provisional: boolean;
}

/** Пример дневной корзины — односторонней. */
export interface BucketSample {
  day: string;
  serial: string;
  product: string;
  revenue: number;
  orders: number;
}

/** Дневная сверка союза с OurVend: третий взгляд, а не слагаемое. */
export interface OurVendRecon {
  source: string | null;
  synced: boolean;
  fromDay: string | null;
  toDay: string | null;
  matched: number;
  agree: number;
  differ: number;
  onlyUnion: number;
  onlyOurVend: number;
  unionRevenue: number;
  ourvendRevenue: number;
  conflicts: OurVendConflict[];
  onlyUnionSamples: BucketSample[];
  onlyOurVendSamples: BucketSample[];
}

/** Объединённый журнал двух источников: каждый заказ один раз, по номеру. */
export interface UnifiedJournal {
  totalA: number;
  totalB: number;
  union: number;
  both: number;
  onlyA: number;
  onlyB: number;
  conflicts: number;
  duplicated: number;
  page: number;
  size: number;
  orders: UnifiedOrder[];
  a: { source: string; report: string; title: string };
  b: { source: string; report: string; title: string };
  /** Дневная сверка с OurVend (третий, дневной источник). */
  ourvend: OurVendRecon;
}

/** Заказ ленты «Все продажи»: строка источника плюс метка источника. */
export interface CombinedOrder {
  source: string;
  title: string;
  externalId: string;
  ts: string;
  machine: string;
  product: string;
  amount: string;
  amountNum: number | null;
  payment: string;
  status: string;
}

/** Итог по разрезу (источник, оплата, месяц). */
export interface Bucket {
  key: string;
  orders: number;
  revenue: number;
}

/** Свод по источнику — с пометкой, загружен ли он. */
export interface SourceBucket extends Bucket {
  source: string;
  loaded: boolean;
}

/** Объединённый журнал «Все продажи»: gjvending + OurVend в одной ленте. */
export interface CombinedSales {
  totalOrders: number;
  totalRevenue: number;
  bySource: SourceBucket[];
  byPayment: Bucket[];
  byMonth: Bucket[];
  unreadable: number;
  page: number;
  size: number;
  count: number;
  orders: CombinedOrder[];
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
  /** Артикулы источника (у OurVend — Commodity Code). Пусто — источник кода не даёт. */
  codes: string[];
  orders: number;
  revenue: number;
  unreadable: number;
  firstOrderAt: string;
  lastOrderAt: string;
  entityId: string | null;
  entityName: string | null;
  /** Карточка утверждена владельцем. false — ждёт его слова. */
  approved: boolean;
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

/** Строка рецепта с посчитанной стоимостью — как её отдаёт Core. */
export interface RecipeCostLine {
  ingredientId: string;
  ingredientName: string | null;
  /** Карточка ингредиента утверждена владельцем. false — ждёт слова. */
  approved: boolean;
  quantity: number;
  unit: string;
  /** Цена покупки ингредиента за `priceUnit`. null — не заведена. */
  price: number | null;
  priceUnit: string | null;
  /** Стоимость строки. null — посчитать нечем (см. `why`). */
  cost: number | null;
  why: string | null;
}

/** Рецепт товара: состав, цены ингредиентов и себестоимость. */
export interface RecipeView {
  productId: string;
  lines: RecipeCostLine[];
  /** Себестоимость: сумма посчитанных строк. */
  total: number;
  /** Строк, которые посчитать не удалось, — итог неполон. */
  unresolved: number;
}

/** Одно движение склада в ленте ингредиента. */
export interface StockMovementRow {
  id: string;
  kind: string;
  dt: string;
  warehouseId: string;
  warehouseName: string | null;
  counterpartyId: string | null;
  counterpartyName: string | null;
  qty: number;
  unit: string;
  unitPrice: number | null;
  total: number | null;
  supplier: string | null;
  source: string;
  note: string | null;
}

/** Остаток ингредиента по складам — считается на чтении из движений. */
export interface IngredientStock {
  ingredientId: string;
  ingredientName: string;
  /** Базовая единица (в которой заведена цена покупки). null — не задана. */
  baseUnit: string | null;
  /** Сводный остаток в базовой единице. null — базовой единицы нет. */
  total: number | null;
  /** Движений, что не удалось привести к базовой единице. */
  unconvertible: number;
  warehouses: { warehouseId: string; warehouseName: string; qty: number; unconvertible: number }[];
  movements: StockMovementRow[];
}

/** Остаток склада: что и сколько лежит. */
export interface WarehouseStock {
  warehouseId: string;
  warehouseName: string;
  items: {
    ingredientId: string;
    ingredientName: string;
    baseUnit: string | null;
    qty: number | null;
    unconvertible: number;
  }[];
  /** Лента движений склада, свежие сверху, до 100 строк. */
  movements: {
    id: string;
    kind: string;
    dt: string;
    ingredientId: string;
    ingredientName: string;
    qty: number;
    unit: string;
    supplier: string | null;
    note: string | null;
  }[];
}

/** Продажи одного товара (имя карточки + привязанные алиасы источника). */
export interface ProductSales {
  total: { qty: number; amount: number };
  machines: {
    machineId: string | null;
    serial: string;
    machineName: string | null;
    qty: number;
    amount: number;
  }[];
  /** Привязанные имена источника. Отсутствует у запроса по name. */
  aliases?: { id: string; name: string }[];
}

/** Имя продаж без карточки и алиаса — то, что теряется из карточек. */
export interface UnmatchedSaleName {
  name: string;
  qty: number;
  amount: number;
  lastDt: string;
}

/** Расход одного ингредиента за период — списано продажами. */
export interface ConsumptionIngredient {
  ingredientId: string;
  ingredientName: string;
  approved: boolean;
  /** Списано в базовой единице. null — базовой единицы/перевода нет. */
  consumed: number | null;
  unit: string | null;
  /** Стоимость списанного. null — цены нет. */
  cost: number | null;
  unconvertible: number;
  fromProducts: number;
}

/** Расход сырья за период: списание из журнала продаж по рецептам. */
export interface ConsumptionReport {
  from: string;
  to: string;
  /** Продано единиц товаров-рецептов за период. */
  soldRecipeUnits: number;
  /** Себестоимость списанного. */
  totalCost: number;
  /** Строк списания, где стоимость посчитать не удалось. */
  unresolved: number;
  ingredients: ConsumptionIngredient[];
  products: { productId: string; productName: string; soldQty: number; cost: number | null }[];
  /** Проданные товары с карточкой, но без рецепта — расхода не дают. */
  noRecipe: { productId: string; productName: string; soldQty: number }[];
  /** Проданные названия без карточки — расход по ним не сведён. */
  unmatched: { product: string; source: string; soldQty: number; revenue: number }[];
}

/** Текстовый ответ Core — для выгрузки CSV, который нельзя разбирать как JSON. */
/** Вложение записи: фото номенклатуры или чек. Файл — в хранилище Core. */
export interface Attachment {
  id: string;
  ownerType: string;
  ownerId: string;
  kind: string;
  /** В какой момент снято: before | after | plate | counter. */
  stage: string | null;
  mime: string | null;
  bytes: number | null;
  /**
   * Ссылка на файл. У S3 — presigned (браузер идёт прямо туда); у локального
   * хранилища — относительный путь Core (`/attachments/:id/raw`), который панель
   * проксирует через свой маршрут `/api/attachments/:id/raw`.
   */
  url: string;
  createdAt: string;
}

/**
 * Забрать бинарный файл из Core (фото карточки) для проксирования браузеру.
 *
 * Core наружу не смотрит, а `<img>` в браузере ходит на панель — поэтому байты
 * идут через неё же, как и выгрузки. Отдаём тело и тип, а стримингом займётся
 * маршрут.
 */
export async function coreBytes(path: string): Promise<{ body: ArrayBuffer; contentType: string | null }> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
  } catch (err) {
    throw new CoreUnavailable(err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) throw new CoreUnavailable(`HTTP ${res.status} на ${path}`);
  return { body: await res.arrayBuffer(), contentType: res.headers.get("content-type") };
}

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

/** Строка сводки сроков. Статус посчитан в Core на чтении. */
export interface MaintenanceDue {
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
  /** Состояние автомата: in_service | warehouse | repair. Не автомат — null. */
  machineStatus?: string | null;
  /** Работы имеют смысл. Поле молодое: старый Core его не отдаёт. */
  operational?: boolean;
  idleReason?: string | null;
}

export interface MaintenancePlan {
  id: string;
  entityId: string;
  kind: string;
  partKind: string | null;
  title: string | null;
  everyDays: number | null;
  everyMonths: number | null;
  everyCount: number | null;
  dueOn: string | null;
  taskLeadDays: number;
  autoTask: boolean;
  assigneeId: string | null;
  isActive: boolean;
}

export interface MaintenanceLogRow {
  id: string;
  entityId: string;
  kind: string;
  partKind: string | null;
  personId: string | null;
  performedOn: string;
  outcome: "done" | "partial" | "failed" | null;
  note: string | null;
  counterValue: number | null;
  createdAt: string;
}

/**
 * Узел периодом: removedOn = null — период открыт. machineId = null — узел
 * вне автомата (склад/мойка/сушка/ремонт, см. location).
 */
export interface MachinePart {
  id: string;
  machineId: string | null;
  location: string;
  partKind: string;
  slot: number | null;
  serialNumber: string | null;
  model: string | null;
  installedOn: string;
  removedOn: string | null;
  warrantyUntil: string | null;
  reason: string | null;
  note: string | null;
}

/** Период истории экземпляра (по серийнику) с именем автомата. */
export interface PartHistoryRow extends MachinePart {
  machineName: string | null;
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
  /** Просроченное по всей организации (эндпоинт без фильтра домена — режем на клиенте). */
  tasksOverdue: () => get<Task[]>("/tasks/overdue"),
  workload: () => get<Workload[]>("/tasks/workload"),
  createTask: (input: Record<string, unknown>) => send<Task>("/tasks", "POST", input),
  rateTask: (id: string, quality: "excellent" | "accepted" | "redo") =>
    send<Task>(`/tasks/${id}/quality`, "POST", { quality }),
  setTaskStatus: (id: string, input: Record<string, unknown>) =>
    send<Task>(`/tasks/${id}`, "PATCH", input),
  editTask: (id: string, input: Record<string, unknown>) =>
    send<Task>(`/tasks/${id}/edit`, "PATCH", input),
  addTaskComment: (id: string, input: Record<string, unknown>) =>
    send<TaskComment>(`/tasks/${id}/comments`, "POST", input),

  // ── Обслуживание оборудования ──
  //
  // Статус «пора / просрочено» приходит посчитанным на чтении: он зависит от
  // текущей даты и нигде не хранится, поэтому панель его не вычисляет заново.
  maintenanceDue: () => get<MaintenanceDue[]>("/maintenance/due"),
  maintenancePlans: (entityId?: string) =>
    get<MaintenancePlan[]>(`/maintenance/plans${entityId ? `?entityId=${entityId}` : ""}`),
  maintenanceLog: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return get<MaintenanceLogRow[]>(`/maintenance/log${qs ? `?${qs}` : ""}`);
  },
  machineParts: (machineId: string) => get<MachinePart[]>(`/maintenance/parts?machineId=${machineId}`),
  /** Узлы вне автоматов: склад, мойка, сушка, ремонт. */
  machinePartsStorage: () => get<MachinePart[]>("/maintenance/parts/storage"),
  /** История экземпляров по серийнику и/или модели — все периоды в обе стороны. */
  partHistory: (q: { serial?: string; model?: string }) => {
    const qs = new URLSearchParams();
    if (q.serial) qs.set("serial", q.serial);
    if (q.model) qs.set("model", q.model);
    return get<PartHistoryRow[]>(`/maintenance/parts/history?${qs.toString()}`);
  },
  installPart: (input: Record<string, unknown>) =>
    send<{ installed: MachinePart }>("/maintenance/part-install", "POST", input),
  removePart: (input: Record<string, unknown>) =>
    send<{ removed: MachinePart; stored: MachinePart }>("/maintenance/part-remove", "POST", input),
  swapPart: (input: Record<string, unknown>) =>
    send<{ installed: MachinePart }>("/maintenance/part-swap", "POST", input),
  upsertMaintenancePlan: (input: Record<string, unknown>) =>
    send<MaintenancePlan>("/maintenance/plans", "POST", input),

  // ── Сотрудники ──
  people: (all = false) => get<Person[]>(`/people${all ? "?all=1" : ""}`),
  person: (id: string) => get<Person>(`/people/${id}`),
  createPerson: (input: Record<string, unknown>) => send<Person>("/people", "POST", input),
  /** Выпустить приглашение. Код возвращается ОДИН раз — в БД только хеш. */
  invitePerson: (id: string, roles: string[]) =>
    send<{ code: string; expiresAt: string; name: string }>(`/people/${id}/invite`, "POST", { roles }),
  /** Отозвать доступ: снять привязку и роли, погасить живые приглашения. */
  revokePerson: (id: string) => send<Person>(`/people/${id}/revoke`, "POST", {}),
  setPersonRoles: (id: string, roles: string[]) =>
    send<Person>(`/people/${id}/roles`, "POST", { roles }),
  updatePerson: (id: string, input: Record<string, unknown>) =>
    send<Person>(`/people/${id}`, "PATCH", input),
  agent: (name: string) => get<AgentCard>(`/agents/${encodeURIComponent(name)}`),
  createAgent: (input: Record<string, unknown>) => send<AgentCard>("/agents", "POST", input),
  updateAgent: (name: string, patch: Record<string, unknown>) =>
    send<AgentCard>(`/agents/${encodeURIComponent(name)}`, "PATCH", patch),
  archiveAgent: (name: string) => send<AgentCard>(`/agents/${encodeURIComponent(name)}`, "DELETE"),

  // ── Карточка автомата: вид и состояние ──
  /**
   * Карточка одного автомата. Core отдаёт весь список (парк — три десятка
   * строк), поэтому фильтруем здесь: заводить ради этого второй эндпоинт с
   * фильтром — лишняя поверхность.
   */
  machineCard: (entityId: string) =>
    get<MachineCard[]>("/entities/machine-cards/all").then(
      (rows) => rows.find((r) => r.entityId === entityId) ?? null,
    ),
  /** Виды и состояния всего парка одним запросом — для списка автоматов. */
  machineCards: () => get<MachineCard[]>("/entities/machine-cards/all"),
  setMachineKind: (entityId: string, kind: string, note?: string) =>
    send<MachineCard>(`/entities/${entityId}/machine-kind`, "PATCH", {
      kind,
      actor: "owner",
      ...(note !== undefined ? { note } : {}),
    }),
  setMachineStatus: (entityId: string, status: string, note?: string, placeId?: string) =>
    send<MachineCard>(`/entities/${entityId}/machine-status`, "PATCH", {
      status,
      ...(note !== undefined ? { note } : {}),
      ...(placeId !== undefined ? { placeId } : {}),
    }),

  // ── Вендинг: автоматы и дефицит ──
  vendingMachines: () => get<VendingMachine[]>("/vending/machines"),
  vendingDeficit: () => get<VendingNeed[]>("/vending/deficit"),
  vendingForecast: () => get<{ all: VendingRunout[]; critical: VendingRunout[] }>("/vending/forecast"),
  vendingPurchase: () => get<VendingPurchase>("/vending/purchase"),
  vendingOrders: () => get<VendingOrder[]>("/vending/orders"),
  vendingSyncRuns: () => get<VendingSyncRun[]>("/vending/sync"),
  /** Журнал заливок построчно (по слоту) — источник ленты «Обслуживание» (снек). */
  vendingRefillList: (limit = 100) => get<VendingRefillRow[]>(`/vending/refills?limit=${limit}`),

  // ── Кофе-бункеры: ручные кофемашины ──
  coffeeLocations: () => get<CoffeeLocation[]>("/coffee/locations"),
  coffeeBunkerConfig: () => get<CoffeeBunkerIngredient[]>("/coffee/bunker-config"),
  addCoffeeBunkerIngredient: (position: number, ingredientName: string) =>
    send<{ ingredientId: string }>("/coffee/bunker-config", "POST", { position, ingredientName }),
  removeCoffeeBunkerIngredient: (position: number, ingredientId: string) =>
    send<{ ok: true }>("/coffee/bunker-config", "DELETE", { position, ingredientId }),
  setCoffeeIngredientPrice: (ingredientId: string, purchasePrice: number) =>
    send<{ ok: true }>("/coffee/ingredient-price", "PUT", { ingredientId, purchasePrice }),
  setCoffeeTargetFillWeight: (position: number, ingredientId: string, targetFillWeight: number) =>
    send<{ ok: true }>("/coffee/target-fill", "PUT", { position, ingredientId, targetFillWeight }),
  coffeeFillStatus: () => get<CoffeeFillStatusRow[]>("/coffee/fill-status"),
  coffeeReconcile: (locationId: string, from: string, to: string) =>
    get<CoffeeReconcileRow[]>(`/coffee/reconcile/${locationId}?from=${from}&to=${to}`),
  coffeeReconcileAll: (from: string, to: string) =>
    get<CoffeeLocationReconcileGroup[]>(`/coffee/reconcile?from=${from}&to=${to}`),
  coffeeTareGrid: () => get<CoffeeTareCell[]>("/coffee/tare"),
  setCoffeeTare: (containerNumber: number, position: number, tareWeight: number) =>
    send<{ ok: true }>("/coffee/tare", "PUT", { containerNumber, position, tareWeight }),
  submitCoffeeRefill: (input: {
    locationId: string;
    position: number;
    containerNumber?: number;
    filledWeight: number;
    packageCount?: number;
    enteredDate: string;
    createdBy?: string;
  }) => send<{ id: string }>("/coffee/refill", "POST", input),
  recentCoffeeRefills: (limit = 20) => get<CoffeeRefillRow[]>(`/coffee/refill/recent?limit=${limit}`),
  coffeeLocationSummary: () => get<CoffeeLocationSummaryRow[]>("/coffee/summary"),
  recordCoffeeConsumable: (input: { locationId: string; loggedDate: string; water?: number; cups?: number; lids?: number }) =>
    send<{ ok: true }>("/coffee/consumables", "POST", input),
  coffeeConsumablesSummary: () => get<CoffeeConsumableRow[]>("/coffee/consumables"),
  coffeeContainerReturns: (limit = 200) =>
    get<CoffeeContainerReturnRow[]>(`/coffee/container-return?limit=${limit}`),
  coffeePlacements: (locationId?: string) =>
    get<CoffeePlacementRow[]>(
      `/coffee/placements${locationId ? `?locationId=${locationId}` : ""}`,
    ),
  coffeeContainerConsumption: (from: string, to: string) =>
    get<CoffeeContainerConsumptionReport>(`/coffee/container-consumption?from=${from}&to=${to}`),
  recordCoffeeWash: (input: { locationId: string; position?: number; note?: string; performedBy?: string }) =>
    send<{ id: string }>("/coffee/wash", "POST", input),
  coffeeWashHistory: (locationId?: string, limit = 50) =>
    get<CoffeeWashRow[]>(`/coffee/wash?limit=${limit}${locationId ? `&locationId=${locationId}` : ""}`),
  coffeeStockLevels: () => get<CoffeeStockLevelRow[]>("/coffee/stock"),
  ingestCoffeeStock: (input: { countedAt?: string; items: { ingredientId: string; quantity: number }[] }) =>
    send<{ items: number; adjustments: unknown[] }>("/coffee/stock", "POST", input),
  coffeeMachineCandidates: () => get<CoffeeMachineCandidate[]>("/coffee/machines"),
  /** Снять аппарат с места. Адресуется аппаратом: мест с двумя аппаратами хватает. */
  unlinkCoffeeMachine: (entityId: string) =>
    send<{ ok: true }>(`/coffee/machine-link/${entityId}`, "DELETE"),
  createCoffeeLocation: (name: string) => send<{ id: string }>("/coffee/locations", "POST", { name }),
  updateCoffeeLocation: (id: string, patch: { name?: string; isActive?: boolean }) =>
    send<{ ok: true }>(`/coffee/locations/${id}`, "PUT", patch),
  deleteCoffeeRefill: (id: string) => send<{ ok: true }>(`/coffee/refill/${id}`, "DELETE"),
  deleteCoffeeContainerReturn: (id: string) => send<{ ok: true }>(`/coffee/container-return/${id}`, "DELETE"),
  linkCoffeeLocation: (locationId: string, entityId: string | null) =>
    send<{ ok: true }>("/coffee/location-link", "PUT", { locationId, ...(entityId !== null ? { entityId } : {}) }),
  autoLinkCoffeeLocations: () =>
    send<{ linked: number; ambiguous: string[]; unmatched: string[] }>("/coffee/location-link/auto", "POST", {}),
  coffeeWashScheduleStatus: () => get<CoffeeWashScheduleStatusRow[]>("/coffee/wash-schedule"),
  coffeeWashSchedules: () => get<CoffeeWashScheduleRow[]>("/coffee/wash-schedule/all"),
  setCoffeeWashSchedule: (input: {
    locationId: string;
    position?: number;
    frequencyDays?: number;
    frequencyCups?: number;
    isActive?: boolean;
    notes?: string;
  }) => send<CoffeeWashScheduleRow>("/coffee/wash-schedule", "POST", input),
  removeCoffeeWashSchedule: (id: string) => send<{ ok: true }>(`/coffee/wash-schedule/${id}`, "DELETE"),

  // ── Система: глобальные тумблеры активации (мозг/RAG/пауза/бюджет) ──
  systemConfig: () => get<SystemConfigItem[]>("/system/config"),
  saveSystemConfig: (input: { key: string; value: string; updatedBy?: string }) =>
    send<SystemConfigItem[]>("/system/config", "PUT", input),
  pendingApprovals: () => get<Approval[]>("/approvals/pending"),
  allApprovals: () => get<Approval[]>("/approvals"),
  audit: (limit = 40) => get<AuditEntry[]>(`/audit?limit=${limit}`),
  /** Лента действий сотрудников: «кто что сделал» за период (даты по Ташкенту). */
  actions: (from: string, to: string, personId?: string) =>
    get<ActionRow[]>(`/registry/actions?from=${from}&to=${to}${personId ? `&person=${personId}` : ""}`),
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
  /**
   * Все контрагенты, без привязки к направлению.
   *
   * Одно юрлицо — одна карточка (ИНН уникален во всём реестре), поэтому
   * поставщик VendHub может лежать в организации GLOBERENT, куда попал при
   * выгрузке документов. Отбор по направлению делает `contractorInDirection`
   * на стороне панели: организация — где карточка родилась, тег — где работает.
   *
   * Предел взят потолком Core (MAX_FIND_LIMIT), а не умолчанием в 500: сейчас
   * контрагентов 233, и на умолчании список начал бы молча обрезаться задолго
   * до того, как это кто-нибудь заметит.
   */
  contractorsAll: () => get<Entity[]>(`/entities?type=contractor&limit=5000`),
  entity: (id: string) => get<Entity>(`/entities/${id}`),
  createEntity: (input: Record<string, unknown>) => send<Entity>("/entities", "POST", input),
  /** Вложения записи (фото номенклатуры, чеки) — для галереи карточки. */
  attachments: (ownerType: string, ownerId: string) =>
    get<Attachment[]>(
      `/attachments?ownerType=${encodeURIComponent(ownerType)}&ownerId=${encodeURIComponent(ownerId)}`,
    ),
  /**
   * Вложения многих записей одним запросом — для очереди утверждения: пачка
   * черновиков показывается сразу с фото, без похода в хранилище по одному.
   * Пустой набор ходить незачем — отдаём пустую карту сразу.
   */
  attachmentsBatch: (ownerType: string, ids: string[]) =>
    ids.length === 0
      ? Promise.resolve<Record<string, Attachment[]>>({})
      : get<Record<string, Attachment[]>>(
          `/attachments/batch?ownerType=${encodeURIComponent(ownerType)}&ids=${encodeURIComponent(ids.join(","))}`,
        ),
  entityDrafts: (id: string) => get<EntityDraft[]>(`/entities/${id}/drafts`),
  /** Рецепт товара: состав, цены ингредиентов и себестоимость. */
  entityRecipe: (id: string) => get<RecipeView>(`/entities/${id}/recipe`),
  /** Остаток ингредиента по складам и лента его движений. */
  ingredientStock: (id: string) => get<IngredientStock>(`/stock/ingredient/${id}`),
  /** Остаток склада: что и сколько лежит. */
  warehouseStock: (id: string) => get<WarehouseStock>(`/stock/warehouse/${id}`),
  /** Завести движение склада (приход). */
  createMovement: (input: Record<string, unknown>) =>
    send<StockMovementRow>("/stock/movement", "POST", input),
  /** Удалить движение (правка ручного прихода). */
  deleteMovement: (id: string) => send<{ ok: boolean }>(`/stock/movement/${id}`, "DELETE"),
  /** Пересчёт: сервер сам считает дельту от книжного остатка и пишет корректировку. */
  stocktake: (input: Record<string, unknown>) =>
    send<{
      changed: boolean;
      before: number;
      actual: number;
      delta: number;
      unit: string;
      ingredientName: string;
      warehouseName: string;
      movementId: string | null;
    }>("/stock/stocktake", "POST", input),
  /** Расход сырья за период (списание из журнала продаж по рецептам). */
  consumption: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return get<ConsumptionReport>(`/stock/consumption${qs ? `?${qs}` : ""}`);
  },
  /** Свести приход из mydon-stock в ленту склада (идемпотентно). */
  syncIntake: () =>
    send<{
      warehouse: string | null;
      created: number;
      alreadySynced: number;
      noCard: number;
      badUnit: number;
      noWarehouse: "нет" | "неоднозначно" | null;
    }>("/stock/sync-intake", "POST", {}),
  pendingEntities: () =>
    get<{ cards: Entity[]; fields: (EntityDraft & { entityName: string; entityType: string })[] }>(
      "/entities/pending",
    ),
  proposeField: (id: string, input: Record<string, unknown>) =>
    send<{ ok: true }>(`/entities/${id}/propose`, "POST", input),
  approveEntity: (id: string) => send<Entity>(`/entities/${id}/approve`, "POST", {}),
  /** Утвердить пачку карточек разом — «утвердить все» из очереди. */
  approveEntities: (ids: string[]) =>
    send<{ approved: number; skipped: number }>("/entities/approve-batch", "POST", { ids }),
  approveField: (id: string, field: string) =>
    send<Entity>(`/entities/${id}/approve-field/${encodeURIComponent(field)}`, "POST", {}),
  rejectField: (id: string, field: string) =>
    send<{ ok: true }>(`/entities/${id}/reject-field/${encodeURIComponent(field)}`, "POST", {}),
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
  /** Оценка наличных, накопленных в автоматах с последней инкассации по каждому. */
  cashEstimate: () =>
    get<{
      всего: number;
      поАвтоматам: { machineId: string; имя: string | null; сумма: number; с: string | null }[];
    }>("/collections/cash-estimate"),
  receiveCollection: (id: string, amount: number) =>
    send<CollectionRow>(`/collections/${id}/receive`, "POST", { amount, manager: "owner" }),
  cancelCollection: (id: string) =>
    send<CollectionRow>(`/collections/${id}/cancel`, "POST", { manager: "owner" }),
  /**
   * Проданные чашки кофе — факт из панели производителя.
   *
   * Отдельно от `salesSummary`: тот отвечает за снек из OurVend и суточный
   * агрегат, а здесь каждый заказ со временем. До этого выручка кофе в панели
   * не показывалась вовсе, хотя она в разы больше снековой.
   */
  coffeeOrdersSummary: (from?: string, to?: string) =>
    get<{
      всего: { чашек: number; выручка: number; среднийЧек: number };
      vip: { чашек: number; выручка: number };
      неВыдано: number;
      поМесяцам: { месяц: string; чашек: number; выручка: number }[];
      поАвтоматам: { машина: string; чашек: number; выручка: number }[];
      поТоварам: { товар: string; чашек: number; выручка: number }[];
      поДням: { день: string; чашек: number; выручка: number }[];
    }>(`/coffee/orders/summary${from ? `?from=${from}${to ? `&to=${to}` : ""}` : ""}`),
  salesSummary: () =>
    get<{
      today: { qty: number; amount: number };
      yesterday: { qty: number; amount: number };
      days30: { qty: number; amount: number };
      lastSaleDt: string | null;
      configured: boolean;
    }>("/sales/summary"),
  sales: (days = 7, limit = 300) => get<SaleRow[]>(`/sales?days=${days}&limit=${limit}`),
  /** Продажи карточки товара: имя + алиасы источника. */
  salesByProductCard: (entityId: string, days = 90) =>
    get<ProductSales>(`/sales/by-product?entityId=${entityId}&days=${days}`),
  /** Имена продаж без карточки и алиаса. */
  salesUnmatched: (days = 90) => get<UnmatchedSaleName[]>(`/sales/unmatched-names?days=${days}`),
  addSaleAlias: (name: string, entityId: string) =>
    send<{ id: string; name: string; entityId: string }>("/sales/alias", "POST", {
      name,
      entityId,
      actor: "owner",
    }),
  removeSaleAlias: (id: string) => send<{ ok: boolean }>(`/sales/alias/${id}`, "DELETE"),
  /** Весь словарь алиасов — для резолвинга имён в лентах прихода/остатков. */
  salesAliases: () => get<{ id: string; name: string; entityId: string }[]>("/sales/aliases"),
  salesDaily: (days = 30) => get<{ dt: string; qty: number; amount: number }[]>(`/sales/daily?days=${days}`),
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

  // ── Финансовый контур (агинг, «к сроку», термометр, курс) ──
  financeSummary: (domain: string) => get<FinanceSummary>(`/finance/summary/${domain}`),
  financeFlows: (domain: string, params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return get<FinanceFlow[]>(`/finance/flows/${domain}${qs ? `?${qs}` : ""}`);
  },
  financeCounterparties: (domain: string) =>
    get<FinanceCounterparty[]>(`/finance/counterparties/${domain}`),
  // ── Склад техники ──
  units: (domain: string, group?: string) =>
    get<GrUnit[]>(`/units?domain=${domain}${group !== undefined ? `&group=${group}` : ""}`),
  unitsSummary: (domain: string) =>
    get<{ key: string; label: string; n: number }[]>(`/units/summary?domain=${domain}`),
  createUnit: (input: Record<string, unknown>) => send<GrUnit>("/units", "POST", input),
  unitAction: (id: string, action: string, extra: Record<string, unknown> = {}) =>
    send<GrUnit>(`/units/${id}/action/${encodeURIComponent(action)}`, "PATCH", extra),
  setUnitVin: (id: string, vin: string) => send<GrUnit>(`/units/${id}/vin`, "PATCH", { vin }),
  unbindUnitVin: (id: string) => send<GrUnit>(`/units/${id}/vin/unbind`, "PATCH", {}),
  reserveUnit: (id: string, input: Record<string, unknown>) =>
    send<UnitReserveRow>(`/units/${id}/reserve`, "POST", input),
  cancelUnitReserve: (id: string) => send<GrUnit>(`/units/${id}/reserve/cancel`, "PATCH", {}),
  setUnitSalesStage: (id: string, input: Record<string, unknown>) =>
    send<GrUnit>(`/units/${id}/sales-stage`, "PATCH", input),

  // ── Предзаказы ──
  preorders: (domain: string) => get<GrPreorder[]>(`/preorders?domain=${domain}`),
  createPreorder: (input: Record<string, unknown>) => send<GrPreorder>("/preorders", "POST", input),
  preorderAction: (id: string, action: string, extra: Record<string, unknown> = {}) =>
    send<GrPreorder>(`/preorders/${id}/action/${encodeURIComponent(action)}`, "PATCH", extra),
  cancelPreorder: (id: string, reason: string) =>
    send<GrPreorder>(`/preorders/${id}/cancel`, "PATCH", { reason }),

  // ── Импортные контракты ──
  imports: (domain: string) => get<GrImport[]>(`/imports?domain=${domain}`),
  importContract: (id: string) => get<GrImportDetail>(`/imports/${id}`),
  createImport: (input: Record<string, unknown>) => send<GrImport>("/imports", "POST", input),
  signImport: (id: string) => send<GrImportDetail>(`/imports/${id}/sign`, "PATCH", {}),
  markImportPaid: (id: string, kind: "prepayment" | "balance") =>
    send<GrImport>(`/imports/${id}/paid/${kind}`, "PATCH", {}),
  bulkImportAction: (id: string, action: string, extra: Record<string, unknown> = {}) =>
    send<{ moved: number; skipped: number; lifecycle: string }>(
      `/imports/${id}/bulk/${encodeURIComponent(action)}`,
      "PATCH",
      extra,
    ),
  cancelImport: (id: string) => send<GrImport>(`/imports/${id}/cancel`, "PATCH", {}),

  // ── UZS-договоры ──
  contracts: (domain: string) => get<GrContract[]>(`/contracts?domain=${domain}`),
  contract: (id: string) => get<GrContractDetail>(`/contracts/${id}`),
  createContract: (input: Record<string, unknown>) => send<GrContract>("/contracts", "POST", input),
  setContractStatus: (id: string, status: string) =>
    send<GrContract>(`/contracts/${id}/status`, "PATCH", { status }),
  addContractPayment: (id: string, input: Record<string, unknown>) =>
    send<FinanceFlow>(`/contracts/${id}/payments`, "POST", input),
  addContractAct: (id: string, input: Record<string, unknown>) =>
    send<ContractActRow>(`/contracts/${id}/acts`, "POST", input),

  // ── Расчётные справочники (ставки ТН ВЭД, БРВ) ──
  tnvedRates: (all = false) => get<TnvedRate[]>(`/catalog/tnved${all ? "?all=1" : ""}`),
  saveTnvedRate: (input: Record<string, unknown>) =>
    send<TnvedRate>("/catalog/tnved", "POST", input),
  deactivateTnvedRate: (id: string) =>
    send<TnvedRate>(`/catalog/tnved/${id}/deactivate`, "PATCH", {}),
  brvValues: () => get<BrvValue[]>("/catalog/brv"),
  setBrvValue: (input: { valueUzs: number; validFrom: string; note?: string }) =>
    send<BrvValue[]>("/catalog/brv", "PUT", input),

  fxRates: () => get<FxCurrent[]>("/finance/fx"),
  setFxRate: (input: { currency: string; rate: number; note?: string }) =>
    send<FxCurrent[]>("/finance/fx", "PUT", input),
  refreshFxRates: () => send<FxRefreshResult>("/finance/fx/refresh", "POST", { actorRef: "owner" }),
  createFinanceFlow: (input: Record<string, unknown>) =>
    send<FinanceFlow>("/finance/flows", "POST", input),
  payFinanceFlow: (id: string, rate?: number) =>
    send<FinanceFlow>(`/finance/flows/${id}/pay`, "PATCH", rate !== undefined ? { rate } : {}),
  cancelFinanceFlow: (id: string) => send<FinanceFlow>(`/finance/flows/${id}/cancel`, "PATCH", {}),

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
  /** Заготовки для фискальных полей: из уже заполненных карточек. */
  fiscalPresets: () =>
    get<{
      values: Record<string, string[]>;
      donors: { id: string; name: string; fields: Record<string, string> }[];
    }>("/raw/fiscal-presets"),
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
  rawReconcile: (a: { source: string; report: string }, b: { source: string; report: string }) =>
    get<Reconciliation>(
      `/raw/reconcile/${encodeURIComponent(a.source)}/${encodeURIComponent(a.report)}/vs/${encodeURIComponent(b.source)}/${encodeURIComponent(b.report)}`,
    ),
  rawUnify: (
    a: { source: string; report: string },
    b: { source: string; report: string },
    params: Record<string, string> = {},
  ) => {
    const qs = new URLSearchParams(params).toString();
    return get<UnifiedJournal>(
      `/raw/unify/${encodeURIComponent(a.source)}/${encodeURIComponent(a.report)}/vs/${encodeURIComponent(b.source)}/${encodeURIComponent(b.report)}${qs ? `?${qs}` : ""}`,
    );
  },
  rawAllSales: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return get<CombinedSales>(`/raw/all-sales${qs ? `?${qs}` : ""}`);
  },
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
