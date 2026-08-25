import { BadRequestException, Inject, Injectable, Optional } from "@nestjs/common";
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import {
  approval,
  auditLog,
  entity,
  event,
  machineCard,
  machineSale,
  machineSlot,
  productSale,
  purchase,
  slotSnapshot,
  vendingAlias,
  vendingCashSession,
  vendingProduct,
  vendingPurchaseOrder,
  vendingStock,
  vendingSyncRun,
} from "@mydon/db";
import {
  MAX_CAPACITY,
  PRICE_SPIKE_PCT,
  TZ,
  allocateByRoute,
  allocateBySlots,
  computePurchase,
  computePurchaseCash,
  deadMachine,
  machineDeficit,
  machineSerialKeys,
  machineStatusLabel,
  needByProduct,
  normalizeMachineSerial,
  normalizeProductName,
  planogramStatus,
  priceDeviationPct,
  routeIssuesFrom,
  routeOrderFrom,
  runoutForecast,
  slotValid,
  type CashCategoryInput,
  type MachineSlots,
  type PlanogramStatus,
  type PriceEntry,
  type ProductRule,
  type PurchaseCashSession,
  type PurchaseRow,
  type PurchaseSummary,
  type Runout,
  type RunoutInput,
  type Slot,
  type SlotPlanRow,
} from "@mydon/shared";
import { DB, type Db } from "../db/db.module";
import { ApprovalsService } from "../approvals/approvals.service";
import { settingValue } from "../system/settings";

/**
 * Вендинг: приём собранных данных и расчёт дефицита (ТЗ Фаза 1).
 *
 * Собранные Ourvend-коннектором слоты ложатся в `machine_slot` (актуальная
 * планограмма) и `slot_snapshot` (история). Дефицит и заполненность считает
 * стек-независимое ядро `@mydon/shared` (сверено с контрольным примером) — здесь
 * только чтение строк базы и раскладка в форму ядра. Закуп со складом — Фаза 3
 * (в mydon пока нет остатка склада по товарам).
 */

export interface IngestSlotInput {
  coilId: string;
  product: string;
  capacity: number;
  quantity: number;
}
export interface IngestMachineInput {
  serial: string;
  alias?: string;
  slots: IngestSlotInput[];
}
export interface IngestPayload {
  /** Момент съёма (ISO). Пусто → сейчас. */
  capturedAt?: string;
  machines: IngestMachineInput[];
}

/**
 * Потолок слотов на один автомат.
 *
 * Число с запасом к натуре: самый крупный автомат парка отдаёт 488 позиций
 * (`Olma Администрация · снек` — Ourvend возвращает слоты всех шкафов сразу,
 * `boxId` уходит пустым). Смысл потолка — не отсечь большой автомат, а поймать
 * заведомо испорченный ответ вендора, поэтому он вчетверо выше факта.
 *
 * Проверка живёт ЗДЕСЬ, а не в валидаторе DTO, осознанно: валидатор отклоняет
 * запрос целиком, и одна разросшаяся машина уносила приём всех остальных.
 */
export const MAX_SLOTS_PER_MACHINE = 2000;

/** Автомат, пропущенный при приёме, и почему. */
export interface SkippedMachine {
  serial: string;
  slots: number;
  reason: string;
}

export interface IngestSlotsResult {
  /** Сколько автоматов принято (без пропущенных). */
  machines: number;
  slots: number;
  /** Из принятых — сколько удалось привязать к карточке реестра. */
  linked: number;
  /** Слотов убрано как исчезнувших из автомата. */
  pruned: number;
  /**
   * Автоматы, у которых уборка не удалась.
   *
   * Не ошибка приёма: снимок записан, планограмма свежая. Но и не пустяк —
   * в зеркале остались лишние строки, и молчать об этом нельзя.
   */
  pruneErrors: { serial: string; error: string }[];
  skipped: SkippedMachine[];
}

export interface MachineDeficitRow {
  serial: string;
  status: PlanogramStatus;
  deficit: number;
  capacity: number;
  filled: number;
  fillRate: number;
  slots: number;
}

/** Итог запуска сбора, который сообщает коллектор при завершении. */
export interface SyncFinishInput {
  status: "success" | "partial" | "failed";
  machinesTotal: number;
  machinesOk: number;
  durationMs: number;
  error?: string;
}

export interface SyncRunRow {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "success" | "partial" | "failed";
  machinesTotal: number;
  machinesOk: number;
  error: string | null;
  durationMs: number | null;
}

/** Продажи, собранные коллектором за окно (для прогноза расхода). */
export interface IngestProductSaleInput {
  serial: string;
  product: string;
  quantity: number;
}
export interface IngestMachineSaleInput {
  serial: string;
  totalAmount: number;
  totalCount: number;
}
export interface IngestSalesPayload {
  /** Момент съёма (ISO). Пусто → сейчас. */
  capturedAt?: string;
  /** Начало окна продаж (ISO). */
  periodStart: string;
  /** Конец окна продаж (ISO). */
  periodEnd: string;
  productSales: IngestProductSaleInput[];
  machineSales: IngestMachineSaleInput[];
}

/** Порядок статусов в отчёте: ok выше, некалиброванные/без слотов — в конце. */
function statusRank(s: PlanogramStatus): number {
  return s === "ok" ? 0 : 1;
}

/** Инвентаризация склада: остаток по товару на момент пересчёта (§5.4). */
export interface IngestStockItemInput {
  product: string;
  quantity: number;
}
export interface IngestStockPayload {
  /** Момент пересчёта (ISO). Пусто → сейчас. */
  countedAt?: string;
  items: IngestStockItemInput[];
}

/** Строка остатка склада для панели/отчётов. */
export interface StockLevelRow {
  product: string;
  /** Карточка прайса, если имя строки известно справочнику (бэкфилл П4). */
  productId: string | null;
  quantity: number;
  countedAt: string;
}

/**
 * Расхождение при пересчёте склада: было → стало. `delta < 0` — недостача
 * (потеря), `delta > 0` — излишек. `value` — |delta| × закупочная цена, сум;
 * `noPrice` — цены нет в прайсе, `value` тогда 0 и деньгам доверять нельзя.
 */
export interface StockAdjustment {
  product: string;
  before: number;
  after: number;
  delta: number;
  value: number;
  noPrice: boolean;
}

/** Итог инвентаризации: сколько позиций приняли и что разошлось с учётом. */
export interface IngestStockResult {
  items: number;
  adjustments: StockAdjustment[];
}

/** Минимум, нужный сервису от очереди согласований — для подмены в тестах. */
export interface ApprovalRequester {
  request(input: {
    agent: string;
    action: string;
    tier: "T0" | "T1" | "T2" | "T3" | "T4";
    payload?: Record<string, unknown>;
  }): Promise<{ id: string }>;
}

/** Накладная закупа для списка (панель/бот). */
export interface PurchaseOrderRow {
  id: string;
  approvalId: string;
  status: "approved" | "ordered" | "received" | "cancelled";
  positions: number;
  totalOrder: number;
  costRounded: number;
  createdBy: string | null;
  createdAt: string;
  /** Заполнены только после приёмки (§5.7) — до неё null. */
  distributedUnits: number | null;
  receivedAt: string | null;
  receivedBy: string | null;
  unmatchedDistribution: string[] | null;
}

/** Касса закупа для ответа/списка — снимок §5.8 + кто и когда записал. */
export interface CashSessionRow extends PurchaseCashSession {
  id: string;
  createdBy: string | null;
  createdAt: string;
}

/** Итог приёмки накладной на склад. */
export interface ReceiveOrderResult {
  received: boolean;
  /** id принятой накладной (когда received). */
  orderId?: string;
  /** Сколько позиций легло на склад (toWarehouse > 0). */
  replenished: number;
  /** Зачислено на склад — Σ (order − распределено) по позициям. */
  units: number;
  /** Распределено сразу по автоматам, не зачислено на склад (§5.7). */
  distributedUnits: number;
  /**
   * Товары из `distributed`, для которых не нашлось позиции в накладной —
   * распределение по ним НЕ учтено, вся сумма ушла на склад молча, если не
   * показать это владельцу (найдено адверсариал-ревью).
   */
  unmatchedDistribution: string[];
  /**
   * Строк записано в журнал прихода (таблица purchase, source='vending-order').
   * Мост П3: после отключения синка mydon-stock журнал прихода и сводку
   * снабжения кормят сами накладные.
   */
  recordedPurchases?: number;
  /** Почему не приняли (когда !received). */
  reason?: string;
}

/** Итог правки закупочной цены товара (команда «цена …» из бота/панели). */
export interface SetPriceResult {
  ok: boolean;
  /** Каноническое имя товара (после алиасов). */
  product?: string;
  oldPrice?: number | null;
  newPrice?: number;
  /**
   * Гейт цены: отклонение от текущей больше порога — нужна повторная
   * команда с подтверждением (confirmed=true).
   */
  deviationPct?: number;
  reason?: "not_found" | "spike";
}

/** Итог отправки закупа на утверждение. */
export interface SubmitPurchaseResult {
  submitted: boolean;
  /** id созданной заявки (когда submitted). */
  approvalId?: string;
  positions: number;
  costRounded: number;
  /** Почему не отправили (когда !submitted). */
  reason?: string;
}

/**
 * Склад считается устаревшим для плана, если САМАЯ СТАРАЯ строка остатка
 * старше стольких дней (спека П5a §6). Смысл — не «дата некрасивая», а «числа
 * плана врут»: закуп вычитает из потребности остаток, которого на полке может
 * уже не быть.
 */
export const STOCK_STALE_DAYS = 3;

/**
 * Продажи считаются несвежими для плана, если самый свежий собранный батч
 * старше стольких суток. Смысл тот же, что у склада: «нет продаж» выбрасывает
 * позицию из закупа целиком (§5.5), и если продажи просто давно не собирали,
 * это решение принято на пустом месте.
 */
export const SALES_STALE_DAYS = 2;

/** Автомат в плане закупа: сколько везём и как это ложится по слотам. */
export interface PlanMachine {
  serial: string;
  name: string;
  /** Место в маршруте обхода, с 1. */
  routeIndex: number;
  need: number;
  fromPurchase: number;
  fromStock: number;
  unfilled: number;
  slots: SlotPlanRow[];
}

/** Предупреждение плана: то, из-за чего числам можно верить не полностью. */
export interface PlanWarning {
  code:
    | "stock_stale"
    /** Строки склада, которых нет в прайсе: в расчёт не вошли (C2). */
    | "stock_unknown_product"
    | "machine_skipped"
    | "no_price"
    | "unknown_product"
    /** Самый свежий батч продаж старше SALES_STALE_DAYS — «нет продаж» может врать (I3). */
    | "sales_stale"
    /** В батче продаж автоматов меньше, чем в расчёте (I3). */
    | "sales_partial"
    /** В настройке маршрута есть серийники, которых нет среди автоматов (A4/UX#16). */
    | "route_unknown_serial";
  message: string;
}

