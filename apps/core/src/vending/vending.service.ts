import { Inject, Injectable, Optional } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  auditLog,
  entity,
  event,
  machineSale,
  machineSlot,
  productSale,
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
  computePurchase,
  computePurchaseCash,
  machineDeficit,
  machineSerialKeys,
  needByProduct,
  normalizeMachineSerial,
  normalizeProductName,
  planogramStatus,
  runoutForecast,
  slotValid,
  type CashCategoryInput,
  type PlanogramStatus,
  type PriceEntry,
  type PurchaseCashSession,
  type PurchaseRow,
  type PurchaseSummary,
  type Runout,
  type RunoutInput,
  type Slot,
} from "@mydon/shared";
import { DB, type Db } from "../db/db.module";
import { ApprovalsService } from "../approvals/approvals.service";

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
  /** Почему не приняли (когда !received). */
  reason?: string;
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
    const rows = await this.db
      .select({ id: entity.id, ref: entity.externalRef })
      .from(entity)
      .where(eq(entity.type, "machine"));
    const map = new Map<string, string>();
    for (const r of rows) {
      for (const key of machineSerialKeys(r.ref)) {
        // Первая карточка выигрывает: дубли по одному серийнику — вопрос к
        // реестру (docs/REGISTRY_CLEANUP.md), молча перезаписывать не надо.
        if (!map.has(key)) map.set(key, r.id);
      }
    }
    return map;
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
    const skipped: SkippedMachine[] = [];
    const accepted = payload.machines.filter((m) => {
      if (m.slots.length <= MAX_SLOTS_PER_MACHINE) return true;
      skipped.push({ serial: m.serial, slots: m.slots.length, reason: "слишком много слотов" });
      return false;
    });
    let slots = 0;
    let linked = 0;
    let pruned = 0;
    await this.db.transaction(async (tx) => {
      for (const m of accepted) {
        const machineId = bySerial.get(normalizeMachineSerial(m.serial)) ?? null;
        if (machineId !== null) linked += 1;

        // Убрать слоты, которых в автомате больше нет.
        //
        // `machine_slot` — зеркало, а зеркало обязано уметь сокращаться.
        // Upsert только добавляет и обновляет, поэтому исчезнувший слот
        // оставался в планограмме навсегда: у `2508160376` так накопилось
        // 445 несуществующих позиций, и автомат показывал 488 слотов вместо
        // сорока трёх.
        //
        // Пустой список — НЕ повод стирать планограмму: это чаще всего сбой
        // выгрузки, а не автомат, из которого вынули все пружины. Стирать по
        // молчанию источника — способ потерять данные без единой ошибки.
        if (m.slots.length > 0) {
          const живые = m.slots.map((s) => s.coilId);
          const убрано = await tx
            .delete(machineSlot)
            .where(
              and(
                eq(machineSlot.machineSerial, m.serial),
                sql`${machineSlot.coilId} <> all(${живые})`,
              ),
            )
            .returning({ id: machineSlot.id });
          pruned += убрано.length;
        }
        for (const s of m.slots) {
          const isValid = s.capacity > 0 && s.capacity <= MAX_CAPACITY;
          const product = s.product.trim() || null;
          await tx
            .insert(machineSlot)
            .values({
              machineSerial: m.serial,
              machineId,
              coilId: s.coilId,
              productName: product,
              capacity: s.capacity,
              quantity: s.quantity,
              isValid,
              syncedAt: capturedAt,
            })
            .onConflictDoUpdate({
              target: [machineSlot.machineSerial, machineSlot.coilId],
              // machineId обновляем тоже: карточка автомата могла появиться
              // позже слотов — так же, как это делает backfill в продажах.
              set: { machineId, productName: product, capacity: s.capacity, quantity: s.quantity, isValid, syncedAt: capturedAt },
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
    return { machines: accepted.length, slots, linked, pruned, skipped };
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
    await this.db.transaction(async (tx) => {
      for (const p of payload.productSales) {
        await tx
          .insert(productSale)
          .values({
            machineSerial: p.serial,
            productName: p.product,
            periodStart,
            periodEnd,
            quantity: p.quantity,
            capturedAt,
          })
          .onConflictDoUpdate({
            target: [productSale.machineSerial, productSale.productName, productSale.capturedAt],
            set: { periodStart, periodEnd, quantity: p.quantity },
          });
      }
      for (const m of payload.machineSales) {
        await tx
          .insert(machineSale)
          .values({
            machineSerial: m.serial,
            periodStart,
            periodEnd,
            totalAmount: m.totalAmount.toFixed(2),
            totalCount: m.totalCount,
            capturedAt,
          })
          .onConflictDoUpdate({
            target: [machineSale.machineSerial, machineSale.capturedAt],
            set: { periodStart, periodEnd, totalAmount: m.totalAmount.toFixed(2), totalCount: m.totalCount },
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
  private async latestSold7(okSerials: Set<string>, aliasByKey: Map<string, string>): Promise<Map<string, number>> {
    const saleRows = await this.db.select().from(productSale);
    const latest = saleRows.reduce((max, r) => Math.max(max, r.capturedAt.getTime()), 0);
    const out = new Map<string, number>();
    for (const r of saleRows) {
      if (r.capturedAt.getTime() !== latest) continue;
      if (!okSerials.has(r.machineSerial)) continue;
      const name = this.resolveProduct(r.productName, aliasByKey);
      out.set(name, (out.get(name) ?? 0) + r.quantity);
    }
    return out;
  }

  /** Серийники ok-автоматов из готовой карты слотов. */
  private okSerials(byMachine: Map<string, Slot[]>): Set<string> {
    return new Set([...byMachine.entries()].filter(([, slots]) => planogramStatus(slots) === "ok").map(([serial]) => serial));
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

    const soldByProduct = await this.latestSold7(okSerials, aliasByKey);

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
  }> {
    const [aliases, products] = await Promise.all([
      this.db.select().from(vendingAlias),
      this.db
        .select({
          id: vendingProduct.id,
          name: vendingProduct.name,
          purchasePrice: vendingProduct.purchasePrice,
          packSize: vendingProduct.packSize,
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
    for (const p of products) {
      if (p.purchasePrice != null) priceByName.set(p.name, Number(p.purchasePrice));
      packByName.set(p.name, p.packSize);
    }
    return { aliasByKey, priceByName, packByName };
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
    const { aliasByKey, priceByName } = await this.loadProductIndex();

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

        await tx
          .insert(vendingStock)
          .values({ productName: product, quantity, countedAt, updatedAt: countedAt })
          .onConflictDoUpdate({
            target: [vendingStock.productName],
            set: { quantity, countedAt, updatedAt: countedAt },
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
      .map((r) => ({ product: r.productName, quantity: r.quantity, countedAt: r.countedAt.toISOString() }))
      .sort((a, b) => a.product.localeCompare(b.product, "ru"));
  }

  /** Остаток склада как карта товар → количество — для расчёта закупа. */
  private async stockByProduct(): Promise<Map<string, number>> {
    const rows = await this.db.select().from(vendingStock);
    const out = new Map<string, number>();
    for (const r of rows) out.set(r.productName, r.quantity);
    return out;
  }

  /**
   * Сводный закуп (§5.4–5.5): потребность ok-автоматов − остаток склада,
   * округление до упаковок, суммы. Прайс и кратность — из `vending_product`
   * (не из кода), остаток — из `vending_stock` (инвентаризация). Позиции без
   * цены и без продаж калькулятор выносит отдельно и в денежные итоги не
   * включает.
   *
   * Имена слотов приводятся к канону через алиасы ДО расчёта потребности —
   * иначе один и тот же товар, записанный в разных автоматах разными
   * Ourvend-именами («Montella», «18+»), уходит в закуп двумя отдельными
   * позициями вместо одной (склад и продажи уже в каноне — `ingestStock`
   * и `latestSold7` резолвят его же картой алиасов, иначе позиции просто
   * не сойдутся друг с другом).
   */
  async purchase(): Promise<PurchaseSummary> {
    const { aliasByKey, priceByName, packByName } = await this.loadProductIndex();
    const byMachine = await this.slotsByMachine();
    const okSerials = this.okSerials(byMachine);
    const ok = [...byMachine.entries()]
      .filter(([serial]) => okSerials.has(serial))
      .map(([machineId, slots]) => ({ machineId, slots: this.resolveSlots(slots, aliasByKey) }));
    const needs = needByProduct(ok);
    const soldByProduct = await this.latestSold7(okSerials, aliasByKey);
    const stockByProduct = await this.stockByProduct();

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
    return computePurchase(rows, prices);
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
    }));

    const sum = Math.round(s.costRounded).toLocaleString("ru-RU");
    const created = await this.approvals.request({
      agent: "vending",
      action: `Закуп вендинга: ${s.items.length} поз., ~${sum} сум`,
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
        .set({ status: "received" })
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
      for (const p of positions) {
        const pos = p as { product?: unknown; order?: unknown };
        const product = typeof pos.product === "string" ? pos.product.trim() : "";
        const qty = typeof pos.order === "number" && Number.isFinite(pos.order) ? Math.trunc(pos.order) : 0;
        if (!product || qty <= 0) continue;

        const key = normalizeProductName(product);
        const requested = distributedByCanonical.get(key);
        if (requested !== undefined) consumedDistribution.add(key);
        // Не больше заказанного — опечатка владельца не должна увести склад в минус.
        const dist = Math.min(qty, Math.max(0, requested ?? 0));
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
        payload: { orderId: order.id, replenished, units, distributedUnits, unmatchedDistribution },
      });
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef: receivedBy,
        action: "vending.purchase_order.receive",
        target: order.id,
        before: existing,
        after: order,
      });

      return { received: true, orderId: order.id, replenished, units, distributedUnits, unmatchedDistribution };
    });
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
