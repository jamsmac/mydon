import { Inject, Injectable } from "@nestjs/common";
import { auditLog } from "@mydon/db";
import { and, desc, eq, gte, like, lt, type SQL } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";

export type ActorKind = "human" | "agent" | "system";

export interface AuditEntry {
  actorKind: ActorKind;
  actorRef?: string | null;
  action: string;
  target?: string | null;
  before?: unknown;
  after?: unknown;
}

/**
 * Журнал действий (ТЗ FR-9): кто/что/когда, включая действия агентов.
 * Пишется на каждое изменение данных.
 */
@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.db.insert(auditLog).values({
      actorKind: entry.actorKind,
      actorRef: entry.actorRef ?? null,
      action: entry.action,
      target: entry.target ?? null,
      before: entry.before ?? null,
      after: entry.after ?? null,
    });
  }

  async list(
    limit = 50,
    filter: { offset?: number; actor?: string; action?: string; from?: string; to?: string } = {},
  ): Promise<(typeof auditLog.$inferSelect)[]> {
    // Границы зажимаем и здесь: контроллер не должен быть единственной защитой
    // от выгрузки всего журнала одним запросом.
    const take = Math.min(Math.max(Number.isFinite(limit) ? Math.trunc(limit) : 50, 1), 500);
    const conditions: SQL[] = [];
    // actor — подстрокой: в actorRef живут person:<id>, telegram:<chat>,
    // agent:<имя>; точного формата у поля нет, и точное равенство промахнётся.
    if (filter.actor) conditions.push(like(auditLog.actorRef, `%${filter.actor}%`));
    if (filter.action) conditions.push(eq(auditLog.action, filter.action));
    // Даты — дни по Ташкенту (пояс фиксированный +05, без переводов).
    if (filter.from) conditions.push(gte(auditLog.ts, new Date(`${filter.from}T00:00:00+05:00`)));
    if (filter.to) {
      conditions.push(lt(auditLog.ts, new Date(new Date(`${filter.to}T00:00:00+05:00`).getTime() + 86_400_000)));
    }
    return this.db
      .select()
      .from(auditLog)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(auditLog.ts))
      .limit(take)
      .offset(Math.min(Math.max(filter.offset ?? 0, 0), 100_000));
  }
}
