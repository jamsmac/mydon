import "server-only";
// Формы, которые нужны САМОМУ клиенту (в сигнатурах `get<…>` ниже): реэкспорт
// `export type … from …` имени в модуле не заводит, поэтому они ещё и здесь.
import type {
  AnalyticsWarning,
  DeadStockReport,
  DenominationCounts,
  MarginReport,
  MonthlyPrice,
  OurvendHealth,
  OurvendSyncRun,
  ParityStreak,
  PriceChangesReport,
  PriceGapReport,
  ProductFiscal,
  ProductFiscalPatch,
  PurchasePlan as VendingPlan,
  PurchaseSummary as VendingPurchase,
  ShrinkReport as VendingShrinkageReport,
  StockCountsReport,
} from "@mydon/shared";

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
  /**
   * Автомат в строю (карточка реестра не говорит обратного). Список автоматов
   * фильтром «в строю» НЕ режется — он зеркало сбора Ourvend, — но закуп,
   * план и прогноз такой автомат уже не считают, и панели есть чем это
   * объяснить (П5b-3).
   */
  inService: boolean;
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

/**
 * Аналитика снек-контура (П5b): формы отчётов живут в `@mydon/shared`
 * (`vending-reports.ts`, R-P5b-10) — их считает Core, а бот и панель
 * ИМПОРТИРУЮТ оттуда же. Здесь только реэкспорт: ни одно поле не переписано,
 * иначе у владельца снова разъехались бы три копии одного числа (урок П5a).
 *
 * Финальная волна довела список до конца: `MonthlyPrice`, `OurvendHealth` и
 * `OurvendSyncRun` жили здесь копиями поле-в-поле (Task 4 положил их в shared
 * последним), теперь и они реэкспортируются. Своих объявлений форм отчётов в
 * панели больше НЕТ — расхождение полей ловит компилятор, а не читатель.
 *
 * Тем же приёмом сюда приехали план закупа и усушка (R-H-6). Имена панели
 * сохранены `as`-алиасами, поэтому ни один лист не правится; заодно исчезли
 * два расхождения копии с ядром — свой порядок союза кодов усушки и
 * инлайненный `summary` автомата вместо общей `ShrinkSummary`.
 *
 * `VendingPurchase`/`VendingPurchaseItem` — тот же переезд, доведённый до
 * конца. Их рукописные копии пережили R-H-6 и УЖЕ разъехались: `covered`,
 * `surplus`, `extra`, `costExact` у позиции и `totalNeed`, `totalCovered`,
 * `costByPriceFull` у сводки Core отдаёт, а копия панели о них не знала —
 * притом что `GET /vending/purchase` и `GET /vending/plan` возвращают ОДИН И
 * ТОТ ЖЕ объект (`PurchaseContext.summary`). Рантайма это не ломало
 * (структурная типизация лишние поля терпит), но переименование поля в Core
 * увидел бы владелец пустой строкой в панели, а не компилятор.
 */
export type {
  AnalyticsWarning,
  AnalyticsWarningCode,
  DeadRow,
  DeadStockReport,
  MarginExcluded,
  MarginMachine,
  MarginProduct,
  MarginReport,
  MarginTotals,
  MonthlyPrice,
  OurvendHealth,
  OurvendSyncRun,
  ParityStreak,
  PriceChange,
  PriceChangesReport,
  PriceGapReport,
  PriceGapRow,
  PurchaseItem as VendingPurchaseItem,
  PurchaseSummary as VendingPurchase,
  PurchasePlan as VendingPlan,
  PlanMachine as VendingPlanMachine,
  SlotPlanRow as VendingPlanSlot,
  PlanWarning as VendingPlanWarning,
  ShrinkItem as VendingShrinkageItem,
  ShrinkMachine as VendingShrinkageMachine,
  ShrinkRefillDay as VendingShrinkageRefillDay,
  ShrinkReport as VendingShrinkageReport,
  ShrinkWarning as VendingShrinkageWarning,
  StockCountRow,
  StockCountsReport,
} from "@mydon/shared";

