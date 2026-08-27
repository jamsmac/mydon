import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  auditLog,
  event,
  person,
  vendingCashSession,
  vendingRefill,
  vendingStock,
  vendingStockCount,
} from "@mydon/db";
import { can, type CashCategorySummary } from "@mydon/shared";
import { DB, type Db } from "../db/db.module";
import { readIntSetting } from "../system/settings";

export type CancelKind = "refill" | "stock_count" | "cash";

export interface CancelActor {
  personId: string;
  ref: string;
}

export type CancelResult =
  | { ok: true; kind: CancelKind; stornoId: string; label: string; alreadyCancelled: boolean }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_yours" }
  | { ok: false; reason: "too_old"; hours: number };

function denied(
  isAdmin: boolean,
  isAuthor: boolean,
  createdAt: Date,
  now: Date,
  hours: number,
): Extract<CancelResult, { ok: false }> | null {
  if (isAdmin) return null;
  if (!isAuthor) return { ok: false, reason: "not_yours" };
  if (now.getTime() - createdAt.getTime() > hours * 3_600_000) {
    return { ok: false, reason: "too_old", hours };
  }
  return null;
}

function negativeMoney(value: string): string {
  const result = -Number(value);
  return (Object.is(result, -0) ? 0 : result).toFixed(2);
}

function negativeCategories(categories: CashCategorySummary[]): CashCategorySummary[] {
  return categories.map((category) => ({
    ...category,
    subtotal: -Number(category.subtotal),
    lines: category.lines.map((line) => ({ ...line, amount: -Number(line.amount) })),
  }));
}

