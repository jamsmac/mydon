import { randomUUID } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { outboxDelivery } from "@mydon/db";
import { and, asc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { hashLedgerPayload } from "../llm-ledger/llm-ledger.money";

type DeliveryRow = typeof outboxDelivery.$inferSelect;
type TerminalStatus = "sent" | "skipped" | "unknown" | "dead";

/**
 * Транспортный outbox Core.
 *
 * Claim переводит intent в dispatching ДО внешнего вызова. Автоматического
 * reclaim намеренно нет: Telegram/Notion не дают общей exactly-once
 * идемпотентности, поэтому зависший dispatch виден оператору как unknown
 * участок, а не повторяется вслепую.
 */
@Injectable()
export class OutboxService {
  static readonly DISPATCH_UNKNOWN_AFTER_MS = 15 * 60_000;

  constructor(@Inject(DB) private readonly db: Db) {}

  async claim(
    destination: string,
    workerRef: string,
    now = new Date(),
  ): Promise<DeliveryRow | null> {
    // Оставлен в API для будущей operational-метрики; fencing identity —
    // случайный leaseToken, а immutable payload менять при claim нельзя.
    void workerRef;
    return this.db.transaction(async (tx) => {
      const staleBefore = new Date(now.getTime() - OutboxService.DISPATCH_UNKNOWN_AFTER_MS);
      // Истёкший claim не возвращается в pending: внешний API мог успеть
      // принять запрос. Делаем неоднозначность явной и ждём reconciliation.
      await tx
        .update(outboxDelivery)
        .set({
          status: "unknown",
          completedAt: now,
          lastError: "dispatch worker не подтвердил исход до истечения lease",
          updatedAt: now,
        })
        .where(
          and(
            eq(outboxDelivery.destination, destination),
            eq(outboxDelivery.status, "dispatching"),
            isNotNull(outboxDelivery.claimedAt),
            lte(outboxDelivery.claimedAt, staleBefore),
          ),
        );

      const [pending] = await tx
        .select()
        .from(outboxDelivery)
        .where(
          and(eq(outboxDelivery.destination, destination), eq(outboxDelivery.status, "pending")),
        )
        .orderBy(asc(outboxDelivery.createdAt))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!pending) return null;

      const leaseToken = randomUUID();
      if (hashLedgerPayload(pending.payload) !== pending.payloadHash) {
        // payloadHash не для красоты: изменённый после commit intent
        // не имеет права уйти во внешний API.
        await tx
          .update(outboxDelivery)
          .set({
            status: "dead",
            leaseToken,
            claimedAt: now,
            completedAt: now,
            attempts: sql`${outboxDelivery.attempts} + 1`,
            lastError: "outbox payload hash mismatch",
            updatedAt: now,
          })
          .where(and(eq(outboxDelivery.id, pending.id), eq(outboxDelivery.status, "pending")));
        return null;
      }
      const [claimed] = await tx
        .update(outboxDelivery)
        .set({
          status: "dispatching",
          leaseToken,
          claimedAt: now,
          attempts: sql`${outboxDelivery.attempts} + 1`,
          lastError: null,
          updatedAt: now,
        })
        .where(and(eq(outboxDelivery.id, pending.id), eq(outboxDelivery.status, "pending")))
        .returning();
      if (!claimed) return null;

      return claimed;
    });
  }

  async complete(
    id: string,
    leaseToken: string,
    status: TerminalStatus,
    options: { providerRef?: string; error?: string } = {},
    now = new Date(),
  ): Promise<DeliveryRow> {
    const providerRef = options.providerRef?.trim().slice(0, 512) || null;
    const lastError = options.error?.trim().slice(0, 2000) || null;
    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(outboxDelivery)
        .set({
          status,
          completedAt: now,
          providerRef,
          lastError,
          updatedAt: now,
        })
        .where(
          and(
            eq(outboxDelivery.id, id),
            eq(outboxDelivery.status, "dispatching"),
            eq(outboxDelivery.leaseToken, leaseToken),
          ),
        )
        .returning();
      if (updated) return updated;

      const [existing] = await tx
        .select()
        .from(outboxDelivery)
        .where(eq(outboxDelivery.id, id))
        .limit(1)
        .for("update");
      if (!existing) throw new NotFoundException(`Outbox delivery ${id} не найдена`);

      // Потерянный HTTP response после terminal UPDATE: exact retry безопасен.
      if (
        existing.leaseToken === leaseToken &&
        existing.status === status &&
        existing.providerRef === providerRef &&
        existing.lastError === lastError
      ) {
        return existing;
      }
      throw new ConflictException(
        "Outbox delivery уже принадлежит другому claim или завершена иначе",
      );
    });
  }
}
