import { Inject, Injectable } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { machineSale, machineSlot, productSale, slotSnapshot, vendingProduct, vendingStock, vendingSyncRun } from "@mydon/db";
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

@Injectable()
export class VendingService {
  constructor(@Inject(DB) private readonly db: Db) {}

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
