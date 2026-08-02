import { Inject, Injectable, Optional } from "@nestjs/common";
import { desc, eq, inArray, sql } from "drizzle-orm";
import {
  auditLog,
  event,
  machineSale,
  machineSlot,
  productSale,
  slotSnapshot,
  vendingProduct,
  vendingPurchaseOrder,
  vendingStock,
  vendingSyncRun,
} from "@mydon/db";
import {
  MAX_CAPACITY,
  computePurchase,
  machineDeficit,
  needByProduct,
  planogramStatus,
  runoutForecast,
  slotValid,
  type PlanogramStatus,
  type PriceEntry,
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
}

/** Итог приёмки накладной на склад. */
export interface ReceiveOrderResult {
  received: boolean;
  /** id принятой накладной (когда received). */
  orderId?: string;
  /** Сколько позиций легло на склад. */
  replenished: number;
  /** Всего единиц принято (Σ order по позициям). */
  units: number;
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
   * Принять собранные слоты: upsert актуальной планограммы + запись в историю.
   * Идемпотентно по (serial, coil): повторный сбор обновляет слот, а не плодит.
   */
  async ingestSlots(payload: IngestPayload): Promise<{ machines: number; slots: number }> {
    const capturedAt = payload.capturedAt ? new Date(payload.capturedAt) : new Date();
    let slots = 0;
    await this.db.transaction(async (tx) => {
      for (const m of payload.machines) {
        for (const s of m.slots) {
          const isValid = s.capacity > 0 && s.capacity <= MAX_CAPACITY;
          const product = s.product.trim() || null;
          await tx
            .insert(machineSlot)
            .values({
              machineSerial: m.serial,
              coilId: s.coilId,
              productName: product,
              capacity: s.capacity,
              quantity: s.quantity,
              isValid,
              syncedAt: capturedAt,
            })
            .onConflictDoUpdate({
              target: [machineSlot.machineSerial, machineSlot.coilId],
              set: { productName: product, capacity: s.capacity, quantity: s.quantity, isValid, syncedAt: capturedAt },
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
    return { machines: payload.machines.length, slots };
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

  /** Сводная потребность по товарам (только ok-автоматы), с разбивкой. */
  async deficitSummary(): Promise<{ product: string; total: number; perMachine: Record<string, number> }[]> {
    const byMachine = await this.slotsByMachine();
    const ok = [...byMachine.entries()]
      .filter(([, slots]) => planogramStatus(slots) === "ok")
      .map(([machineId, slots]) => ({ machineId, slots }));
    const needs = needByProduct(ok);
    needs.sort((a, b) => b.total - a.total);
    return needs.map((n) => ({ product: n.product, total: n.total, perMachine: n.perMachine }));
  }

  // ── Продажи и прогноз расхода (§5.6) ──────────────────────────────────────
  // Продажи — история, а не upsert: каждый сбор пишет окно как есть. Прогноз
  // берёт САМЫЙ СВЕЖИЙ батч (одинаковый capturedAt), иначе перекрывающиеся
  // 7-дневные окна складывались бы и завышали продажи.

  /** Принять собранные продажи (по товарам и по автоматам) за окно. */
  async ingestSales(payload: IngestSalesPayload): Promise<{ productRows: number; machineRows: number }> {
    const capturedAt = payload.capturedAt ? new Date(payload.capturedAt) : new Date();
    const periodStart = new Date(payload.periodStart);
    const periodEnd = new Date(payload.periodEnd);
    await this.db.transaction(async (tx) => {
      for (const p of payload.productSales) {
        await tx.insert(productSale).values({
          machineSerial: p.serial,
          productName: p.product,
          periodStart,
          periodEnd,
          quantity: p.quantity,
          capturedAt,
        });
      }
      for (const m of payload.machineSales) {
        await tx.insert(machineSale).values({
          machineSerial: m.serial,
          periodStart,
          periodEnd,
          totalAmount: m.totalAmount.toFixed(2),
          totalCount: m.totalCount,
          capturedAt,
        });
      }
    });
    return { productRows: payload.productSales.length, machineRows: payload.machineSales.length };
  }

  /**
   * Продажи за 7 суток по товару из САМОГО СВЕЖЕГО батча (одинаковый
   * capturedAt) и только по ok-автоматах. Батч, а не сумма истории — иначе
   * перекрывающиеся 7-дневные окна складывались бы и завышали расход.
   */
  private async latestSold7(okSerials: Set<string>): Promise<Map<string, number>> {
    const saleRows = await this.db.select().from(productSale);
    const latest = saleRows.reduce((max, r) => Math.max(max, r.capturedAt.getTime()), 0);
    const out = new Map<string, number>();
    for (const r of saleRows) {
      if (r.capturedAt.getTime() !== latest) continue;
      if (!okSerials.has(r.machineSerial)) continue;
      out.set(r.productName, (out.get(r.productName) ?? 0) + r.quantity);
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
    const byMachine = await this.slotsByMachine();
    const okSerials = this.okSerials(byMachine);

    // Остаток в машинах по товару: Σ quantity валидных назначенных слотов ok-автоматов.
    const inByProduct = new Map<string, number>();
    for (const [serial, slots] of byMachine) {
      if (!okSerials.has(serial)) continue;
      for (const s of slots) {
        if (s.product && slotValid(s)) inByProduct.set(s.product, (inByProduct.get(s.product) ?? 0) + s.quantity);
      }
    }

    const soldByProduct = await this.latestSold7(okSerials);

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

  /** Принять инвентаризацию склада: перезапись остатка по каждому товару. */
  async ingestStock(payload: IngestStockPayload): Promise<{ items: number }> {
    const countedAt = payload.countedAt ? new Date(payload.countedAt) : new Date();
    await this.db.transaction(async (tx) => {
      for (const it of payload.items) {
        const product = it.product.trim();
        if (!product) continue;
        await tx
          .insert(vendingStock)
          .values({ productName: product, quantity: it.quantity, countedAt, updatedAt: countedAt })
          .onConflictDoUpdate({
            target: [vendingStock.productName],
            set: { quantity: it.quantity, countedAt, updatedAt: countedAt },
          });
      }
    });
    return { items: payload.items.length };
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
   */
  async purchase(): Promise<PurchaseSummary> {
    const byMachine = await this.slotsByMachine();
    const okSerials = this.okSerials(byMachine);
    const ok = [...byMachine.entries()]
      .filter(([serial]) => okSerials.has(serial))
      .map(([machineId, slots]) => ({ machineId, slots }));
    const needs = needByProduct(ok);
    const soldByProduct = await this.latestSold7(okSerials);
    const stockByProduct = await this.stockByProduct();

    // Прайс: только позиции с ценой попадают в карту — иначе калькулятор
    // пометит noPrice и выведет их на разбор менеджеру (§5.5).
    const products = await this.db.select().from(vendingProduct);
    const prices = new Map<string, PriceEntry>();
    for (const p of products) {
      if (p.purchasePrice != null) prices.set(p.name, { price: Number(p.purchasePrice), pack: p.packSize });
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
   */
  async receiveOrder(orderId?: string, receivedBy = "owner"): Promise<ReceiveOrderResult> {
    return this.db.transaction(async (tx) => {
      const [order] = orderId
        ? await tx.select().from(vendingPurchaseOrder).where(eq(vendingPurchaseOrder.id, orderId)).limit(1)
        : await tx
            .select()
            .from(vendingPurchaseOrder)
            .where(inArray(vendingPurchaseOrder.status, ["approved", "ordered"]))
            .orderBy(desc(vendingPurchaseOrder.createdAt))
            .limit(1);

      if (!order) {
        return { received: false, replenished: 0, units: 0, reason: "Непринятых накладных нет." };
      }
      if (order.status === "received") {
        return { received: false, replenished: 0, units: 0, reason: "Эта накладная уже принята." };
      }

      const now = new Date();
      await tx.update(vendingPurchaseOrder).set({ status: "received" }).where(eq(vendingPurchaseOrder.id, order.id));

      // Приход по позициям: остаток += order (приращение, не перезапись).
      const positions = Array.isArray(order.positions) ? order.positions : [];
      let replenished = 0;
      let units = 0;
      for (const p of positions) {
        const pos = p as { product?: unknown; order?: unknown };
        const product = typeof pos.product === "string" ? pos.product.trim() : "";
        const qty = typeof pos.order === "number" && Number.isFinite(pos.order) ? Math.trunc(pos.order) : 0;
        if (!product || qty <= 0) continue;
        await tx
          .insert(vendingStock)
          .values({ productName: product, quantity: qty, countedAt: now, updatedAt: now })
          .onConflictDoUpdate({
            target: [vendingStock.productName],
            set: { quantity: sql`${vendingStock.quantity} + ${qty}`, countedAt: now, updatedAt: now },
          });
        replenished += 1;
        units += qty;
      }

      await tx.insert(event).values({
        source: "owner",
        type: "vending.purchase_order.received",
        payload: { orderId: order.id, replenished, units },
      });
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef: receivedBy,
        action: "vending.purchase_order.receive",
        target: order.id,
        before: order,
        after: { ...order, status: "received" },
      });

      return { received: true, orderId: order.id, replenished, units };
    });
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

  /** Закрыть запись сбора итогом. Молча игнорирует неизвестный id. */
  async finishSyncRun(id: string, input: SyncFinishInput): Promise<{ ok: boolean }> {
    await this.db
      .update(vendingSyncRun)
      .set({
        finishedAt: new Date(),
        status: input.status,
        machinesTotal: input.machinesTotal,
        machinesOk: input.machinesOk,
        durationMs: input.durationMs,
        error: input.error ?? null,
      })
      .where(eq(vendingSyncRun.id, id));
    return { ok: true };
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