@Injectable()
export class RecordCancelService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Сторно живёт одной транзакцией; `now` параметром делает окно проверяемым. */
  async cancel(kind: CancelKind, id: string, actor: CancelActor, now: Date): Promise<CancelResult> {
    const [[actorRow], hours] = await Promise.all([
      this.db.select({ roles: person.roles }).from(person).where(eq(person.id, actor.personId)).limit(1),
      readIntSetting(this.db, "SNACK_CANCEL_WINDOW_HOURS", 24),
    ]);
    const isAdmin = can(actorRow?.roles ?? [], "system.admin");

    return this.db.transaction(async (tx): Promise<CancelResult> => {
      const record = async (
        recordId: string,
        stornoId: string,
        label: string,
        author: string | null,
        before: unknown,
        after: unknown,
      ) => {
        await tx.insert(event).values({
          source: "human",
          type: "vending.record_cancelled",
          payload: { kind, recordId, stornoId, label, author, cancelledBy: actor.ref },
          occurredAt: now,
        });
        await tx.insert(auditLog).values({
          actorKind: "human",
          actorRef: actor.ref,
          action: `vending.${kind}.cancel`,
          target: recordId,
          before,
          after,
          ts: now,
        });
      };

      if (kind === "refill") {
        const [original] = await tx.select().from(vendingRefill).where(eq(vendingRefill.id, id)).limit(1);
        if (!original || original.source === "storno") return { ok: false, reason: "not_found" };
        const access = denied(isAdmin, original.createdBy === actor.ref, original.createdAt, now, hours);
        if (access) return access;

        const [storno] = await tx
          .insert(vendingRefill)
          .values({
            machineId: original.machineId,
            machineSerial: original.machineSerial,
            coilId: original.coilId,
            productId: original.productId,
            productName: original.productName,
            qty: -original.qty,
            personId: actor.personId,
            taskId: original.taskId,
            performedAt: now,
            clientKey: `storno:${original.id}`,
            source: "storno",
            note: original.note,
            createdBy: actor.ref,
            reversesId: original.id,
          })
          .onConflictDoNothing({ target: vendingRefill.clientKey })
          .returning();
        const label = `↩️ Отмена заправки автомата ${original.machineSerial}: ${original.productName} ×${Math.abs(original.qty)}`;
        if (!storno) {
          const [existing] = await tx
            .select({ id: vendingRefill.id })
            .from(vendingRefill)
            .where(eq(vendingRefill.clientKey, `storno:${original.id}`))
            .limit(1);
          return { ok: true, kind, stornoId: existing?.id ?? original.id, label, alreadyCancelled: true };
        }

        await tx
          .insert(vendingStock)
          .values({
            productName: original.productName,
            productId: original.productId,
            quantity: original.qty,
            countedAt: now,
          })
          .onConflictDoUpdate({
            target: [vendingStock.productName],
            set: {
              quantity: sql`${vendingStock.quantity} + ${original.qty}`,
              productId: sql`coalesce(${vendingStock.productId}, excluded.product_id)`,
              updatedAt: now,
            },
          });
        await record(original.id, storno.id, label, original.createdBy, original, storno);
        return { ok: true, kind, stornoId: storno.id, label, alreadyCancelled: false };
      }

      if (kind === "stock_count") {
        const [original] = await tx.select().from(vendingStockCount).where(eq(vendingStockCount.id, id)).limit(1);
        if (!original || original.source !== "own") return { ok: false, reason: "not_found" };
        const access = denied(isAdmin, original.personId === actor.personId, original.createdAt, now, hours);
        if (access) return access;

        const group = await tx
          .select()
          .from(vendingStockCount)
          .where(
            and(
              eq(vendingStockCount.source, "own"),
              eq(vendingStockCount.countedAt, original.countedAt),
              original.personId === null
                ? isNull(vendingStockCount.personId)
                : eq(vendingStockCount.personId, original.personId),
            ),
          );
        const created: (typeof vendingStockCount.$inferSelect)[] = [];
        for (const row of group) {
          const [storno] = await tx
            .insert(vendingStockCount)
            .values({
              dt: row.dt,
              productName: row.productName,
              productId: row.productId,
              qty: row.qty,
              source: "storno",
              extId: null,
              countedAt: row.countedAt,
              personId: row.personId,
              note: "отмена",
              reversesId: row.id,
            })
            .onConflictDoNothing({
              target: vendingStockCount.reversesId,
              where: sql`${vendingStockCount.source} = 'storno'`,
            })
            .returning();
          if (storno) created.push(storno);
        }
        const label = `📦 Пересчёт склада: ${group.length} позиций`;
        if (created.length === 0) {
          const [existing] = await tx
            .select({ id: vendingStockCount.id })
            .from(vendingStockCount)
            .where(and(eq(vendingStockCount.source, "storno"), eq(vendingStockCount.reversesId, original.id)))
            .limit(1);
          return { ok: true, kind, stornoId: existing?.id ?? original.id, label, alreadyCancelled: true };
        }
        await record(original.id, created[0]!.id, label, original.personId, group, created);
        return { ok: true, kind, stornoId: created[0]!.id, label, alreadyCancelled: false };
      }

      const [original] = await tx.select().from(vendingCashSession).where(eq(vendingCashSession.id, id)).limit(1);
      if (!original || original.source === "storno") return { ok: false, reason: "not_found" };
      const access = denied(isAdmin, original.createdBy === actor.ref, original.createdAt, now, hours);
      if (access) return access;
      const [storno] = await tx
        .insert(vendingCashSession)
        .values({
          receivedAmount: negativeMoney(original.receivedAmount),
          categories: negativeCategories(original.categories),
          totalSpent: negativeMoney(original.totalSpent),
          remainder: negativeMoney(original.remainder),
          source: "storno",
          createdBy: actor.ref,
          reversesId: original.id,
        })
        .onConflictDoNothing({
          target: vendingCashSession.reversesId,
          where: sql`${vendingCashSession.source} = 'storno'`,
        })
        .returning();
      const label = `↩️ Отмена кассы закупа: получил ${Math.abs(Number(original.receivedAmount))} сум`;
      if (!storno) {
        const [existing] = await tx
          .select({ id: vendingCashSession.id })
          .from(vendingCashSession)
          .where(and(eq(vendingCashSession.source, "storno"), eq(vendingCashSession.reversesId, original.id)))
          .limit(1);
        return { ok: true, kind, stornoId: existing?.id ?? original.id, label, alreadyCancelled: true };
      }
      await record(original.id, storno.id, label, original.createdBy, original, storno);
      return { ok: true, kind, stornoId: storno.id, label, alreadyCancelled: false };
    });
  }
}