/** План закупа «что купить»: закуп + раздача по маршруту и слотам (П5a). */
export interface PurchasePlan {
  /** Когда посчитан (ISO) — план живёт ровно до следующего сбора. */
  generatedAt: string;
  stock: {
    /** Последняя инвентаризация (ISO) или null, если склада ещё не было. */
    asOf: string | null;
    totalBefore: number;
    /** Уйдёт со склада в автоматы. */
    use: number;
    /** Вернётся на склад из закупа (излишек упаковки). */
    back: number;
    totalAfter: number;
    stale: boolean;
    /**
     * Штуки на складе, которые в расчёт НЕ вошли: строки без карточки прайса
     * (их имя не резолвится ни в товар, ни в алиас). В `totalBefore` не
     * входят — иначе «станет N» не сходилось бы с арифметикой плана.
     */
    unmatched: number;
  };
  summary: PurchaseSummary;
  machines: PlanMachine[];
  /** Порядок обхода задан настройкой (а не по имени автомата). */
  routeConfigured: boolean;
  warnings: PlanWarning[];
}

/** Строка прайса вендинга с правилами закупа — для редактора панели. */
export interface VendingProductRow {
  id: string;
  name: string;
  category: "drink" | "snack" | "other";
  purchasePrice: number | null;
  packSize: number;
  isActive: boolean;
  excludedFromPurchase: boolean;
  fixedPurchaseQty: number | null;
}

/** Что можно поменять в правилах закупа товара. */
export interface ProductRulesPatch {
  packSize?: number;
  excludedFromPurchase?: boolean;
  /** 0 — снять фикс-количество (в базе NULL). */
  fixedPurchaseQty?: number;
}

/** Итог правки правил закупа товара. */
export interface SetRulesResult {
  ok: boolean;
  reason?: "not_found";
  /** Каноническое имя товара (после алиасов). */
  product?: string;
  before?: Partial<VendingProductRow>;
  after?: Partial<VendingProductRow>;
}

/** Строка прайса вендинга, как её читает `loadProductIndex`. */
interface ProductIndexRow {
  id: string;
  name: string;
  category: "drink" | "snack" | "other";
  purchasePrice: string | null;
  packSize: number;
  excludedFromPurchase: boolean;
  fixedPurchaseQty: number | null;
}

/** Карточка автомата реестра в том виде, в каком её читают карты серийников. */
interface MachineEntityRow {
  id: string;
  name: string;
  externalRef: string | null;
  type: string;
}

/** Карты реестра автоматов: по любой форме серийника и по канону. */
export interface MachineIndex {
  /** Серийник в ЛЮБОЙ форме («c2508160376» и «2508160376») → карточка. */
  idBySerial: Map<string, string>;
  /** Канон серийника → имя автомата. */
  nameBySerial: Map<string, string>;
  /** Канон серийника → карточка, победившая при дублях (у неё берут и состояние). */
  firstIdBySerial: Map<string, string>;
}

/** Остаток склада строкой: имя, штуки и когда считали. */
interface StockRow {
  product: string;
  quantity: number;
  countedAt: Date;
}

/**
 * Общая часть закупа и плана: и `/vending/purchase`, и `/vending/plan` считают
 * одни и те же числа по одной выборке — иначе панель и бот показали бы разное.
 */
interface PurchaseContext {
  summary: PurchaseSummary;
  /** Автоматы в строю с ok-планограммой; имена товаров уже в каноне. */
  ok: MachineSlots[];
  /** Имя автомата по серийнику слотов; без карточки реестра — сам серийник. */
  nameBySerial: Map<string, string>;
  /**
   * Автоматы со слотами, выброшенные из расчёта, и почему. `reason` — готовая
   * человеческая причина: «не в строю» и «нет данных» это разные вещи, и
   * сводить их к одному `status` значило бы врать в предупреждении плана.
   */
  skipped: { serial: string; name: string; status: string; reason: string }[];
  /** Строки склада, чьё имя резолвится в товар прайса (имя — уже канон). */
  stockRows: StockRow[];
  /** Строки склада без карточки прайса: в расчёт не вошли, но молчать о них нельзя. */
  unmatchedStock: StockRow[];
  /** Канон-имена из слотов с дефицитом, которых нет в прайсе вендинга. */
  unknownProducts: string[];
  /** Свежесть и полнота батча продаж — от них зависит смысл «нет продаж». */
  sales: { capturedAt: Date | null; machinesInBatch: number; okMachines: number };
}

