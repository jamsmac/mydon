import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { approval } from "@mydon/db";
import { and, desc, eq, type SQL } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { AuditService } from "../audit/audit.service";
import { EventsService } from "../events/events.service";

type ApprovalRow = typeof approval.$inferSelect;
type Tier = "T0" | "T1" | "T2" | "T3" | "T4";
type Decision = "approved" | "rejected" | "clarify";

export interface RequestApprovalInput {
  agent: string;
  action: string;
  tier: Tier;
  payload?: Record<string, unknown>;
}

/**
 * Очередь согласований (ТЗ FR-3). Агенты не действуют напрямую:
 * они создают запрос, владелец решает, решение уходит в журнал.
 * Текущий порог владельца (Ф6) — всё вручную.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly events: EventsService,
  ) {}

  async request(input: RequestApprovalInput): Promise<ApprovalRow> {
    const [created] = await this.db
      .insert(approval)
      .values({
        agent: input.agent,
        action: input.action,
        tier: input.tier,
        payload: input.payload ?? {},
      })
      .returning();

    await this.events.record({
      source: `agent:${input.agent}`,
      type: "approval.requested",
      payload: { approvalId: created.id, action: input.action, tier: input.tier },
    });
    await this.audit.record({
      actorKind: "agent",
      actorRef: input.agent,
      action: "approval.request",
      target: created.id,
      after: created,
    });
    return created;
  }

  async pending(): Promise<ApprovalRow[]> {
    return this.db
      .select()
      .from(approval)
      .where(eq(approval.decision, "pending"))
      .orderBy(desc(approval.createdAt));
  }

  async list(filter: { decision?: ApprovalRow["decision"] } = {}): Promise<ApprovalRow[]> {
    const conditions: SQL[] = [];
    if (filter.decision) conditions.push(eq(approval.decision, filter.decision));
    return this.db
      .select()
      .from(approval)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(approval.createdAt))
      .limit(200);
  }

  /** Решение принимает только владелец — фиксируется в журнале (ТЗ FR-3, FR-9). */
  async decide(id: string, decision: Decision, actorRef: string): Promise<ApprovalRow> {
    const [before] = await this.db.select().from(approval).where(eq(approval.id, id));
    if (!before) throw new NotFoundException(`Запрос на согласование ${id} не найден`);
    if (before.decision !== "pending") {
      throw new BadRequestException(
        `Запрос ${id} уже закрыт решением "${before.decision}" — повторное решение не принимается.`,
      );
    }

    const [updated] = await this.db
      .update(approval)
      .set({ decision, decidedAt: new Date() })
      .where(eq(approval.id, id))
      .returning();

    await this.events.record({
      source: "owner",
      type: "approval.decided",
      payload: { approvalId: id, decision },
    });
    await this.audit.record({
      actorKind: "human",
      actorRef,
      action: `approval.${decision}`,
      target: id,
      before,
      after: updated,
    });
    return updated;
  }
}
