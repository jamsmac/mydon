import { Inject, Injectable } from "@nestjs/common";
import { event } from "@mydon/db";
import { and, desc, eq, gte, sql, type SQL } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";

type EventRow = typeof event.$inferSelect;

export interface RecordEventInput {
  source: string;
  type: string;
  payload?: Record<string, unknown>;
  occurredAt?: Date;
}

/**
 * Шина событий: всё, что произошло. Вход для правил уведомлений (ТЗ FR-2)
 * и для утреннего брифинга (FR-6).
 */
@Injectable()
export class EventsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async record(input: RecordEventInput): Promise<EventRow> {
    const [created] = await this.db
      .insert(event)
      .values({
        source: input.source,
        type: input.type,
        payload: input.payload ?? {},
        ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
      })
      .returning();
    return created;
  }

  async list(filter: { type?: string; since?: Date; limit?: number } = {}): Promise<EventRow[]> {
    const conditions: SQL[] = [];
    if (filter.type) conditions.push(eq(event.type, filter.type));
    if (filter.since) conditions.push(gte(event.occurredAt, filter.since));

    return this.db
      .select()
      .from(event)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(event.occurredAt))
      .limit(Math.min(filter.limit ?? 100, 500));
  }

  /**
   * Сколько событий подходит под фильтр. Нужно для лимита действий агента: он
   * считает свои `agent.action` за сутки по журналу, а не по счётчику в памяти —
   * тот разошёлся бы с фактом при перезапуске контейнера.
   */
  async count(filter: { source?: string; type?: string; since?: Date } = {}): Promise<number> {
    const conditions: SQL[] = [];
    if (filter.source) conditions.push(eq(event.source, filter.source));
    if (filter.type) conditions.push(eq(event.type, filter.type));
    if (filter.since) conditions.push(gte(event.occurredAt, filter.since));
    const [row] = await this.db
      .select({ n: sql<number>`count(*)` })
      .from(event)
      .where(conditions.length ? and(...conditions) : undefined);
    return Number(row?.n ?? 0);
  }
}