/**
 * Хвост «посчитано не всё»: Core доклеивает `warnings` ко всем четырём
 * отчётам аналитики (П5b Task 3), панель показывает их блоком «Посчитано не
 * всё» — тем же набором фактов, что бот печатает строками.
 *
 * Поле НЕобязательное намеренно (как `WithWarnings` в боте): отчёт без
 * предупреждений — законный ответ, и фикстуры листов, написанные до Task 3,
 * обязаны рендериться как раньше, а не падать.
 */
export interface WithWarnings {
  warnings?: AnalyticsWarning[];
}

/** Событие детектора заливок: что автомат получил и была ли запись оператора. */
export interface VendingRefillEvent {
  id: string;
  serial: string;
  name: string;
  windowFrom: string;
  windowTo: string;
  units: number;
  slots: { coilId: string; product: string; before: number; after: number; delta: number }[];
  /** id человеческой записи, если она нашлась; null — заливку никто не записал. */
  matchedRefillId: string | null;
}

/**
 * Журнал заливок за окно ВМЕСТЕ с признаком обрезки.
 *
 * `capped` — «ответ упёрся в потолок строк»: показан свежий хвост окна, а не
 * всё окно. Без этого признака лист печатал бы предел (`LIST_LIMIT`) как
 * посчитанный итог — ровно та молчаливая ложь, которую соседний лист истории
 * склада уже называет словами (`history_capped`).
 */
export interface VendingRefillEvents {
  rows: VendingRefillEvent[];
  capped: boolean;
}

/** Строка прайса вендинга с правилами закупа — для листа «Правила закупа». */
export interface VendingProductRow {
  id: string;
  name: string;
  category: "drink" | "snack" | "other";
  purchasePrice: number | null;
  /**
   * Эталон витрины — слово владельца о том, почём товар должен продаваться
   * (`vending_product.sale_price`, R-P5b-6). `null` — эталон не задан, и это
   * НЕ ноль: сравнивать факт не с чем. Пишет только бот.
   */
  salePrice: number | null;
  packSize: number;
  isActive: boolean;
  excludedFromPurchase: boolean;
  fixedPurchaseQty: number | null;
  /** Фискальный блок карточки снека (П6). Форма — `ProductFiscalForm`. */
  fiscal: ProductFiscal;
}

/** Итог правки правил закупа товара (П5a). */
export interface VendingRulesResult {
  ok: boolean;
  reason?: "not_found";
  /** Каноническое имя товара (после алиасов). */
  product?: string;
}

/** Итог правки фискального блока карточки снека (П6). */
export type VendingFiscalResult =
  | { ok: true; product: string; readyBefore: boolean; readyAfter: boolean }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "invalid"; errors: string[] };

