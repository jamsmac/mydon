import { Inject, Injectable } from "@nestjs/common";
import { auditLog } from "@mydon/db";
import { desc } from "drizzle-orm";
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

  async list(limit = 50): Promise<(typeof auditLog.$inferSelect)[]> {
    return this.db.select().from(auditLog).orderBy(desc(auditLog.ts)).limit(limit);
  }
}
