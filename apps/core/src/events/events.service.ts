import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { event } from "@mydon/db";
import { and, desc, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { hashLedgerPayload } from "../llm-ledger/llm-ledger.money";

type EventRow = typeof event.$inferSelect;

export interface RecordEventInput {
  source: string;
  type: string;
  payload?: Record<string, unknown>;
  occurredAt?: Date;
  /** Stable key одного логического эффекта; exact retry возвращает ту же строку. */
  clientKey?: string;
}

/**
 * Шина событий: всё, что произошло. Вход для правил уведомлений (ТЗ FR-2)
 * и для утреннего брифинга (FR-6).
 */
@Injectable()
export class EventsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async record(input: RecordEventInput): Promise<EventRow> {
    return this.db.transaction(async (tx) => {
      const payload = input.payload ?? {};
      const [created] = await tx
        .insert(event)
        .values({
          source: input.source,
          type: input.type,
          payload,
          clientKey: input.clientKey ?? null,
          ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
        })
        .onConflictDoNothing({ target: event.clientKey })
        .returning();
      if (created) return created;

      const [existing] = await tx
        .select()
        .from(event)
        .where(eq(event.clientKey, input.clientKey!))
        .limit(1);
      if (!existing) throw new Error("Идемпотентное событие ещё сохраняется — повтори запрос");
      const expected = hashLedgerPayload({ source: input.source, type: input.type, payload });
      const actual = hashLedgerPayload({
        source: existing.source,
        type: existing.type,
        payload: existing.payload,
      });
      if (expected !== actual) {
        throw new ConflictException("clientKey события уже использован другим payload");
      }
      return existing;
    });
  }

  /**
   * Лента событий под фильтр, свежие сверху.
   *
   * `types` — НЕСКОЛЬКО типов сразу, и это не удобство, а требование
   * правильности: лимит режет выборку ПОСЛЕ сортировки, поэтому шум крона
   * (2091 `sales.sync` + 2089 `supply.sync` за 14 суток на проде) съедал все
   * 500 строк и окно «за неделю» превращалось в 37 часов — молча, с виду
   * здоровым ответом. Фильтр обязан стоять в SQL, до лимита.
   */
  async list(filter: { type?: string; types?: readonly string[]; since?: Date; limit?: number } = {}): Promise<EventRow[]> {
    const conditions: SQL[] = [];
    if (filter.type) conditions.push(eq(event.type, filter.type));
    if (filter.types && filter.types.length > 0) conditions.push(inArray(event.type, [...filter.types]));
    if (filter.since) conditions.push(gte(event.occurredAt, filter.since));

    return this.db
      .select()
      .from(event)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(event.occurredAt))
      .limit(Math.min(filter.limit ?? 100, 500));
  }

  /**
   * Самое свежее событие под фильтр source+type (или undefined, если ни одного).
   *
   * Нужно для дельта-памяти агента: он вспоминает СВОЙ прошлый результат по
   * журналу (последнее событие `agent.memory:<навык>`), а не из памяти процесса —
   * иначе после рестарта контейнера агент «забыл бы» и повторил бы то же самое.
   */
  async latest(filter: { source?: string; type?: string } = {}): Promise<EventRow | undefined> {
    const conditions: SQL[] = [];
    if (filter.source) conditions.push(eq(event.source, filter.source));
    if (filter.type) conditions.push(eq(event.type, filter.type));
    const [row] = await this.db
      .select()
      .from(event)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(event.occurredAt))
      .limit(1);
    return row;
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