@Injectable()
export class VendingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(ApprovalsService) private readonly approvals?: ApprovalRequester,
  ) {}

  /**
   * Карта «серийник → карточка автомата» по обеим формам написания.
   *
   * Реестр хранит снековые серийники с приставкой («c2508160376»), Ourvend
   * присылает без неё. Кладём в карту оба ключа, чтобы найти автомат по любой
   * форме и не потерять сопоставления, работающие сегодня (см.
   * `machineSerialKeys` в `@mydon/shared`).
   */
  private async machineIdBySerial(): Promise<Map<string, string>> {
    return (await this.machineIndex()).idBySerial;
  }

  /**
   * Карточки автоматов реестра — ОДНОЙ выборкой на вызывающего.
   *
   * Фильтр по типу в запросе (индекс `entity_org_type_idx`): реестр держит все
   * карточки направлений, и тянуть их целиком ради 26 автоматов значит платить
   * за чужие строки.
   */
  private async machineRows(): Promise<MachineEntityRow[]> {
    return this.db
      .select({ id: entity.id, name: entity.name, externalRef: entity.externalRef, type: entity.type })
      .from(entity)
      .where(eq(entity.type, "machine"));
  }

  /**
   * Карты реестра из готовых строк — ОДНО место, где живут договорённости о
   * дублях, иначе «первая карточка выигрывает» в двух реализациях разойдётся.
   */
  private serialMaps(rows: MachineEntityRow[]): MachineIndex {
    const idBySerial = new Map<string, string>();
    const nameBySerial = new Map<string, string>();
    const firstIdBySerial = new Map<string, string>();
    for (const r of rows) {
      for (const key of machineSerialKeys(r.externalRef)) {
        // Первая карточка выигрывает: дубли по одному серийнику — вопрос к
        // реестру (docs/REGISTRY_CLEANUP.md), молча перезаписывать не надо.
        if (!idBySerial.has(key)) idBySerial.set(key, r.id);
      }
      if (r.type !== "machine" || !r.externalRef) continue;
      const canon = normalizeMachineSerial(r.externalRef);
      // Дубль карточки по одному серийнику — первая выигрывает ЦЕЛИКОМ, и имя,
      // и состояние. Врозь это уже опасно: имя брали у первой, а состояние — у
      // последней, и забытая карточка-дубль со «списан» молча убирала живой
      // автомат из закупа, где предупреждений не видно.
      if (firstIdBySerial.has(canon)) continue;
      firstIdBySerial.set(canon, r.id);
      nameBySerial.set(canon, r.name);
    }
    return { idBySerial, nameBySerial, firstIdBySerial };
  }

  /**
   * Убрать слоты, которых в автомате больше нет.
   *
   * `machine_slot` — зеркало, а зеркало обязано уметь сокращаться. Upsert
   * только добавляет и обновляет, поэтому исчезнувший слот оставался в
   * планограмме навсегда: у `2508160376` так накопилось 445 несуществующих
   * позиций, и автомат показывал 488 слотов вместо сорока трёх.
   *
   * Каждый автомат убирается СВОИМ запросом, вне общей транзакции и вне общего
   * try: сбой на одном не должен лишать уборки остальных и уж тем более
   * откатывать записанный снимок.
   *
   * Пустой список — НЕ повод стирать планограмму: это чаще всего сбой
   * выгрузки, а не автомат, из которого вынули все пружины. Стирать по
   * молчанию источника — способ потерять данные без единой ошибки.
   */
  private async pruneVanishedSlots(
    machines: IngestMachineInput[],
  ): Promise<{ pruned: number; pruneErrors: { serial: string; error: string }[] }> {
    let pruned = 0;
    const pruneErrors: { serial: string; error: string }[] = [];
    for (const m of machines) {
      if (m.slots.length === 0) continue;
      try {
        // notInArray, а не сырой `<> all(...)`: Drizzle разворачивает JS-массив
        // в список плейсхолдеров `($2, $3, …)`, и Postgres отвергает такой
        // запрос — `all()` ждёт массив, а не строковое выражение. Поймано в
        // бою: приём слотов отвечал 500, сбор Ourvend падал целиком.
        const живые = m.slots.map((s) => s.coilId);
        const убрано = await this.db
          .delete(machineSlot)
          .where(and(eq(machineSlot.machineSerial, m.serial), notInArray(machineSlot.coilId, живые)))
          .returning({ id: machineSlot.id });
        pruned += убрано.length;
      } catch (err) {
        pruneErrors.push({
          serial: m.serial,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { pruned, pruneErrors };
  }

  /**
   * Принять собранные слоты: upsert актуальной планограммы + запись в историю.
   * Идемпотентно по (serial, coil): повторный сбор обновляет слот, а не плодит.
   *
   * Автомат с неправдоподобным числом слотов пропускается, а не роняет приём:
   * раньше потолок стоял валидатором на входе, и одна разросшаяся машина
   * отменяла приём всех остальных (у `Olma Администрация · снек` уже 488 при
   * прежнем лимите 500). Пропущенные возвращаются вызывающему — сбор запишет
   * их в итог прогона, чтобы пропажа была видна, а не тиха.
   */
  async ingestSlots(payload: IngestPayload): Promise<IngestSlotsResult> {
    const capturedAt = payload.capturedAt ? new Date(payload.capturedAt) : new Date();
    const bySerial = await this.machineIdBySerial();
    // Бэкфилл `product_id` (П4, гигиена): `machine_slot` хранит ИМЯ как в
    // Ourvend, и до сих пор ссылка на карточку прайса была NULL у всех 210
    // строк. Товар переименуют в справочнике — и вся история слота потеряет
    // связь с карточкой, потому что связывало её только совпадение строк.
    // Имя оставляем сырым (это по-прежнему «что показал автомат»), а ссылку
    // проставляем по канону через алиасы.
    const productIds = await this.productIdIndex();
    const skipped: SkippedMachine[] = [];
    const accepted = payload.machines.filter((m) => {
      if (m.slots.length <= MAX_SLOTS_PER_MACHINE) return true;
      skipped.push({ serial: m.serial, slots: m.slots.length, reason: "слишком много слотов" });
      return false;
    });
    let slots = 0;
    let linked = 0;

    // ШАГ 1 — ДАННЫЕ. Транзакция несёт только запись снимка.
    //
    // Уборка вынесена наружу осознанно. Раньше она шла здесь же, и упавший
    // DELETE откатывал вместе с собой INSERT: зеркало не просто не чистилось,
    // а переставало обновляться вовсе. Побочная функция утаскивала основную —
    // 07.08.2026 из-за одной ошибки в условии удаления сбор Ourvend не мог
    // записать ни одного слота.
    //
    // Порядок «сначала записать, потом убрать» тоже не случаен: уборка сносит
    // строки, которых НЕТ в снимке, поэтому только что записанные переживают
    // её при любом исходе.
    await this.db.transaction(async (tx) => {
      for (const m of accepted) {
        const machineId = bySerial.get(normalizeMachineSerial(m.serial)) ?? null;
        if (machineId !== null) linked += 1;
        for (const s of m.slots) {
          const isValid = s.capacity > 0 && s.capacity <= MAX_CAPACITY;
          const product = s.product.trim() || null;
          // Ссылку ставим и на конфликте: слот мог сменить товар, и старая
          // ссылка стала бы враньём. Неизвестное имя → NULL, а не «оставим
          // прежнюю» — молча оставленная чужая карточка хуже пустоты.
          const productId = product === null ? null : (productIds(product) ?? null);
          await tx
            .insert(machineSlot)
            .values({
              machineSerial: m.serial,
              machineId,
              coilId: s.coilId,
              productName: product,
              productId,
              capacity: s.capacity,
              quantity: s.quantity,
              isValid,
              syncedAt: capturedAt,
            })
            .onConflictDoUpdate({
              target: [machineSlot.machineSerial, machineSlot.coilId],
              // machineId обновляем тоже: карточка автомата могла появиться
              // позже слотов — так же, как это делает backfill в продажах.
              set: {
                machineId,
                productName: product,
                // Сменился товар в слоте — ссылка идёт за ним, включая NULL
                // (старая карточка стала бы враньём). Товар тот же — непустую
                // ссылку пустой не затираем: прайс мог переименовать карточку,
                // и резолвер вернёт null там, где связь есть и верна.
                productId: sql`case when excluded.product_name is distinct from ${machineSlot.productName}
                    then excluded.product_id
                    else coalesce(excluded.product_id, ${machineSlot.productId}) end`,
                capacity: s.capacity,
                quantity: s.quantity,
                isValid,
                syncedAt: capturedAt,
              },
              // Опоздавший снимок (capturedAt старше уже сохранённого syncedAt)
              // не должен откатывать актуальную планограмму назад (найдено
              // внешним аудитом, P2). slotSnapshot ниже — история, пишется
              // всегда, независимо от этого условия.
              // Дата — строкой ISO: сырой sql-фрагмент не знает тип колонки и
              // без этого сериализует Date через toString(), что Postgres не
              // парсит как часовой пояс (найдено при живом e2e-тесте на коффе-складе).
              where: sql`${machineSlot.syncedAt} <= ${capturedAt.toISOString()}`,
            });
          await tx.insert(slotSnapshot).values({
            machineSerial: m.serial,
            coilId: s.coilId,
            productName: product,
            capacity: s.capacity,
            quantity: s.quantity,
            capturedAt,
          });
          slots += 1;
        }
      }
    });
    // ШАГ 2 — ГИГИЕНА. Отдельно от данных и по автомату за раз.
    //
    // Сбой уборки больше не стоит нам снимка: он записывается событием и
    // возвращается вызывающему, а планограмма остаётся свежей.
    const { pruned, pruneErrors } = await this.pruneVanishedSlots(accepted);

    if (pruneErrors.length > 0) {
      await this.db.insert(event).values({
        source: "vending-ingest",
        type: "vending.slots.prune_failed",
        payload: { machines: pruneErrors },
      });
    }

    if (skipped.length > 0) {
      // Пропуск — не рядовое событие: планограмма автомата остаётся вчерашней,
      // и заправка поедет по устаревшим остаткам. Пишем в журнал событий, а не
      // только в ответ, чтобы след остался и без чтения логов агента.
      await this.db.insert(event).values({
        source: "vending-ingest",
        type: "vending.slots.skipped",
        payload: { machines: skipped, лимит: MAX_SLOTS_PER_MACHINE },
      });
    }
    return { machines: accepted.length, slots, linked, pruned, pruneErrors, skipped };
  }

  /** Актуальные слоты, сгруппированные по автомату, в форме ядра расчёта. */
  private async slotsByMachine(): Promise<Map<string, Slot[]>> {
    const rows = await this.db.select().from(machineSlot);
    const byMachine = new Map<string, Slot[]>();
    for (const r of rows) {
      const list = byMachine.get(r.machineSerial) ?? [];
      list.push({ coilId: r.coilId, product: r.productName, capacity: r.capacity, quantity: r.quantity });
      byMachine.set(r.machineSerial, list);
    }
    return byMachine;
  }

  /** Автоматы с дефицитом, заполненностью и статусом планограммы. */
  async machines(): Promise<MachineDeficitRow[]> {
    const byMachine = await this.slotsByMachine();
    const out: MachineDeficitRow[] = [...byMachine.entries()].map(([serial, slots]) => {
      const status = planogramStatus(slots);
      const d = machineDeficit(slots);
      return { serial, status, deficit: d.deficit, capacity: d.capacity, filled: d.filled, fillRate: d.fillRate, slots: slots.length };
    });
    // Единое правило сортировки (§8): статус, затем дефицит по убыванию.
    out.sort((a, b) => statusRank(a.status) - statusRank(b.status) || b.deficit - a.deficit);
    return out;
  }

  /**
   * Сводная потребность по товарам (только ok-автоматы), с разбивкой. Имена
   * слотов приводятся к канону через алиасы — иначе один и тот же товар,
   * записанный в разных автоматах разными Ourvend-именами, ложится двумя
   * отдельными позициями вместо одной (тот же приём, что в `purchase()`).
   */
  async deficitSummary(): Promise<{ product: string; total: number; perMachine: Record<string, number> }[]> {
    const { aliasByKey } = await this.loadProductIndex();
    const byMachine = await this.slotsByMachine();
    const ok = [...byMachine.entries()]
      .filter(([, slots]) => planogramStatus(slots) === "ok")
      .map(([machineId, slots]) => ({ machineId, slots: this.resolveSlots(slots, aliasByKey) }));
    const needs = needByProduct(ok);
    needs.sort((a, b) => b.total - a.total);
    return needs.map((n) => ({ product: n.product, total: n.total, perMachine: n.perMachine }));
  }

  // ── Продажи и прогноз расхода (§5.6) ──────────────────────────────────────
  // Продажи — история, а не upsert: каждый сбор пишет окно как есть. Прогноз
  // берёт САМЫЙ СВЕЖИЙ батч (одинаковый capturedAt), иначе перекрывающиеся
  // 7-дневные окна складывались бы и завышали продажи.

  /**
   * Принять собранные продажи (по товарам и по автоматам) за окно.
   *
   * Upsert по (автомат, товар, capturedAt) / (автомат, capturedAt) — не
   * plain insert: повторная доставка ТОГО ЖЕ батча (сеть оборвалась после
   * записи, коллектор ретраит) раньше создавала вторые строки с тем же
   * capturedAt, а `latestSold7()` суммирует ВЕСЬ самый свежий батч — продажи
   * и прогноз задваивались молча (найдено внешним аудитом, P1).
   */
  async ingestSales(payload: IngestSalesPayload): Promise<{ productRows: number; machineRows: number }> {
    const capturedAt = payload.capturedAt ? new Date(payload.capturedAt) : new Date();
    const periodStart = new Date(payload.periodStart);
    const periodEnd = new Date(payload.periodEnd);
    // Продажи Ourvend знали только серийник, поэтому вопрос «сколько принёс
    // ЭТОТ автомат» отвечался для mydon-stock и не отвечался для Ourvend.
    // Карта строится по обеим формам написания серийника (см. machineSerialKeys).
    const bySerial = await this.machineIdBySerial();
    await this.db.transaction(async (tx) => {
      for (const p of payload.productSales) {
        await tx
          .insert(productSale)
          .values({
            machineSerial: p.serial,
            machineId: bySerial.get(normalizeMachineSerial(p.serial)) ?? null,
            productName: p.product,
            periodStart,
            periodEnd,
            quantity: p.quantity,
            capturedAt,
          })
          .onConflictDoUpdate({
            target: [productSale.machineSerial, productSale.productName, productSale.capturedAt],
            // machineId обновляем тоже: карточка автомата могла появиться позже
            // продажи — так же, как это делает приём слотов и backfill в sale.
            set: {
              periodStart,
              periodEnd,
              quantity: p.quantity,
              machineId: bySerial.get(normalizeMachineSerial(p.serial)) ?? null,
            },
          });
      }
      for (const m of payload.machineSales) {
        await tx
          .insert(machineSale)
          .values({
            machineSerial: m.serial,
            machineId: bySerial.get(normalizeMachineSerial(m.serial)) ?? null,
            periodStart,
            periodEnd,
            totalAmount: m.totalAmount.toFixed(2),
            totalCount: m.totalCount,
            capturedAt,
          })
          .onConflictDoUpdate({
            target: [machineSale.machineSerial, machineSale.capturedAt],
            set: {
              periodStart,
              periodEnd,
              totalAmount: m.totalAmount.toFixed(2),
              totalCount: m.totalCount,
              machineId: bySerial.get(normalizeMachineSerial(m.serial)) ?? null,
            },
          });
      }
    });
    return { productRows: payload.productSales.length, machineRows: payload.machineSales.length };
  }

  /**
   * Продажи за 7 суток по товару из САМОГО СВЕЖЕГО батча (одинаковый
   * capturedAt) и только по ok-автоматах. Батч, а не сумма истории — иначе
   * перекрывающиеся 7-дневные окна складывались бы и завышали расход. Имя
   * приводится к канону через алиасы — иначе не сойдётся с потребностью
   * (`needByProduct`) и остатком склада, которые уже в каноне.
   */
  private async latestSold7(
    okSerials: Set<string>,
    aliasByKey: Map<string, string>,
  ): Promise<{ byProduct: Map<string, number>; capturedAt: Date | null; serials: Set<string> }> {
    const saleRows = await this.db.select().from(productSale);
    const latest = saleRows.reduce((max, r) => Math.max(max, r.capturedAt.getTime()), 0);
    const byProduct = new Map<string, number>();
    // Серийники батча нужны плану: «нет продаж» по автомату, которого в батче
    // вовсе не было, — это не «не продаётся», а «не собрали» (I3).
    const serials = new Set<string>();
    for (const r of saleRows) {
      if (r.capturedAt.getTime() !== latest) continue;
      if (!okSerials.has(r.machineSerial)) continue;
      serials.add(r.machineSerial);
      const name = this.resolveProduct(r.productName, aliasByKey);
      byProduct.set(name, (byProduct.get(name) ?? 0) + r.quantity);
    }
    return { byProduct, capturedAt: latest > 0 ? new Date(latest) : null, serials };
  }

  /**
   * Серийники ok-автоматов из готовой карты слотов.
   *
   * Полный автомат мёртвым НЕ считается: только что заправленный аппарат
   * стоит 5/5 по всем слотам, и выбрасывать его из плана значило бы врать
   * ровно про ту машину, которую только что обслужили (R-P4-4).
   */
  private okSerials(byMachine: Map<string, Slot[]>): Set<string> {
    return new Set(
      [...byMachine.entries()]
        // `!deadMachine` дублирует гейт планограммы (мёртвый ≥10 невалидных слотов никогда не `ok`) — оставлено ради читаемости условия.
        .filter(([, slots]) => planogramStatus(slots) === "ok" && !deadMachine(slots))
        .map(([serial]) => serial),
    );
  }

  /**
   * Прогноз «на сколько хватит» (§5.6). Остаток и продажи считаются по ОДНОМУ
   * множеству автоматов (только `ok`) — иначе прогноз занижается. Продажи —
   * из самого свежего собранного батча.
   */
  async forecast(criticalDays = 3): Promise<{ all: Runout[]; critical: Runout[] }> {
    const { aliasByKey } = await this.loadProductIndex();
    const byMachine = await this.slotsByMachine();
    const okSerials = this.okSerials(byMachine);

    // Остаток в машинах по товару (в каноне через алиасы): Σ quantity валидных
    // назначенных слотов ok-автоматов.
    const inByProduct = new Map<string, number>();
    for (const [serial, slots] of byMachine) {
      if (!okSerials.has(serial)) continue;
      for (const s of slots) {
        if (s.product && slotValid(s)) {
          const name = this.resolveProduct(s.product, aliasByKey);
          inByProduct.set(name, (inByProduct.get(name) ?? 0) + s.quantity);
        }
      }
    }

    const { byProduct: soldByProduct } = await this.latestSold7(okSerials, aliasByKey);

    // Прогнозируем то, что сейчас загружено в автоматы.
    const input: RunoutInput[] = [...inByProduct.entries()].map(([product, inMachines]) => ({
      product,
      inMachines,
      sold7: soldByProduct.get(product) ?? 0,
    }));
    return runoutForecast(input, criticalDays);
  }

  // ── Склад: инвентаризация и остаток (§5.4) ────────────────────────────────
  // Остаток — текущий баланс, не леджер: пересчёт перезаписывает строку товара
  // (upsert по имени), как инвентаризация слотов автомата. Так закуп вычитает
  // реальный склад, а не «весь дефицит».

  /**
   * Индекс товаров, нужный при вводе склада: карта алиасов (нормализованное
   * имя-вариант → каноническое имя) и цены по канону — обе строятся из одной
   * загрузки `vending_product`, чтобы не делать два похода в базу.
   *
   * Алиасы: рукописные листы и заметки пишут товар по-разному («Montella»,
   * «18+», «Moxito клуб»); без карты остаток лёг бы отдельной «неопознанной»
   * строкой мимо расчёта закупа. Цены: нужны, чтобы оценить недостачу/излишек
   * при пересчёте в сумах, а не только в штуках.
   */
  private async loadProductIndex(): Promise<{
    aliasByKey: Map<string, string>;
    priceByName: Map<string, number>;
    packByName: Map<string, number>;
    rulesByName: Map<string, ProductRule>;
    /** Строки прайса как есть — чтобы искать карточку по канону имени без второго запроса. */
    productRows: ProductIndexRow[];
  }> {
    const [aliases, products] = await Promise.all([
      this.db.select().from(vendingAlias),
      this.db
        .select({
          id: vendingProduct.id,
          name: vendingProduct.name,
          category: vendingProduct.category,
          purchasePrice: vendingProduct.purchasePrice,
          packSize: vendingProduct.packSize,
          excludedFromPurchase: vendingProduct.excludedFromPurchase,
          fixedPurchaseQty: vendingProduct.fixedPurchaseQty,
        })
        .from(vendingProduct),
    ]);
    const nameById = new Map(products.map((p) => [p.id, p.name]));
    const aliasByKey = new Map<string, string>();
    for (const a of aliases) {
      const canonical = nameById.get(a.productId);
      if (canonical) aliasByKey.set(normalizeProductName(a.alias), canonical);
    }
    const priceByName = new Map<string, number>();
    const packByName = new Map<string, number>();
    // Правила закупа (П5a) — по канону имени: запись есть у КАЖДОГО товара
    // прайса, поэтому эта же карта отвечает на вопрос «товар вообще заведён?».
    const rulesByName = new Map<string, ProductRule>();
    for (const p of products) {
      if (p.purchasePrice != null) priceByName.set(p.name, Number(p.purchasePrice));
      packByName.set(p.name, p.packSize);
      rulesByName.set(p.name, { excluded: p.excludedFromPurchase, fixedQty: p.fixedPurchaseQty, pack: p.packSize });
    }
    return { aliasByKey, priceByName, packByName, rulesByName, productRows: products };
  }

  /**
   * Карточка прайса по имени — по НОРМАЛИЗОВАННОМУ ключу, среди уже
   * загруженных строк.
   *
   * `lower(name) = lower(canon)` в SQL промахивался мимо ровно тех имён, ради
   * которых заведён `normalizeProductName`: «Red  Bull» с двумя пробелами,
   * «ё» вместо «е», хвостовой пробел из копипасты. Владелец получал «товар не
   * найден» на товар, который в прайсе есть.
   */
  private findProductRow(canon: string, rows: ProductIndexRow[]): ProductIndexRow | undefined {
    const key = normalizeProductName(canon);
    return rows.find((p) => normalizeProductName(p.name) === key);
  }

  /**
   * Резолвер «сырое имя товара → id карточки прайса» (бэкфилл `product_id`).
   *
   * Один поход в базу на весь приём, дальше — по нормализованному ключу в
   * памяти: приём слотов кладёт сотни строк за раз, и SELECT на каждую был бы
   * N+1 на горячем пути крона. Неизвестное имя даёт `null` — новый товар не
   * повод отвергнуть снимок.
   */
  private productIdResolver(index: { aliasByKey: Map<string, string>; productRows: ProductIndexRow[] }): (raw: string) => string | null {
    const byKey = new Map(index.productRows.map((p) => [normalizeProductName(p.name), p.id]));
    return (raw: string) => byKey.get(normalizeProductName(this.resolveProduct(raw, index.aliasByKey))) ?? null;
  }

  /** То же, но когда прайс ещё не загружен вызывающим. */
  private async productIdIndex(): Promise<(raw: string) => string | null> {
    return this.productIdResolver(await this.loadProductIndex());
  }

  /**
   * Канон имени товара и его карточка — для тех, кто пишет в `vending_stock`
   * извне этого сервиса (заливка автомата).
   *
   * Публично именно потому, что канон один. `vending_stock` ключуется ИМЕНЕМ
   * товара, и запись мимо канона («кока кола» вместо «Coca-Cola 0.5») создаёт
   * вторую строку остатка, которую закуп никогда не сложит с первой.
   * Неизвестное имя возвращается как есть, обрезанным: новый товар — не повод
   * отказать сотруднику в записи факта.
   */
  async resolveProductRef(raw: string): Promise<{ name: string; productId: string | null }> {
    const trimmed = raw.trim();
    const { aliasByKey } = await this.loadProductIndex();
    const name = this.resolveProduct(trimmed, aliasByKey);
    const [hit] = await this.db
      .select({ id: vendingProduct.id })
      .from(vendingProduct)
      .where(eq(vendingProduct.name, name))
      .limit(1);
    return { name, productId: hit?.id ?? null };
  }

  /** Привести имя товара к канону через алиасы; неизвестное — как есть. */
  private resolveProduct(name: string, aliases: Map<string, string>): string {
    return aliases.get(normalizeProductName(name)) ?? name;
  }

  /**
   * Готовый резолвер «сырое имя → канон» для служб вендинга вне этого класса
   * (детектор заливок, П4).
   *
   * Отдаём ФУНКЦИЮ, а не карту: карта алиасов читается один раз на прогон, а
   * приводить к канону надо тысячи имён из снимков — `resolveProductRef` с её
   * походом в базу на каждое имя дала бы N+1. И, что важнее, канон здесь один
   * на всю систему: вторая реализация резолвера рано или поздно разошлась бы
   * с этой, и остаток склада перестал бы сходиться с историей автомата.
   */
  async canonResolver(): Promise<(raw: string) => string> {
    const { aliasByKey } = await this.loadProductIndex();
    return (raw: string) => this.resolveProduct(raw, aliasByKey);
  }

  /**
   * Канон имён и закупочные цены — ОДНОЙ загрузкой прайса (усушка, П4).
   *
   * Отчёту нужно и то, и другое: имена из снимков и продаж приводятся к
   * канону, а недостача считается в деньгах по `purchase_price`. Два вызова
   * (`canonResolver` + отдельная выборка цен) читали бы `vending_product` и
   * `vending_alias` дважды за прогон, а главное — цена и канон обязаны
   * приехать из ОДНОГО чтения: между двумя владелец успевает переименовать
   * товар, и позиция отчёта осталась бы без цены.
   */
  async priceIndex(): Promise<{ canonOf: (raw: string) => string; priceByName: Map<string, number> }> {
    const { aliasByKey, priceByName } = await this.loadProductIndex();
    return { canonOf: (raw: string) => this.resolveProduct(raw, aliasByKey), priceByName };
  }

  /**
   * Реестр автоматов для служб вендинга: карточка и имя по серийнику.
   *
   * `idBySerial` знает обе формы написания (с приставкой «c» и без — см.
   * `machineSerialKeys`), `nameBySerial` — по канону. Публично ровно затем,
   * чтобы детектор заливок брал ТУ ЖЕ привязку, что и приём слотов: две карты
   * «серийник → карточка» с разными правилами дали бы события, висящие мимо
   * автомата.
   */
  async machineIndex(): Promise<MachineIndex> {
    return this.serialMaps(await this.machineRows());
  }

  /** Слоты автомата с именем товара, приведённым к канону через алиасы. */
  private resolveSlots(slots: Slot[], aliases: Map<string, string>): Slot[] {
    return slots.map((s) => (s.product ? { ...s, product: this.resolveProduct(s.product, aliases) } : s));
  }

  /**
   * Принять инвентаризацию склада: перезапись остатка по каждому товару. Имена
   * приводятся к канону через алиасы — «склад Montella 24» ложится на
   * «Montella Вода минеральная 330ml», а не отдельной строкой мимо закупа.
   *
   * Пересчёт против ПРЕДЫДУЩЕГО остатка даёт недостачу/излишек — тот же
   * приём, что и в общей инвентаризации ингредиентов (`stock.service.stocktake`):
   * «было → стало» + дельта, оценённая по закупочной цене. Первый ввод по
   * товару (строки в складе ещё не было) сравнивать не с чем — не «недостача»,
   * а начало учёта, поэтому в adjustments не попадает.
   *
   * Позиции СХЛОПЫВАЮТСЯ по канону ДО расчёта расхождения (последняя в списке
   * побеждает) — иначе два алиаса одного товара в одной инвентаризации
   * («Montella pet 0.33» и «montella zero 0.33» → один канон) дали бы ДВЕ
   * дельты от одного и того же снимка «до», хотя реально сменилось только
   * конечное значение. Найдено адверсариал-ревью до релиза.
   */
  async ingestStock(payload: IngestStockPayload, actor = "owner"): Promise<IngestStockResult> {
    const countedAt = payload.countedAt ? new Date(payload.countedAt) : new Date();
    const { aliasByKey, priceByName, productRows } = await this.loadProductIndex();
    // Бэкфилл `product_id` (П4, гигиена): строка склада ключуется ИМЕНЕМ, и
    // все 20 строк жили без ссылки на карточку. Переименование товара в
    // справочнике рвало связь остатка с прайсом молча. Резолвер — тот же, что
    // у приёма слотов: две карты «канон → карточка» разошлись бы.
    const productIds = this.productIdResolver({ aliasByKey, productRows });

    // Схлопывание по канону — последняя позиция в списке побеждает (владелец
    // поправился по ходу диктовки/списка).
    const finalByProduct = new Map<string, number>();
    for (const it of payload.items) {
      const raw = it.product.trim();
      if (!raw) continue;
      finalByProduct.set(this.resolveProduct(raw, aliasByKey), it.quantity);
    }

    const adjustments: StockAdjustment[] = [];

    await this.db.transaction(async (tx) => {
      // Снимок остатка ДО пересчёта — одним запросом на всю инвентаризацию,
      // а не по товару в цикле: избегаем N+1 и читаем согласованный срез.
      const existingRows = await tx.select().from(vendingStock);
      const beforeByName = new Map(existingRows.map((r) => [r.productName, { quantity: r.quantity, countedAt: r.countedAt }]));

      for (const [product, quantity] of finalByProduct) {
        const prior = beforeByName.get(product);
        // Входящий пересчёт СТАРШЕ уже сохранённого — игнорируем позицию
        // целиком (и мнимую недостачу/излишек, и сам upsert): опоздавшее
        // сообщение коллектора иначе откатывает актуальный остаток назад
        // (найдено внешним аудитом, P2).
        if (prior && prior.countedAt.getTime() > countedAt.getTime()) continue;

        const before = prior?.quantity;
        if (before !== undefined && before !== quantity) {
          const delta = quantity - before;
          const price = priceByName.get(product);
          adjustments.push({
            product,
            before,
            after: quantity,
            delta,
            // Округляем до копеек: price — numeric(10,2), плюс IEEE-754 умножение
            // даёт «грязные» хвосты (2090.55×3 → 6271.499999999999) — без округления
            // они легли бы в неизменяемый журнал как есть (найдено адверсариал-ревью).
            value: price != null ? Math.round(Math.abs(delta) * price * 100) / 100 : 0,
            noPrice: price == null,
          });
        }

        // Имя строки склада — уже канон; резолвер прогоняет его через алиасы
        // повторно, и это безвредно: канон сам себе алиас.
        const productId = productIds(product);
        await tx
          .insert(vendingStock)
          .values({ productName: product, productId, quantity, countedAt, updatedAt: countedAt })
          .onConflictDoUpdate({
            target: [vendingStock.productName],
            set: {
              quantity,
              // НЕ затирать непустую ссылку пустой: строка склада ключуется
              // ИМЕНЕМ, и если карточку прайса переименовали, резолвер вернёт
              // null — прямая запись обнулила бы ровно ту связь, ради которой
              // бэкфилл и заводился. Новая ссылка (не null) перекрывает старую.
              productId: sql`coalesce(excluded.product_id, ${vendingStock.productId})`,
              countedAt,
              updatedAt: countedAt,
            },
            // Защита и от конкурентной транзакции с более новым пересчётом,
            // не только от порядка внутри этого вызова.
            // Дата — строкой ISO: сырой sql-фрагмент не знает тип колонки и
            // без этого сериализует Date через toString(), что Postgres не
            // парсит как часовой пояс (найдено при живом e2e-тесте на коффе-складе).
            where: sql`${vendingStock.countedAt} <= ${countedAt.toISOString()}`,
          });
      }

      if (adjustments.length > 0) {
        await tx.insert(event).values({
          // Тот же actor, что и в auditLog ниже — раньше здесь было жёстко "owner"
          // независимо от переданного actor (найдено адверсариал-ревью).
          source: actor,
          type: "vending.stock.recounted",
          payload: { adjustments, countedAt: countedAt.toISOString() },
        });
        await tx.insert(auditLog).values({
          actorKind: "human",
          actorRef: actor,
          action: "vending.stock.recount",
          after: { adjustments },
        });
      }
    });

    return { items: payload.items.length, adjustments };
  }

  /** Текущий остаток склада по товарам (для панели/отчётов). */
  async stockLevels(): Promise<StockLevelRow[]> {
    const rows = await this.db.select().from(vendingStock);
    return rows
      // `productId` в ответе — не украшение: связь строки склада с карточкой
      // прайса иначе не видна ниоткуда, и её потерю (бэкфилл П4) нечем поймать
      // ни панели, ни дымовому прогону.
      .map((r) => ({ product: r.productName, productId: r.productId, quantity: r.quantity, countedAt: r.countedAt.toISOString() }))
      .sort((a, b) => a.product.localeCompare(b.product, "ru"));
  }

  /**
   * Остаток склада строками — для расчёта закупа и для отметки «склад
   * устарел» в плане. Дата пересчёта нужна здесь же: закуп молча вычитает
   * остаток из потребности, и если ему месяц, план врёт без единого признака.
   */
  private async stockRows(): Promise<StockRow[]> {
    const rows = await this.db.select().from(vendingStock);
    return rows.map((r) => ({ product: r.productName, quantity: r.quantity, countedAt: r.countedAt }));
  }

  /**
   * Автоматы, о которых ТОЧНО известно, что они не в строю (machine_card.status
   * ≠ in_service), и имена по серийнику. Автомат без карточки/без записи в
   * реестре считается в строю (DEFAULT_MACHINE_STATUS): молчаливое исключение
   * опаснее лишней строки (R-P5a-4).
   *
   * Серийник — канон без «c» (normalizeMachineSerial), как у слотов Ourvend.
   *
   * Публично: тот же фильтр «в строю» применяет отчёт об усушке (П4). Своя
   * копия этого правила разошлась бы с планом закупа, и автомат в ремонте
   * тревожил бы владельца недостачей ровно тогда, когда его чинят.
   */
  async machineRegistry(): Promise<{
    notInService: Map<string, { name: string; status: string }>;
    nameBySerial: Map<string, string>;
  }> {
    const [{ nameBySerial, firstIdBySerial }, cards] = await Promise.all([
      this.machineIndex(),
      this.db.select({ entityId: machineCard.entityId, status: machineCard.status }).from(machineCard),
    ]);
    const statusById = new Map(cards.map((c) => [c.entityId, c.status]));
    const notInService = new Map<string, { name: string; status: string }>();
    for (const [serial, id] of firstIdBySerial) {
      const status = statusById.get(id) ?? "in_service";
      if (status !== "in_service") notInService.set(serial, { name: nameBySerial.get(serial) ?? serial, status });
    }
    return { notInService, nameBySerial };
  }

  /**
   * Настройка маршрута обхода: база важнее env, env важнее дефолта — тот же
   * резолвер, что у панели настроек, чтобы правка владельца работала сразу.
   */
  private async routeSetting(): Promise<string> {
    return settingValue(this.db, "VENDING_ROUTE_ORDER");
  }

  /**
   * Общая часть закупа и плана: одна выборка — одни числа (§5.4–5.5, П5a).
   *
   * Автоматы не в строю выкидываются ДО расчёта потребности и до продаж:
   * иначе закуп вёз бы товар на склад-«автомат» и в ремонт, а прогноз считал
   * бы продажи по другому множеству машин, чем слоты.
   */
  private async purchaseContext(): Promise<PurchaseContext> {
    const { aliasByKey, priceByName, packByName, rulesByName } = await this.loadProductIndex();
    const byMachine = await this.slotsByMachine();
    const { notInService, nameBySerial: nameByCanon } = await this.machineRegistry();

    // Пропущенные — только те, у кого реально были слоты: остальные в плане
    // никак не участвовали, и строка про них была бы шумом.
    const okSerials = this.okSerials(byMachine);
    const skipped: PurchaseContext["skipped"] = [];
    const skippedSeen = new Set<string>();
    for (const [serial, slots] of byMachine) {
      const canon = normalizeMachineSerial(serial);
      const off = notInService.get(canon);
      // Автомат-заглушка (ёмкости вне диапазона) выпадает из расчёта и по
      // `planogramStatus`, и по `deadMachine` — но молча: владелец видел бы
      // просто исчезнувшую строку плана. Причина «нет данных» и «не в строю» —
      // разные, и вторая не должна затирать первую. Гейта по `planogramStatus`
      // здесь нет намеренно: мёртвый автомат НИКОГДА не бывает `ok`, и такое
      // условие не сработало бы ни разу.
      const dead = !off && deadMachine(slots);
      if (!off && !dead) continue;
      okSerials.delete(serial);
      if (skippedSeen.has(canon)) continue;
      skippedSeen.add(canon);
      skipped.push(
        off
          ? { serial: canon, name: off.name, status: off.status, reason: `не в строю: ${machineStatusLabel(off.status)}` }
          : {
              serial: canon,
              name: nameByCanon.get(canon) ?? canon,
              status: "no_data",
              reason: "нет данных: ёмкости слотов вне диапазона (заглушка источника)",
            },
      );
    }

    const ok = [...byMachine.entries()]
      .filter(([serial]) => okSerials.has(serial))
      .map(([machineId, slots]) => ({ machineId, slots: this.resolveSlots(slots, aliasByKey) }));
    const needs = needByProduct(ok);
    const sold = await this.latestSold7(okSerials, aliasByKey);
    const soldByProduct = sold.byProduct;

    // Склад: имя строки приводим к канону тем же способом, что и слоты, и
    // делим строки на «есть карточка прайса» и «нет». Осиротевшая строка в
    // расчёт не идёт вовсе: у неё нет ни цены, ни кратности, ни правил, а
    // вычесть её из потребности значит молча поверить имени, которого система
    // не знает. Такие штуки план показывает отдельно (C2).
    const allStockRows = await this.stockRows();
    const stockRows: StockRow[] = [];
    const unmatchedStock: StockRow[] = [];
    for (const r of allStockRows) {
      const canon = this.resolveProduct(r.product, aliasByKey);
      (rulesByName.has(canon) ? stockRows : unmatchedStock).push({ ...r, product: canon });
    }
    const stockByProduct = new Map<string, number>();
    for (const r of stockRows) stockByProduct.set(r.product, (stockByProduct.get(r.product) ?? 0) + r.quantity);

    // Прайс: только позиции с ценой попадают в карту — иначе калькулятор
    // пометит noPrice и выведет их на разбор менеджеру (§5.5).
    const prices = new Map<string, PriceEntry>();
    for (const [name, price] of priceByName) {
      prices.set(name, { price, pack: packByName.get(name) ?? 1 });
    }

    const rows: PurchaseRow[] = needs.map((n) => ({
      product: n.product,
      perMachine: n.perMachine,
      need: n.total,
      stock: stockByProduct.get(n.product) ?? 0, // нет строки склада → 0 (закупаем весь дефицит)
      sold7: soldByProduct.get(n.product) ?? 0,
    }));
    const summary = computePurchase(rows, prices, { rules: rulesByName });

    // Товар из слота, которого нет в прайсе: ни цены, ни кратности, ни правил —
    // такому нужна карточка или алиас, молча считать его «обычным» нельзя.
    const unknownProducts = needs
      .map((n) => n.product)
      .filter((name) => !rulesByName.has(name))
      .sort((a, b) => a.localeCompare(b, "ru"));

    // Имя автомата — по серийнику слотов: реестр хранит канон, Ourvend может
    // прислать любую форму записи.
    const nameBySerial = new Map(
      ok.map((m) => [m.machineId, nameByCanon.get(normalizeMachineSerial(m.machineId)) ?? m.machineId] as const),
    );
    return {
      summary,
      ok,
      nameBySerial,
      skipped,
      stockRows,
      unmatchedStock,
      unknownProducts,
      sales: { capturedAt: sold.capturedAt, machinesInBatch: sold.serials.size, okMachines: okSerials.size },
    };
  }

  /**
   * Сводный закуп (§5.4–5.5): потребность автоматов В СТРОЮ − остаток склада,
   * округление до упаковок, суммы. Прайс, кратность и правила закупа — из
   * `vending_product` (не из кода), остаток — из `vending_stock`
   * (инвентаризация). Позиции без цены и без продаж калькулятор выносит
   * отдельно и в денежные итоги не включает.
   *
   * Имена слотов приводятся к канону через алиасы ДО расчёта потребности —
   * иначе один и тот же товар, записанный в разных автоматах разными
   * Ourvend-именами («Montella», «18+»), уходит в закуп двумя отдельными
   * позициями вместо одной (склад и продажи уже в каноне — `ingestStock`
   * и `latestSold7` резолвят его же картой алиасов, иначе позиции просто
   * не сойдутся друг с другом).
   *
   * Ответ аддитивно расширен раздачей (П5a) — прежние поля на месте.
   */
  async purchase(): Promise<PurchaseSummary> {
    return (await this.purchaseContext()).summary;
  }

  /**
   * План закупа «что купить» (П5a): тот же закуп плюс ответ на вопрос «куда
   * это поедет». Раздача идёт по маршруту обхода (первый автомат маршрута
   * получает закуп первым) и внутри автомата — по слотам, поэтому владелец
   * видит не только сумму, но и что реально встанет в аппарат.
   *
   * Предупреждения — часть плана, а не украшение: устаревший склад,
   * пропущенный автомат, товар без цены и товар без карточки меняют смысл
   * чисел, и молчать о них опаснее, чем показать лишнюю строку.
   */
  async plan(): Promise<PurchasePlan> {
    const ctx = await this.purchaseContext();
    const s = ctx.summary;
    const machines = ctx.ok.map((m) => ({ serial: m.machineId, name: ctx.nameBySerial.get(m.machineId) ?? m.machineId }));
    const setting = await this.routeSetting();
    const route = routeOrderFrom(setting, machines);
    const routeIssues = routeIssuesFrom(setting, machines);
    // Раздаём ВСЕ позиции с потребностью, включая «не закупать»: покупки по
    // ним нет, но склад в автоматы всё равно уезжает.
    const allItems = [...s.items, ...s.excludedByRule, ...s.excludedNoSales];
    const byMachine = allocateByRoute(allItems, route);
    const slotsBySerial = new Map(ctx.ok.map((m) => [m.machineId, m.slots]));
    const planMachines: PlanMachine[] = byMachine.map((a, i) => ({
      serial: a.serial,
      name: ctx.nameBySerial.get(a.serial) ?? a.serial,
      routeIndex: i + 1,
      need: a.need,
      fromPurchase: a.fromPurchase,
      fromStock: a.fromStock,
      unfilled: a.unfilled,
      slots: allocateBySlots(slotsBySerial.get(a.serial) ?? [], a),
    }));

    // `asOf` — «когда последний раз считали хоть что-то» (для показа).
    const asOf = ctx.stockRows.reduce<Date | null>((acc, r) => (!acc || r.countedAt > acc ? r.countedAt : acc), null);

    // А ДАВНОСТЬ — по строкам, которые план РЕАЛЬНО использует: остаток
    // товара, который сейчас уезжает в автоматы (`fromStock > 0`). Прежняя
    // проверка «по самой старой строке с остатком» горела почти всегда:
    // на складе десятки позиций, и одна забытая банка держала предупреждение
    // вечно — предупреждение, которое горит всегда, не читают. Если план не
    // берёт со склада ничего, смотрим все ненулевые строки (как раньше):
    // молчать в этом случае не на чем.
    const usedProducts = new Set(
      [...s.items, ...s.excludedByRule, ...s.excludedNoSales].filter((i) => i.fromStock > 0).map((i) => i.product),
    );
    const usedRows = ctx.stockRows.filter((r) => usedProducts.has(r.product));
    const watched = usedRows.length > 0 ? usedRows : ctx.stockRows.filter((r) => r.quantity > 0);
    const staleRows = watched
      .filter((r) => Date.now() - r.countedAt.getTime() > STOCK_STALE_DAYS * 86_400_000)
      .sort((a, b) => a.countedAt.getTime() - b.countedAt.getTime());
    const stale = asOf === null || staleRows.length > 0;
    const totalBefore = ctx.stockRows.reduce((a, r) => a + r.quantity, 0);

    const warnings: PlanWarning[] = [];
    if (stale) {
      const имена = staleRows.slice(0, 5).map((r) => r.product);
      const ещё = staleRows.length > имена.length ? ` и ещё ${staleRows.length - имена.length}` : "";
      warnings.push({
        code: "stock_stale",
        message:
          asOf === null
            ? "Склад ни разу не считали — план считает его пустым и покупает весь дефицит. " +
              "Обнови в боте: «склад Montella 24, Fanta 12»"
            : `Склад: ${staleRows.length} поз. старше ${STOCK_STALE_DAYS} дней (${имена.join(", ")}${ещё}) — ` +
              `обнови в боте: «склад ${имена[0] ?? "Montella"} 24»`,
      });
    }
    if (ctx.unmatchedStock.length) {
      // Строка склада без карточки прайса в расчёт не вошла: её остаток не
      // вычитается из потребности, и владелец купит второй раз то, что лежит.
      const шт = ctx.unmatchedStock.reduce((a, r) => a + r.quantity, 0);
      warnings.push({
        code: "stock_unknown_product",
        message:
          `На складе есть строки без карточки прайса (в расчёт не вошли, ${шт} шт): ` +
          `${ctx.unmatchedStock.map((r) => r.product).join(", ")} — переименуй в боте: «склад <канон> N»`,
      });
    }
    for (const m of ctx.skipped) {
      warnings.push({ code: "machine_skipped", message: `${m.name} (${m.serial}) ${m.reason}` });
    }
    if (s.noPrice.length) {
      warnings.push({
        code: "no_price",
        message: `Без цены (в сумму закупа не вошли): ${s.noPrice.join(", ")} — задай: «цена <товар> <сум за штуку>»`,
      });
    }
    if (ctx.unknownProducts.length) {
      warnings.push({
        code: "unknown_product",
        message:
          `Нет в прайсе вендинга: ${ctx.unknownProducts.join(", ")} — цена и блок не применятся, ` +
          "в сумму не войдут (карточку заводит администратор)",
      });
    }
    // Продажи: «нет продаж» выбрасывает позицию из закупа целиком, поэтому
    // несвежий или неполный батч меняет смысл половины плана (I3).
    if (ctx.sales.capturedAt === null) {
      warnings.push({
        code: "sales_stale",
        message: "Продажи ни разу не собирались — «нет продаж» стоит у всех позиций и закуп по ним не считается",
      });
    } else {
      // Порог — в миллисекундах, как у склада: округление до целых суток
      // ПЕРЕД сравнением теряло почти день (батч 2 дн. 23 ч считался свежим).
      // Показываем при этом целые сутки — «2,96 дн. назад» человек не читает.
      const возраст = Date.now() - ctx.sales.capturedAt.getTime();
      if (возраст > SALES_STALE_DAYS * 86_400_000) {
        const дней = Math.floor(возраст / 86_400_000);
        warnings.push({ code: "sales_stale", message: `Продажи собраны ${дней} дн. назад — «нет продаж» может быть ложным` });
      }
      if (ctx.sales.machinesInBatch < ctx.sales.okMachines) {
        warnings.push({
          code: "sales_partial",
          message:
            `В батче продаж ${ctx.sales.machinesInBatch} автоматов из ${ctx.sales.okMachines} — ` +
            "по остальным «нет продаж» ложное",
        });
      }
    }
    if (routeIssues.unknown.length) {
      warnings.push({
        code: "route_unknown_serial",
        message: `В настройке маршрута нет таких автоматов: ${routeIssues.unknown.join(", ")} — порядок взят по имени`,
      });
    }

    return {
      generatedAt: new Date().toISOString(),
      stock: {
        asOf: asOf?.toISOString() ?? null,
        totalBefore,
        use: s.totalFromStock,
        back: s.totalToStock,
        totalAfter: totalBefore - s.totalFromStock + s.totalToStock,
        stale,
        unmatched: ctx.unmatchedStock.reduce((a, r) => a + r.quantity, 0),
      },
      summary: s,
      machines: planMachines,
      routeConfigured: routeIssues.configured,
      warnings,
    };
  }

  /** Прайс вендинга с правилами закупа — для редактора панели. */
  async products(): Promise<VendingProductRow[]> {
    const rows = await this.db.select().from(vendingProduct);
    return rows
      .map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        purchasePrice: p.purchasePrice === null ? null : Number(p.purchasePrice),
        packSize: p.packSize,
        isActive: p.isActive,
        excludedFromPurchase: p.excludedFromPurchase,
        fixedPurchaseQty: p.fixedPurchaseQty,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "ru"));
  }

  /**
   * Правила закупа товара: кратность блока, «убрано из закупки»,
   * фикс-количество (П5a). Это решения ВЛАДЕЛЬЦА о закупе, а не свойства
   * товара: раньше они жили в голове и в правках закупочного листа руками,
   * поэтому каждый пересчёт их терял.
   *
   * `fixedPurchaseQty: 0` — снять фикс (в базе NULL): отдельная команда
   * «сними фикс» была бы ещё одним способом сказать то же самое.
   * Пустой patch — ошибка, а не молчаливое «ок»: это почти наверняка
   * потерянное поле в форме, а не намерение ничего не менять.
   */
  async setProductRules(rawProduct: string, patch: ProductRulesPatch, actor = "owner"): Promise<SetRulesResult> {
    const touched =
      patch.packSize !== undefined || patch.excludedFromPurchase !== undefined || patch.fixedPurchaseQty !== undefined;
    if (!touched) throw new BadRequestException("нечего менять: укажи packSize, excludedFromPurchase или fixedPurchaseQty");

    const name = rawProduct.trim();
    if (!name) return { ok: false, reason: "not_found" };

    const { aliasByKey, productRows } = await this.loadProductIndex();
    const canon = this.resolveProduct(name, aliasByKey);
    // Сначала — среди уже загруженных строк по нормализованному ключу
    // («блок Red  Bull CAN 0,25 6» с двумя пробелами); SQL по lower() остаётся
    // запасным путём: он ловит имя, которого нет в загруженном срезе.
    const row =
      this.findProductRow(canon, productRows) ??
      (
        await this.db
          .select({
            id: vendingProduct.id,
            name: vendingProduct.name,
            packSize: vendingProduct.packSize,
            excludedFromPurchase: vendingProduct.excludedFromPurchase,
            fixedPurchaseQty: vendingProduct.fixedPurchaseQty,
          })
          .from(vendingProduct)
          .where(eq(sql`lower(${vendingProduct.name})`, canon.toLowerCase()))
          .limit(1)
      )[0];
    if (!row) return { ok: false, reason: "not_found", product: canon };

    const before: Partial<VendingProductRow> = {
      packSize: row.packSize,
      excludedFromPurchase: row.excludedFromPurchase,
      fixedPurchaseQty: row.fixedPurchaseQty,
    };
    const set: { packSize?: number; excludedFromPurchase?: boolean; fixedPurchaseQty?: number | null; updatedAt: Date } = {
      updatedAt: new Date(),
    };
    if (patch.packSize !== undefined) set.packSize = patch.packSize;
    if (patch.excludedFromPurchase !== undefined) set.excludedFromPurchase = patch.excludedFromPurchase;
    if (patch.fixedPurchaseQty !== undefined) set.fixedPurchaseQty = patch.fixedPurchaseQty === 0 ? null : patch.fixedPurchaseQty;
    const after: Partial<VendingProductRow> = {
      packSize: set.packSize ?? before.packSize,
      excludedFromPurchase: set.excludedFromPurchase ?? before.excludedFromPurchase,
      fixedPurchaseQty: set.fixedPurchaseQty === undefined ? before.fixedPurchaseQty : set.fixedPurchaseQty,
    };

    await this.db.transaction(async (tx) => {
      await tx.update(vendingProduct).set(set).where(eq(vendingProduct.id, row.id));
      // Правило владельца меняет будущие закупы — след обязателен: событие —
      // история изменений (лента «Действия» его не читает), аудит держит
      // «кто и когда».
      await tx.insert(event).values({
        source: "owner",
        type: "vending.product_rules_changed",
        payload: { product: row.name, before, after, actor },
      });
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef: actor,
        action: "vending.product.set_rules",
        target: row.id,
        before,
        after,
      });
    });
    return { ok: true, product: row.name, before, after };
  }

  /**
   * Отправить закуп на утверждение владельцу (§5.7, главное правило MYDON:
   * система готовит — владелец подтверждает). Считает актуальный закуп и кладёт
   * его заявкой в очередь согласований; владелец решает ✅/❌ существующими
   * кнопками. Снимок закупа лежит в payload заявки — на нём же 4b соберёт
   * накладную при одобрении, без пересчёта.
   *
   * Нечего заказывать (нет позиций с ценой и продажами) — заявку не создаём:
   * пустое согласование только зашумляет очередь.
   */
  async submitPurchase(createdBy = "system"): Promise<SubmitPurchaseResult> {
    if (!this.approvals) throw new Error("ApprovalsService не подключён — отправка закупа недоступна");

    // Вторая заявка поверх нерешённой — почти всегда двойное нажатие (кнопка в
    // панели и «оформить закуп» в боте отправляют одно и то же). Владелец
    // увидел бы в очереди два одинаковых закупа, одобрил оба и получил две
    // накладные на один поход. Гейт по НЕРЕШЁННЫМ (decision='pending')
    // заявкам агента «vending» со снимком закупа в payload.
    const pendingRows = await this.db
      .select({ payload: approval.payload })
      .from(approval)
      .where(and(eq(approval.agent, "vending"), eq(approval.decision, "pending")));
    const хвост = pendingRows.some(
      (r) => typeof r.payload === "object" && r.payload !== null && "purchaseOrder" in (r.payload as object),
    );
    if (хвост) {
      return {
        submitted: false,
        positions: 0,
        costRounded: 0,
        reason: "Заявка на закуп уже ждёт решения — открой «согласования».",
      };
    }

    const s = await this.purchase();
    if (s.items.length === 0) {
      return { submitted: false, positions: 0, costRounded: 0, reason: "Закупать нечего — заявка не нужна." };
    }

    // Компактный снимок: то, что нужно владельцу для решения и 4b для накладной.
    const positions = s.items.map((i) => ({
      product: i.product,
      order: i.order,
      buy: i.buy,
      pack: i.pack,
      price: i.price,
      costRounded: i.costRounded,
      noPrice: i.noPrice,
      // Разбивка по автоматам и раздача (П5a): накладная 4b собирается из
      // снимка заявки без пересчёта, а без этих полей «куда везти» терялось.
      perMachine: i.perMachine,
      fromPurchase: i.fromPurchase,
      fromStock: i.fromStock,
      unfilled: i.unfilled,
    }));

    const sum = Math.round(s.costRounded).toLocaleString("ru-RU");
    // Штуки в заголовке заявки — не украшение: владелец решает по кнопке в
    // Telegram, где виден только `action`, и «3 поз. на 84 000» не отвечало на
    // вопрос «сколько это привезут». Позиции без цены оговариваем прямо:
    // сумма по ним не посчитана, реальный чек будет больше.
    const безЦены = s.noPrice.length > 0 ? ` (у ${s.noPrice.length} поз. нет цены — реальная сумма выше)` : "";
    const created = await this.approvals.request({
      agent: "vending",
      action: `Закуп вендинга: ${s.items.length} поз., ${s.totalOrder} ед, ~${sum} сум${безЦены}`,
      tier: "T2", // движение денег — не автономная операция
      payload: {
        purchaseOrder: {
          positions,
          totalBuy: s.totalBuy,
          totalOrder: s.totalOrder,
          costRounded: s.costRounded,
          costExact: s.costExact,
          overpay: s.overpay,
          createdBy,
        },
      },
    });

    return { submitted: true, approvalId: created.id, positions: s.items.length, costRounded: s.costRounded };
  }

  /** Накладные закупа (материализованы при одобрении) — последние сверху. */
  async orders(limit = 10): Promise<PurchaseOrderRow[]> {
    const rows = await this.db
      .select()
      .from(vendingPurchaseOrder)
      .orderBy(desc(vendingPurchaseOrder.createdAt))
      .limit(Math.min(Math.max(limit, 1), 50));
    return rows.map((r) => ({
      id: r.id,
      approvalId: r.approvalId,
      status: r.status,
      positions: Array.isArray(r.positions) ? r.positions.length : 0,
      totalOrder: r.totalOrder,
      costRounded: Number(r.costRounded),
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
      distributedUnits: r.distributedUnits,
      unmatchedDistribution: (r.unmatchedDistribution as string[] | null) ?? null,
      receivedAt: r.receivedAt ? r.receivedAt.toISOString() : null,
      receivedBy: r.receivedBy,
    }));
  }

  /**
   * Приёмка накладной на склад (§5.7, замыкание цикла): товар физически
   * приехал — увеличиваем остаток склада на заказанное количество, накладная
   * переходит в `received`. Так следующий закуп учтёт приход и не закажет
   * повторно. Без orderId берём последнюю неполученную (approved/ordered).
   *
   * Пополнение — приращение (в отличие от инвентаризации-перезаписи §5.4):
   * это приход, а не пересчёт. Всё одной транзакцией: статус и остаток должны
   * меняться вместе, иначе «принято», но склад пуст (или наоборот).
   *
   * `distributed` — реальный процесс владельца (лист «Snack склад»): часть
   * закупа сразу уходит в автоматы, минуя склад. Без этого параметра на склад
   * зачислялся бы ВЕСЬ order, хотя часть уже физически в автомате — до
   * следующего пересчёта («склад X N») это выглядело бы как фиктивная
   * недостача. Имена в `distributed` приводятся к канону через те же алиасы,
   * что и ввод склада (§5.4), и сравниваются с позицией накладной без учёта
   * регистра/пробелов; распределённое сверх заказанного — отсекается.
   *
   * Позиции накладной берутся из `purchase()`, который теперь тоже группирует
   * по канону (§ item 38) — но алиас в `distributed` мог появиться ПОСЛЕ того,
   * как накладная создана, или ссылаться на товар не из этого закупа. Если
   * ключ после резолва всё равно не совпал ни с одной позицией, запись
   * попадает в `unmatchedDistribution`, а её сумма уходит на склад, как будто
   * распределения не было: не роняем приёмку из-за несовпадения имён, но и не
   * молчим об этом (найдено адверсариал-ревью).
   */
  async receiveOrder(
    orderId?: string,
    receivedBy = "owner",
    distributed?: Record<string, number>,
  ): Promise<ReceiveOrderResult> {
    // Ключ — normalizeProductName(канон): сравнение с позицией без учёта
    // регистра/пробелов. display хранит канон как есть — для unmatchedDistribution.
    const distributedByCanonical = new Map<string, number>();
    const distributedDisplay = new Map<string, string>();
    if (distributed && Object.keys(distributed).length > 0) {
      const { aliasByKey } = await this.loadProductIndex();
      for (const [raw, qty] of Object.entries(distributed)) {
        const name = raw.trim();
        // Не целое неотрицательное число (NaN, дробь, строка, отрицательное) —
        // чужой формат или опечатка: запись игнорируем, а не роняем всю
        // приёмку и не пускаем NaN/дробь в insert по integer-колонке
        // (найдено адверсариал-ревью).
        if (!name || typeof qty !== "number" || !Number.isInteger(qty) || qty < 0) continue;
        const canon = this.resolveProduct(name, aliasByKey);
        const key = normalizeProductName(canon);
        // Суммируем, а не перезаписываем: в отличие от ingestStock (снимок,
        // последняя позиция побеждает), distributed — поток "сколько роздано";
        // два алиаса одного товара в одном вызове должны сложиться, иначе
        // часть распределения молча терялась бы (найдено адверсариал-ревью).
        distributedByCanonical.set(key, (distributedByCanonical.get(key) ?? 0) + qty);
        distributedDisplay.set(key, canon);
      }
    }

    return this.db.transaction(async (tx) => {
      const [existing] = orderId
        ? await tx.select().from(vendingPurchaseOrder).where(eq(vendingPurchaseOrder.id, orderId)).limit(1)
        : await tx
            .select()
            .from(vendingPurchaseOrder)
            .where(inArray(vendingPurchaseOrder.status, ["approved", "ordered"]))
            .orderBy(desc(vendingPurchaseOrder.createdAt))
            .limit(1);

      if (!existing) {
        return {
          received: false,
          replenished: 0,
          units: 0,
          distributedUnits: 0,
          unmatchedDistribution: [],
          reason: "Непринятых накладных нет.",
        };
      }
      if (existing.status === "received") {
        return {
          received: false,
          replenished: 0,
          units: 0,
          distributedUnits: 0,
          unmatchedDistribution: [],
          reason: "Эта накладная уже принята.",
        };
      }
      if (existing.status === "cancelled") {
        // Отдельно от "уже принята": иначе владельцу говорим неправду про
        // отменённую накладную (найдено ревью).
        return {
          received: false,
          replenished: 0,
          units: 0,
          distributedUnits: 0,
          unmatchedDistribution: [],
          reason: "Эта накладная отменена — приёмка невозможна.",
        };
      }

      const now = new Date();
      // Атомарный переход approved/ordered → received: условие статуса — прямо
      // в UPDATE, а не только в SELECT выше. Раньше SELECT и UPDATE были
      // раздельными запросами — два параллельных вызова приёмки одной
      // накладной могли оба увидеть approved между собой и оба зачислить
      // остаток на склад (найдено внешним аудитом; тот же класс гонки уже
      // чинили в approvals.service.decide()). Побеждает ровно один: второй
      // получит 0 строк из returning() и не тронет склад.
      const [order] = await tx
        .update(vendingPurchaseOrder)
        .set({ status: "received", receivedAt: now, receivedBy })
        .where(and(eq(vendingPurchaseOrder.id, existing.id), inArray(vendingPurchaseOrder.status, ["approved", "ordered"])))
        .returning();

      if (!order) {
        return {
          received: false,
          replenished: 0,
          units: 0,
          distributedUnits: 0,
          unmatchedDistribution: [],
          reason: "Эта накладная уже принята.",
        };
      }

      // Приход по позициям: остаток += (order − распределено). Без
      // распределения (по умолчанию) — как раньше: весь order идёт на склад.
      const positions = Array.isArray(order.positions) ? order.positions : [];
      let replenished = 0;
      let units = 0;
      let distributedUnits = 0;
      const consumedDistribution = new Set<string>();
      // Мост П3 в журнал прихода: каждая позиция накладной становится строкой
      // purchase (source='vending-order', цена — снапшот прайса из позиции).
      // Собираем ДО ветки toWarehouse: закуплено qty целиком, даже если всё
      // роздано по автоматам мимо склада.
      //
      // Переходный гейт: пока задан STOCK_DATABASE_URL, тот же физический
      // закуп приходит зеркалом из mydon-stock (source='stock') — мост при
      // живом зеркале двоил бы деньги в журнале и сводке снабжения (найдено
      // адверсариал-ревью П3a). Мост включается в момент гашения синка.
      const mirrorAlive = Boolean(process.env.STOCK_DATABASE_URL);
      const dtToday = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
      const purchaseRows: (typeof purchase.$inferInsert)[] = [];
      for (const p of positions) {
        const pos = p as { product?: unknown; order?: unknown; price?: unknown };
        const product = typeof pos.product === "string" ? pos.product.trim() : "";
        const qty = typeof pos.order === "number" && Number.isFinite(pos.order) ? Math.trunc(pos.order) : 0;
        if (!product || qty <= 0) continue;

        const key = normalizeProductName(product);
        // Позиции пишутся в jsonb без валидации содержимого (см.
        // executePurchaseOrder) — price перепроверяем так же строго, как
        // qty. 0 и мусор = «цены нет», НЕ ноль сум. Потолки магнитуд — чтобы
        // кривая ручная правка jsonb не завалила numeric-колонку и с ней всю
        // приёмку (найдено адверсариал-ревью П3a); qty > потолка не пишем в
        // журнал вовсе (склад упадёт на своём integer раньше).
        const rawPrice = typeof pos.price === "number" && Number.isFinite(pos.price) && pos.price > 0 ? pos.price : null;
        const unitPrice = rawPrice !== null && rawPrice <= 10_000_000 ? rawPrice : null;
        if (!mirrorAlive && qty <= 1_000_000) {
          // Дубликат канона в positions (слоты «Кола»/«кола» без алиаса дают
          // две позиции одного канона) дал бы два одинаковых extId в одном
          // INSERT — ON CONFLICT DO NOTHING молча выкинул бы второй. Сливаем
          // в одну строку заранее.
          const twin = purchaseRows.find((r) => r.extId === `${order.id}:${key}`);
          if (twin) {
            const mergedQty = Number(twin.qty) + qty;
            twin.qty = String(mergedQty);
            if (twin.unitPrice != null) twin.total = (mergedQty * Number(twin.unitPrice)).toFixed(2);
          } else {
            purchaseRows.push({
              extId: `${order.id}:${key}`,
              dt: dtToday,
              product,
              unit: "шт",
              qty: String(qty),
              unitPrice: unitPrice === null ? null : unitPrice.toFixed(2),
              total: unitPrice === null ? null : (qty * unitPrice).toFixed(2),
              note: `накладная ${order.id.slice(0, 8)}, принял ${receivedBy}`,
              source: "vending-order",
            });
          }
        }
        const requested = distributedByCanonical.get(key);
        if (requested !== undefined) consumedDistribution.add(key);
        // Не больше заказанного — опечатка владельца не должна увести склад в минус.
        const dist = Math.min(qty, Math.max(0, requested ?? 0));
        // Остаток распределения списываем: дубль канона в positions иначе
        // получал бы requested целиком ВТОРОЙ раз — distributedUnits врал бы,
        // а склад недосчитывался (найдено адверсариал-ревью П3a).
        if (requested !== undefined) distributedByCanonical.set(key, Math.max(0, requested - dist));
        distributedUnits += dist;
        const toWarehouse = qty - dist;
        if (toWarehouse <= 0) continue;

        await tx
          .insert(vendingStock)
          .values({ productName: product, quantity: toWarehouse, countedAt: now, updatedAt: now })
          .onConflictDoUpdate({
            target: [vendingStock.productName],
            set: { quantity: sql`${vendingStock.quantity} + ${toWarehouse}`, countedAt: now, updatedAt: now },
          });
        replenished += 1;
        units += toWarehouse;
      }

      // Журнал прихода — в той же транзакции, что и переход статуса: приёмка
      // без следа в purchase невозможна, откат откатывает всё. Конфликт по
      // (source, extId) законен только при ручной правке журнала — тогда
      // живая строка важнее моста, не перетираем.
      if (purchaseRows.length > 0) {
        await tx.insert(purchase).values(purchaseRows).onConflictDoNothing();
      }

      // Запрошенное распределение, которое не совпало ни с одной позицией
      // накладной — молча ушло на склад вместо автомата (см. doc-комментарий
      // метода). Показываем канон (не сырой ввод владельца) — так виднее,
      // что именно не срослось с алиасами.
      const unmatchedDistribution = [...distributedByCanonical.keys()]
        .filter((key) => !consumedDistribution.has(key))
        .map((key) => distributedDisplay.get(key) ?? key);

      // Персистим на саму накладную — иначе распределение видно только в этом
      // разовом ответе/сообщении бота, а панель (orders()) его никогда не
      // показывает.
      await tx
        .update(vendingPurchaseOrder)
        .set({ distributedUnits, unmatchedDistribution })
        .where(eq(vendingPurchaseOrder.id, order.id));

      await tx.insert(event).values({
        source: "owner",
        type: "vending.purchase_order.received",
        payload: {
          orderId: order.id,
          replenished,
          units,
          distributedUnits,
          unmatchedDistribution,
          recordedPurchases: purchaseRows.length,
        },
      });
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef: receivedBy,
        action: "vending.purchase_order.receive",
        target: order.id,
        before: existing,
        after: order,
      });

      return {
        received: true,
        orderId: order.id,
        replenished,
        units,
        distributedUnits,
        unmatchedDistribution,
        recordedPurchases: purchaseRows.length,
      };
    });
  }

  /**
   * Правка закупочной цены товара — команда «цена <товар> <число>» из бота.
   * Единственный «живой» писатель vending_product.purchasePrice (сид не
   * трогает существующие строки): чинит тупик «⚠️ Без цены — на разбор» из
   * брифинга закупа прямо из Telegram.
   *
   * Гейт цены (процесс mydon-stock): отклонение от текущей > PRICE_SPIKE_PCT
   * → отказ reason='spike', владелец повторяет команду со словом «точно»
   * (confirmed=true). Первая цена (текущей нет) проходит без гейта.
   */
  async setProductPrice(rawProduct: string, price: number, actor = "owner", confirmed = false): Promise<SetPriceResult> {
    const name = rawProduct.trim();
    if (!name || !Number.isFinite(price) || price <= 0) return { ok: false, reason: "not_found" };

    const { aliasByKey, productRows } = await this.loadProductIndex();
    const canon = this.resolveProduct(name, aliasByKey);
    // Как и в правилах: канон ищем по нормализованному ключу среди загруженных
    // строк, SQL по lower() — запасной путь.
    const row =
      this.findProductRow(canon, productRows) ??
      (
        await this.db
          .select({ id: vendingProduct.id, name: vendingProduct.name, purchasePrice: vendingProduct.purchasePrice })
          .from(vendingProduct)
          .where(eq(sql`lower(${vendingProduct.name})`, canon.toLowerCase()))
          .limit(1)
      )[0];
    if (!row) return { ok: false, reason: "not_found", product: canon };

    const oldPrice = row.purchasePrice === null ? null : Number(row.purchasePrice);
    const deviation = priceDeviationPct(price, oldPrice);
    if (!confirmed && deviation !== null && deviation > PRICE_SPIKE_PCT) {
      return {
        ok: false,
        reason: "spike",
        product: row.name,
        oldPrice,
        newPrice: price,
        deviationPct: Math.round(deviation),
      };
    }

    await this.db.transaction(async (tx) => {
      await tx.update(vendingProduct).set({ purchasePrice: price.toFixed(2) }).where(eq(vendingProduct.id, row.id));
      // История цены — событием: у vending_product нет структурной истории
      // (appendPriceHistory покрывает только entity-карточки). Событие —
      // история изменений (лента «Действия» его не читает).
      await tx.insert(event).values({
        source: "owner",
        type: "vending.price_changed",
        payload: { product: row.name, oldPrice, newPrice: price, actor },
      });
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef: actor,
        action: "vending.product.set_price",
        target: row.id,
        before: { purchasePrice: oldPrice },
        after: { purchasePrice: price },
      });
    });
    return { ok: true, product: row.name, oldPrice, newPrice: price };
  }

  // ── Касса закупа (§5.8) ───────────────────────────────────────────────────
  // Реальный поход на базар: получил наличные, потратил по статьям, что
  // осталось. Снимок, не леджер — одна запись на один поход. Арифметика строк
  // уже посчитана владельцем от руки (§5.8 в shared); здесь только сведение
  // статей и запись в базу.

  /** Записать кассу закупа: получил → статьи → остаток (снимок, не леджер). */
  async recordCashSession(
    receivedAmount: number,
    categories: CashCategoryInput[],
    createdBy = "owner",
  ): Promise<CashSessionRow> {
    const session = computePurchaseCash(receivedAmount, categories);
    const [row] = await this.db
      .insert(vendingCashSession)
      .values({
        receivedAmount: session.receivedAmount.toFixed(2),
        categories: session.categories,
        totalSpent: session.totalSpent.toFixed(2),
        remainder: session.remainder.toFixed(2),
        createdBy,
      })
      .returning();
    return { ...session, id: row.id, createdBy: row.createdBy, createdAt: row.createdAt.toISOString() };
  }

  /** Последние кассы закупа (для панели/бота — история походов на базар). */
  async cashSessions(limit = 10): Promise<CashSessionRow[]> {
    const rows = await this.db
      .select()
      .from(vendingCashSession)
      .orderBy(desc(vendingCashSession.createdAt))
      .limit(Math.min(Math.max(limit, 1), 50));
    return rows.map((r) => ({
      id: r.id,
      receivedAmount: Number(r.receivedAmount),
      categories: r.categories, // типизировано на колонке ($type<CashCategorySummary[]>) — каста не нужно
      totalSpent: Number(r.totalSpent),
      remainder: Number(r.remainder),
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  // ── Журнал сбора Ourvend ──────────────────────────────────────────────────
  // Коллектор живёт в слое агентов, а факт запуска и итог фиксируются в Core:
  // так «когда последний раз собирали и удачно ли» видно из панели, а не только
  // в логах контейнера. Пара start/finish, а не одна запись, чтобы завис сбор
  // было видно как «running» без finished_at.

  /** Открыть запись сбора (status=running). Возвращает её id. */
  async startSyncRun(): Promise<{ id: string }> {
    const [row] = await this.db.insert(vendingSyncRun).values({}).returning({ id: vendingSyncRun.id });
    return { id: row.id };
  }

  /**
   * Закрыть запись сбора итогом. Неизвестный id — `ok: false`, а не молчаливый
   * успех: раньше UPDATE без проверки affected rows всегда отдавал `ok: true`,
   * даже когда коллектор передал несуществующий id — ошибка была бы незаметна
   * (найдено внешним аудитом, P2).
   */
  async finishSyncRun(id: string, input: SyncFinishInput): Promise<{ ok: boolean }> {
    const rows = await this.db
      .update(vendingSyncRun)
      .set({
        finishedAt: new Date(),
        status: input.status,
        machinesTotal: input.machinesTotal,
        machinesOk: input.machinesOk,
        durationMs: input.durationMs,
        error: input.error ?? null,
      })
      .where(eq(vendingSyncRun.id, id))
      .returning({ id: vendingSyncRun.id });
    return { ok: rows.length > 0 };
  }

  /** Последние запуски сбора (для панели: когда собирали и с каким итогом). */
  async syncRuns(limit = 10): Promise<SyncRunRow[]> {
    const rows = await this.db
      .select()
      .from(vendingSyncRun)
      .orderBy(desc(vendingSyncRun.startedAt))
      .limit(Math.min(Math.max(limit, 1), 50));
    return rows.map((r) => ({
      id: r.id,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
      status: r.status,
      machinesTotal: r.machinesTotal,
      machinesOk: r.machinesOk,
      error: r.error,
      durationMs: r.durationMs,
    }));
  }
}