/** Итог отправки закупа на утверждение владельцу (§5.7). */
export interface VendingSubmitResult {
  submitted: boolean;
  /** id созданной заявки (когда submitted). */
  approvalId?: string;
  positions: number;
  costRounded: number;
  /** Почему не отправили (когда !submitted). */
  reason?: string;
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

/**
 * Запуск сбора Ourvend — когда собирали и с каким итогом.
 *
 * Это ТА ЖЕ строка `vending_sync_run`, что отдаёт `/ourvend/health` в
 * `OurvendHealth.runs`, поэтому здесь алиас общего типа, а не четвёртая копия
 * восьми полей: `/vending/sync` и здоровье сбора обязаны показывать один
 * статус одного прогона.
 */
export type VendingSyncRun = OurvendSyncRun;

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
  /**
   * Цена за грамм, сум — сначала карточка ингредиента через мост, запасной
   * путь `purchase_price`. null — ни то, ни другое цены не дало, себестоимость
   * расхода не считается.
   */
  purchasePrice: number | null;
  /** Карточка ингредиента в реестре (мост). null — ингредиент с реестром не связан. */
  entityId: string | null;
  /** Откуда взята `purchasePrice`. null — цены нет вовсе. */
  priceSource: "карточка" | "реестр" | null;
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

/**
 * Норма против факта по периодам бункера (срез F). `полнота` — шкала
 * доверия (см. `bunkerPeriod()` в `@mydon/shared`): `разница` заполнена
 * ТОЛЬКО при `полнота === "полный"`, иначе `null` — это не баг экрана, а
 * главное правило среза (R-F2), уже решённое в ядре.
 *
 * `полнота` здесь ýже, чем `Coverage` в ядре: `NormFactService` строит
 * `тараОткалибрована` из калибровки тары (`fillNet`/`returnNet` не `null`),
 * поэтому `залито`/`возвращено` у него никогда не `null`, когда флаг `true` —
 * причины «нет заливки»/«нет возврата» этим конкретным эндпоинтом физически
 * не выдаются (ревью 1.4). Полный список — в `bunkerPeriod()`, если завести
 * второго вызывающего с другой сборкой входа.
 *
 * «Нет тары» раньше называлось «нет размещения» и врало: к `machine_placement`
 * та проверка не относилась никогда. Настоящая проверка размещения — отдельное
 * состояние «размещение неполно» (ревью, блокер Б2).
 */
export interface NormFactPeriodRow {
  machineId: string;
  locationName: string | null;
  position: number;
  ingredientId: string | null;
  ingredientName: string | null;
  from: string;
  to: string;
  залито: number;
  возвращено: number;
  факт: number;
  норма: number | null;
  чашек: number;
  /** Из `чашек` — сколько не дали вклада в `норма` (ревью 1.1/1.2): товар не опознан, состав не разобран, или единица — не граммы. */
  чашекБезНормы: number;
  полнота: "полный" | "позиция неоднозначна" | "тара не откалибрована" | "нет тары" | "размещение неполно" | "рецепт неизвестен" | "нормы нет";
  разница: number | null;
}

export interface NormFactReport {
  from: string;
  to: string;
  periods: NormFactPeriodRow[];
  итог: { факт: number; норма: number; разница: number; периодов: number };
  внеИтога: {
    периодов: number;
    причины: { причина: NormFactPeriodRow["полнота"]; периодов: number }[];
    /** Заливки/возвраты без пары — за всю историю, знаменатель «периодов» сам неполон (ревью 1.4). */
    непарныхЗаливок: number;
    непарныхВозвратов: number;
  };
  /** Расхождение `orderIsDelivered` (расход сырья) против `countable` (выручка) за окно — R-F5, видно числом. */
  расхождениеDeliveredCountable: number;
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
  /**
   * ДЕЙСТВУЮЩЕЕ значение с учётом фолбэков ядра — когда оно расходится с
   * `value` (R-FW-S5).
   *
   * Ровно один тумблер сегодня умеет расходиться: `OURVEND_ACCOUNTING_SOURCE`
   * без `STOCK_DATABASE_URL` действует как `own`, что бы ни было записано в
   * базе (`accounting-source.ts`). Панель, печатающая записанное значение,
   * говорила бы «учёт из зеркала» о системе, которая считает по своей базе.
   *
   * НЕОБЯЗАТЕЛЬНОЕ: у прочих ключей фолбэка нет, и Core их поле не шлёт —
   * отсутствие значит «действует то, что в `value`», а не «неизвестно».
   */
  effective?: string;
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

/**
 * Одна строка массового импорта банковской выписки (срез К, задача 4): вход
 * для `POST /finance/bank-statement`. Разбор строки — `parseBankStatement`
 * (`@mydon/shared`); сюда приходит уже готовый результат.
 */
export interface ImportBankStatementItem {
  /** Дата операции, ISO YYYY-MM-DD. */
  date: string;
  debit: number | null;
  credit: number | null;
  purpose?: string | null;
  /** Кассовый символ банка («0200» — взнос наличной выручки). */
  cashSymbol?: string | null;
  docNo?: string | null;
  /** Ключ идемпотентности — номер документа + дата (из разбора). */
  extId: string;
  fileRow?: number;
}

/** Строка отчёта импорта выписки, отклонённая с причиной. */
export interface ImportBankStatementRejection {
  extId: string;
  fileRow?: number;
  reason: string;
}

/** Отчёт массового импорта выписки — одинаковый и в dryRun, и в настоящем прогоне (R-D7). */
export interface ImportBankStatementReport {
  dryRun: boolean;
  created: number;
  /** Пропущено как повтор — запись с этим (source='bank', extId) уже существует. */
  skippedRepeat: number;
  rejected: ImportBankStatementRejection[];
}

/**
 * Один календарный месяц сверки кассы (R-K6). `status` — признак ДАННЫХ, не
 * разница: «одна сторона пуста» (`noWithdrawn`/`noDeposit`) — разрыв, стоящий
 * внимания; `empty` (обе пусты) — тихий месяц, а не недостача.
 */
export interface CashReconcilePeriod {
  /** YYYY-MM. */
  period: string;
  /** Сумма ТОЛЬКО известных (принятых) изъятий — ждущие приёма в неё не входят. */
  withdrawn: number;
  /** Число ПРИНЯТЫХ инкассаций месяца — ждущие приёма считаются отдельно в `withdrawnPending`. */
  withdrawnCount: number;
  /** Инкассаций месяца, ждущих приёма (сумма ещё не известна) — не входят ни в `withdrawn`, ни в `withdrawnCount`. */
  withdrawnPending: number;
  deposited: number;
  depositedCount: number;
  diff: number;
  /** `pendingReceipt` — все инкассации месяца ждут приёма: не `noWithdrawn` (отсутствие суммы — не отсутствие инкассации). */
  status: "ok" | "empty" | "noWithdrawn" | "noDeposit" | "pendingReceipt";
}

/** Сверка кассы за период (R-K6): изъято по системе (инкассации) против сдано в банк (символ 0200). */
export interface CashReconcileReport {
  from: string;
  to: string;
  /** Сумма ТОЛЬКО известных (принятых) изъятий. */
  withdrawn: number;
  /** Число ПРИНЯТЫХ инкассаций — ждущие приёма считаются отдельно в `withdrawnPendingCount`. */
  withdrawnCount: number;
  /** Инкассаций за весь период, ждущих приёма — не входят в `withdrawn`/`withdrawnCount`. */
  withdrawnPendingCount: number;
  /** false — за весь период не было ни одной инкассации (ни принятой, ни ждущей): `withdrawn: 0` тогда не сходимость, а отсутствие данных. */
  hasWithdrawn: boolean;
  deposited: number;
  depositedCount: number;
  hasDeposited: boolean;
  diff: number;
  /** Помесячно на весь запрошенный диапазон, включая месяцы без операций. */
  periods: CashReconcilePeriod[];
  /** Только периоды, где ровно ОДНА сторона пуста — то, что стоит смотреть в первую очередь. */
  gaps: CashReconcilePeriod[];
  /** Лаг изъятие→банк (2–7 дней) даёт ложные расхождения на границе месяцев — витрина обязана показать это предупреждение, а не молчать. */
  note: string;
}

/**
 * Строка реестра пробелов (срез К, задача 5): чего нельзя посчитать сейчас.
 * Поля английские (R-K10) — модуль новый, соседей вроде `collections` с
 * русскими ключами у него нет. Считается на чтении (R-K4): пустой список —
 * хорошая новость, а не ошибка.
 */
export interface Gap {
  /** Что именно нельзя посчитать. */
  topic: string;
  /** За какой период — если пробел привязан ко времени. */
  period: { from: string; to: string } | null;
  /** Каких данных не хватает — человеческим языком. */
  missing: string;
  /** Сколько стоит пробел, если это выразимо деньгами или штуками. */
  scale: string | null;
  /** Что сделать, чтобы закрылся. */
  action: string;
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

/** Сверка (R-K11): итог по автомату за весь запрошенный период. */
export interface ReconcileRow {
  machineId: string;
  имя: string | null;
  выручка: number;
  изъято: number;
  разница: number;
  доля: number | null;
  инкассаций: number;
  медианныйИнтервалДней: number | null;
  медианныйЛагДней: number | null;
  /** «Инкассаций нет вовсе» / «выручки нет» / «ждёт приёма» — пробел данных, не недостача; не входит в `итог`. */
  статус: "обычный" | "инкассаций нет вовсе" | "выручки нет" | "ждёт приёма";
}

/** Сверка (R-K11): один период между двумя соседними инкассациями на автомате. */
export interface ReconcileInterval {
  id: string;
  machineId: string;
  имя: string | null;
  с: string;
  по: string;
  дней: number;
  ожидалось: number;
  /** null — закрывающая период инкассация ещё «ждёт приёма» (сумма не введена), а не изъято 0. */
  изъято: number | null;
  /** null — как и `изъято`: делить не на что, раз само изъятое неизвестно. */
  разница: number | null;
  /** Доля расхождения от ожидаемого, % (изъято меньше ожидаемого — отрицательная). null, если ожидание было нулевым (делить не на что) либо изъятое ещё не известно. */
  доля: number | null;
  статус: "обычный" | "пробел в журнале" | "ждёт приёма";
}

/** Агрегат сверки — только по строкам со статусом «обычный» (правило считать сходимость живёт в Core, не на витрине). */
export interface ReconcileTotal {
  выручка: number;
  изъято: number;
  разница: number;
  доля: number | null;
  автоматов: number;
}

/** Что исключено из `итог` и почему — видно числом, а не молчанием. */
export interface ReconcileExcluded {
  автоматов: number;
  выручка: number;
}

export interface ReconcileResult {
  from: string;
  to: string;
  rows: ReconcileRow[];
  intervals: ReconcileInterval[];
  первыхИсключено: number;
  итог: ReconcileTotal;
  внеИтога: ReconcileExcluded;
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

/** Флаг срока годности партии: просрочено / истекает / в порядке / срока нет. */
export type ExpiryFlag = "expired" | "expiring" | "ok" | "none";

/** Партия сырья/товара с посчитанным остатком (леджер) и сроком годности. */
export interface StockBatchRow {
  id: string;
  ingredientId: string;
  ingredientName: string;
  warehouseId: string;
  warehouseName: string;
  batchCode: string | null;
  receivedOn: string;
  qtyReceived: number;
  unit: string;
  /** Остаток партии: qtyReceived минус сумма расходных движений с этим batchId. */
  remaining: number;
  /** Эффективный срок годности (ISO-дата) — явный или из норматива карточки. null — не посчитан. */
  expiry: string | null;
  flag: ExpiryFlag;
  opened: boolean;
  openedOn: string | null;
  supplierId: string | null;
  supplierName: string | null;
  /**
   * Имя поставщика, как его ввёл человек, — даже если карточка не нашлась
   * (см. `BatchRow.supplierRaw` в `apps/core/src/stock/stock.service.ts`).
   * Без него «не вводили» и «ввели с опечаткой» на экране не отличить.
   */
  supplierRaw: string | null;
  invoiceNo: string | null;
  invoiceDate: string | null;
  /**
   * Цена за единицу с НДС (срез D, Task 5) — как ввели в приходе, ручном или
   * импорте реестра. null — цену не вводили; не путать с ценой 0.
   */
  unitPriceGross: number | null;
  note: string | null;
  source: string;
}

/** Строка отчёта о сроках: партия плюс её место в очереди FEFO (какая уйдёт следующей). */
export interface ExpiryReportRow extends StockBatchRow {
  /** Порядковый номер в очереди списания среди партий того же ингредиента и склада. null — остаток исчерпан. */
  fefoOrder: number | null;
}

/** Отчёт «Сроки годности»: просрочено / истекает < 14 дней / в порядке / без срока. */
export interface ExpiryReport {
  asOf: string;
  thresholdDays: number;
  counts: Record<ExpiryFlag, number>;
  rows: ExpiryReportRow[];
}

/**
 * Одна строка массового импорта партий (срез D, задача 3): вход для
 * `POST /stock/batches/import`. Сопоставление карточки — забота витрины
 * (Task 2 `suggestCard`): сюда идёт уже готовый `ingredientId`, а строка без
 * подтверждённого сопоставления несёт `ingredientId: null`.
 */
export interface ImportBatchItem {
  /** Номер строки в исходном файле — для отчёта и (по умолчанию) ключа идемпотентности. */
  fileRow: number;
  /** Карточка сырья, подтверждённая на витрине; null — не сопоставлена (уйдёт в unmatched). */
  ingredientId: string | null;
  warehouseId: string;
  qtyReceived: number;
  unit: string;
  /** Дата прихода (R-D3); null — строка без даты (уйдёт в noDate, партия не создаётся). */
  receivedOn: string | null;
  supplier?: string | null;
  invoiceNo?: string | null;
  invoiceDate?: string | null;
  unitPriceGross?: number | null;
  note?: string | null;
  /** Имя строки — только для отчёта, если она не создаст партию. */
  name?: string | null;
  /** Ключ идемпотентности строки в паре с `source`; по умолчанию — String(fileRow) на сервере. */
  extId?: string | null;
}

/** Строка отчёта импорта без записи (без даты / не сопоставлена). */
export interface ImportBatchIssue {
  fileRow: number;
  name: string | null;
}

/** Строка отчёта импорта, отклонённая с причиной (R-D2 и другие ошибки валидации). */
export interface ImportBatchRejection extends ImportBatchIssue {
  reason: string;
}

/** Отчёт массового импорта партий — одинаковый и в dryRun, и в настоящем прогоне (R-D7). */
export interface ImportBatchesReport {
  dryRun: boolean;
  created: number;
  /** Сколько партий закрыто расходом (R-D1) и на какую дату — `closed: 0` при `created > 0` значит «партии открыты, остаток вырастет». */
  closed: number;
  closeOn: string | null;
  /** Пропущено как повтор — партия с этим (source, extId) уже существует. */
  skippedRepeat: number;
  noDate: ImportBatchIssue[];
  unmatched: ImportBatchIssue[];
  rejected: ImportBatchRejection[];
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
  /** План закупа «что купить»: закуп + раздача по маршруту и слотам (П5a). */
  vendingPlan: () => get<VendingPlan>("/vending/plan"),
  /**
   * Усушка автоматов по дням без заливок (П4). Окно — 7/14/30 суток: ядро
   * само зажимает значение, поэтому лист может звать его любым из трёх.
   */
  vendingShrinkage: (days = 14) => get<VendingShrinkageReport>(`/vending/shrinkage?days=${days}`),
  /**
   * Аналитика снек-контура (П5b). Окна зажимает ядро (маржа 1..90, сток 1..90,
   * цены 1..180) — панель зовёт их значениями своих переключателей.
   */
  vendingMargin: (days = 30) => get<MarginReport & WithWarnings>(`/vending/margin?days=${days}`),
  vendingDeadStock: (days = 21) => get<DeadStockReport & WithWarnings>(`/vending/dead-stock?days=${days}`),
  /** История пересчётов склада (П8a). Окно зажимает ядро: 1..730, дефолт 90. */
  vendingStockCounts: (days = 90, product?: string) =>
    get<StockCountsReport>(
      `/vending/stock-counts?days=${days}${product ? `&product=${encodeURIComponent(product)}` : ""}`,
    ),
  /** `monthly` — донорская динамика по месяцам, её просит только панель (R-P5b-5). */
  vendingPriceChanges: (days = 30) =>
    get<PriceChangesReport & { monthly: MonthlyPrice[] } & WithWarnings>(`/vending/price-changes?days=${days}`),
  /** Факт витрины против эталона владельца. Окно — своё, короткое (R-P5b-6). */
  vendingPriceGap: (days = 14) => get<PriceGapReport & WithWarnings>(`/vending/price-gap?days=${days}`),
  /** Здоровье сбора OurVend: прогоны, серия отказов, лаги снимков, паритет (R-P5b-8). */
  ourvendHealth: (runs = 20) => get<OurvendHealth>(`/ourvend/health?runs=${runs}`),
  /**
   * Серия зелёных дней паритета ПОФАКТОРНО, по дням (R-P8b-2, R-G-4).
   *
   * Роут отвечает `days[]` — пофакторный разбор 14 дней, которого в здоровье
   * нет и быть не должно. Счёт серии (`parityStreak`, `cutoverThreshold`) и
   * ОБЕ даты (`parityLastRed`, `parityStreakSince`) едут в `/ourvend/health`
   * — второй вызов за ними больше не нужен.
   */
  ourvendParityStreak: () => get<ParityStreak>("/ourvend/parity/streak"),
  /** Журнал детектора заливок: что автомат получил и была ли запись оператора. */
  /**
   * Журнал заливок. Ответ читается в ДВУХ формах намеренно: старый Core отдаёт
   * голый массив, новый — объект с признаком обрезки. Форму с провода никто не
   * валидирует, и жёсткое `ответ.rows` на откаченном образе ядра дало бы не
   * «лист без предупреждения», а 500 вместо листа.
   */
  vendingRefillEvents: async (days = 14): Promise<VendingRefillEvents> => {
    const ответ = await get<VendingRefillEvent[] | { rows?: VendingRefillEvent[]; capped?: boolean }>(
      `/vending/refill-events?days=${days}`,
    );
    if (Array.isArray(ответ)) return { rows: ответ, capped: false };
    return { rows: ответ.rows ?? [], capped: ответ.capped === true };
  },
  /** Прайс вендинга с правилами закупа — для листа «Правила закупа». */
  vendingProducts: () => get<VendingProductRow[]>("/vending/products"),
  /** Отправить актуальный закуп на утверждение владельцу (та же заявка, что из бота). */
  submitVendingPurchase: (createdBy: string) =>
    send<VendingSubmitResult>("/vending/purchase/submit", "POST", { createdBy }),
  /**
   * Правила закупа товара: блок / исключён / фикс-количество.
   * `fixedPurchaseQty: 0` — снять фикс (в базе NULL).
   */
  setVendingProductRules: (input: {
    product: string;
    packSize?: number;
    excludedFromPurchase?: boolean;
    fixedPurchaseQty?: number;
    actor?: string;
  }) => send<VendingRulesResult>("/vending/product-rules", "POST", input),
  /** Фискальный блок товара: пишет только панель, только по id карточки. */
  setVendingProductFiscal: (input: { productId: string; actor?: string } & ProductFiscalPatch) =>
    send<VendingFiscalResult>("/vending/product-fiscal", "POST", input),
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
  coffeeNormFact: (from: string, to: string) =>
    get<NormFactReport>(`/coffee/norm-fact?from=${from}&to=${to}`),
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
  /** Завести партию прихода (§4.3 + документ Р3/Р4) и связанное приходное движение. */
  createBatch: (input: Record<string, unknown>) => send<StockBatchRow>("/stock/batch", "POST", input),
  /** Список партий с остатком (леджер) и флагом срока; фильтры необязательны. */
  stockBatches: (params: { ingredientId?: string; warehouseId?: string; flag?: string } = {}) => {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== "")) as Record<
        string,
        string
      >,
    ).toString();
    return get<{ rows: StockBatchRow[] }>(`/stock/batches${qs ? `?${qs}` : ""}`);
  },
  /** Отчёт «Сроки годности»: просрочено/истекает/в порядке/без срока + очередь FEFO. */
  expiryReport: () => get<ExpiryReport>("/stock/expiry"),
  /** Отметить вскрытие партии. */
  openBatch: (id: string, input: Record<string, unknown> = {}) =>
    send<StockBatchRow>(`/stock/batch/${id}/open`, "POST", input),
  /**
   * Массовый импорт партий с предпросмотром (срез D, задача 3). До 500 строк;
   * `dryRun: true` ничего не пишет и возвращает тот же отчёт, что настоящий
   * прогон (R-D7). `closeOn` — дата инвентаризации: партии закрываются
   * расходом того же объёма, остаток ингредиента не задваивается (R-D1).
   */
  importBatches: (input: { source: string; dryRun?: boolean; closeOn?: string | null; items: ImportBatchItem[] }) =>
    send<ImportBatchesReport>("/stock/batches/import", "POST", input),
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
  /** Приём инкассации. `denominations` необязательна — сумма купюр должна совпасть с `amount`, иначе Core отказывает с обеими цифрами. */
  receiveCollection: (id: string, amount: number, denominations?: DenominationCounts) =>
    send<CollectionRow>(`/collections/${id}/receive`, "POST", {
      amount,
      manager: "owner",
      ...(denominations ? { denominations } : {}),
    }),
  cancelCollection: (id: string) =>
    send<CollectionRow>(`/collections/${id}/cancel`, "POST", { manager: "owner" }),
  /** Сверка по автоматам за период: наличная выручка против изъятого (R-K11). */
  reconcileCollections: (from: string, to: string) =>
    get<ReconcileResult>(`/collections/reconcile?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
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
      /**
       * ИСТОЧНИК ЧИТАЕМ (переопределено в П8b): в режиме `stock` — зеркало
       * задано, в режиме `own` — учётный снапшот свежий. Что именно чинить,
       * говорит `source` рядом.
       */
      configured: boolean;
      /**
       * Действующий источник учёта. НЕОБЯЗАТЕЛЬНОЕ: Core прошлой сборки поля
       * не шлёт, и «неизвестно» здесь — это `stock`, каким режим и был.
       */
      source?: "stock" | "own";
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
      /**
       * Источник учётного потока OurVend на стороне ядра
       * (`OURVEND_ACCOUNTING_SOURCE`): "stock" — зеркало базы mydon-stock,
       * "own" — собственный снимок. НЕОБЯЗАТЕЛЬНОЕ: ядро поле пока не отдаёт,
       * и до этого момента подпись частоты честно говорит про зеркало. Когда
       * отдаст — подпись переключится сама, без правки панели.
       */
      source?: "own" | "stock";
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
  /**
   * Массовый импорт банковской выписки с предпросмотром (срез К, задача 4).
   * `dryRun: true` ничего не пишет и возвращает тот же отчёт, что настоящий
   * прогон (R-D7 среза D). Пишет в money_flow с source='bank'.
   */
  importBankStatement: (input: { dryRun?: boolean; items: ImportBankStatementItem[] }) =>
    send<ImportBankStatementReport>("/finance/bank-statement", "POST", input),
  /** Сверка кассы за период (R-K6): изъято по системе против сдано в банк (символ 0200), помесячно + разрывы. */
  cashReconcile: (from: string, to: string) =>
    get<CashReconcileReport>(`/finance/cash-reconcile?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  /**
   * Реестр пробелов (срез К, задача 5): что нельзя посчитать прямо сейчас,
   * вычисляется на каждом чтении (R-K4) — пустой массив здесь означает, что
   * всё, что можно посчитать, посчитано, а не что запрос сломан.
   */
  gaps: () => get<Gap[]>("/gaps"),

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
