import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { auditLog, collection, entity, person } from "@mydon/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";

type CollectionRow = typeof collection.$inferSelect;

export interface CreateCollectionInput {
  machineId: string;
  operatorId?: string;
  collectedAt?: string;
  source?: "realtime" | "manual_history" | "import";
  notes?: string;
}

/** Строка списка: с именами автомата и оператора — панель и бот не делают лишних запросов. */
export interface CollectionListRow extends CollectionRow {
  machineName: string | null;
  operatorName: string | null;
}

/**
 * Инкассация (перенос VendCash внутрь MYDON, спецификация vendcash-specification.md).
 *
 * Двухэтапность — суть системы: оператор фиксирует ФАКТ и ВРЕМЯ сбора (до
 * секунды), деньги едут к менеджеру, менеджер пересчитывает и вводит СУММУ.
 * Пока сумма не введена — инкассация «ожидает приёма», и это видно владельцу.
 */
@Injectable()
export class CollectionsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Этап 1: оператор собрал деньги. Время фиксируется сейчас, если не передано. */
  async create(input: CreateCollectionInput, actorRef = "bot"): Promise<CollectionRow> {
    return this.db.transaction(async (tx) => {
      const [machine] = await tx.select().from(entity).where(eq(entity.id, input.machineId)).limit(1);
      if (!machine) throw new NotFoundException(`Автомат ${input.machineId} не найден`);
      if (machine.type !== "machine") {
        throw new BadRequestException("Инкассация возможна только по автомату");
      }

      const [created] = await tx
        .insert(collection)
        .values({
          machineId: input.machineId,
          operatorId: input.operatorId ?? null,
          collectedAt: input.collectedAt ? new Date(input.collectedAt) : new Date(),
          source: input.source ?? "realtime",
          notes: input.notes ?? null,
        })
        .returning();

      await tx.insert(auditLog).values({
        actorKind: input.operatorId ? "human" : "system",
        actorRef,
        action: "collection.collected",
        target: created.id,
        after: created,
      });
      return created;
    });
  }

  /** Этап 2: менеджер принял и пересчитал. Сумма обязательна. */
  async receive(id: string, amount: number, managerRef = "owner"): Promise<CollectionRow> {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new BadRequestException("Сумма должна быть числом не меньше нуля");
    }
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(collection).where(eq(collection.id, id)).for("update");
      if (!row) throw new NotFoundException(`Инкассация ${id} не найдена`);
      if (row.status !== "collected") {
        throw new BadRequestException(`Инкассация уже закрыта (${row.status})`);
      }
      const [updated] = await tx
        .update(collection)
        .set({ status: "received", amount: String(amount), receivedAt: new Date(), managerRef })
        .where(eq(collection.id, id))
        .returning();

      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef: managerRef,
        action: "collection.received",
        target: id,
        before: row,
        after: updated,
      });
      return updated;
    });
  }

  /** Отмена (ошибочная фиксация). След остаётся — строка не удаляется. */
  async cancel(id: string, managerRef = "owner"): Promise<CollectionRow> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(collection).where(eq(collection.id, id)).for("update");
      if (!row) throw new NotFoundException(`Инкассация ${id} не найдена`);
      if (row.status !== "collected") {
        throw new BadRequestException(`Инкассация уже закрыта (${row.status})`);
      }
      const [updated] = await tx
        .update(collection)
        .set({ status: "cancelled", managerRef })
        .where(eq(collection.id, id))
        .returning();
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef: managerRef,
        action: "collection.cancelled",
        target: id,
        before: row,
        after: updated,
      });
      return updated;
    });
  }

  /** Список с именами: ожидающие приёма или принятые за период. */
  async list(opts: { status?: "collected" | "received" | "cancelled"; days?: number; limit?: number } = {}): Promise<CollectionListRow[]> {
    const conditions = [];
    if (opts.status) conditions.push(eq(collection.status, opts.status));
    if (opts.days) {
      conditions.push(gte(collection.collectedAt, new Date(Date.now() - opts.days * 24 * 3600_000)));
    }
    const rows = await this.db
      .select({
        row: collection,
        machineName: entity.name,
        operatorName: person.name,
      })
      .from(collection)
      .leftJoin(entity, eq(entity.id, collection.machineId))
      .leftJoin(person, eq(person.id, collection.operatorId))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(collection.collectedAt))
      .limit(opts.limit ?? 200);

    return rows.map((r) => ({ ...r.row, machineName: r.machineName, operatorName: r.operatorName }));
  }

  /** Итоги для дашборда: сколько ждёт приёма, сколько принято и на какую сумму. */
  async summary(days = 30): Promise<{
    pending: number;
    receivedCount: number;
    receivedSum: number;
    days: number;
  }> {
    const since = new Date(Date.now() - days * 24 * 3600_000);
    const [row] = await this.db
      .select({
        pending: sql<number>`count(*) filter (where ${collection.status} = 'collected')`,
        receivedCount: sql<number>`count(*) filter (where ${collection.status} = 'received' and ${collection.collectedAt} >= ${since.toISOString()}::timestamptz)`,
        receivedSum: sql<string>`coalesce(sum(${collection.amount}) filter (where ${collection.status} = 'received' and ${collection.collectedAt} >= ${since.toISOString()}::timestamptz), 0)::text`,
      })
      .from(collection);
    return {
      pending: Number(row?.pending ?? 0),
      receivedCount: Number(row?.receivedCount ?? 0),
      receivedSum: Number(row?.receivedSum ?? 0),
      days,
    };
  }
}
