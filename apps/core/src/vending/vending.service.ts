import { Inject, Injectable } from "@nestjs/common";
import { machineSlot, slotSnapshot } from "@mydon/db";
import {
  MAX_CAPACITY,
  machineDeficit,
  needByProduct,
  planogramStatus,
  type PlanogramStatus,
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

/** Порядок статусов в отчёте: ok выше, некалиброванные/без слотов — в конце. */
function statusRank(s: PlanogramStatus): number {
  return s === "ok" ? 0 : 1;
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
}
