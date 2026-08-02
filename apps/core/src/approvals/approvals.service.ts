import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { approval, auditLog, entity, event, org, vendingPurchaseOrder } from "@mydon/db";
import { and, desc, eq, type SQL } from "drizzle-orm";
import { DOMAINS, type Domain } from "@mydon/shared";
import { DB, type Db } from "../db/db.module";
import { AuditService } from "../audit/audit.service";
import { EventsService } from "../events/events.service";

type ApprovalRow = typeof approval.$inferSelect;
/** Тип транзакции drizzle: выводится из сигнатуры db.transaction. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
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

  /** Запрос агента. Всё одной транзакцией: запрос без следа в журнале недопустим. */
  async request(input: RequestApprovalInput): Promise<ApprovalRow> {
    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(approval)
        .values({
          agent: input.agent,
          action: input.action,
          tier: input.tier,
          payload: input.payload ?? {},
        })
        .returning();

      await tx.insert(event).values({
        source: `agent:${input.agent}`,
        type: "approval.requested",
        payload: { approvalId: created.id, action: input.action, tier: input.tier },
      });
      await tx.insert(auditLog).values({
        actorKind: "agent",
        actorRef: input.agent,
        action: "approval.request",
        target: created.id,
        after: created,
      });

      return created;
    });
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

  /**
   * Решение принимает только владелец — фиксируется в журнале (ТЗ FR-3, FR-9).
   *
   * Запись атомарна намеренно. Раньше проверка «уже закрыт» и UPDATE были
   * отдельными запросами: два одновременных нажатия в боте («Отклонить», затем
   * сразу «Одобрить») проходили ОБА, инициатор получал один ответ, а в базе
   * оставался другой. Теперь условие decision='pending' стоит в самом UPDATE —
   * побеждает ровно один вызов.
   *
   * Изменение, событие и запись в журнал идут одной транзакцией: иначе решение
   * могло сохраниться, а журнал остаться пустым — и кто согласовал платёж,
   * установить было бы невозможно.
   */
  async decide(id: string, decision: Decision, actorRef: string): Promise<ApprovalRow> {
    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(approval)
        .set({ decision, decidedAt: new Date() })
        .where(and(eq(approval.id, id), eq(approval.decision, "pending")))
        .returning();

      if (!updated) {
        // Ничего не обновилось — разбираемся почему: нет запроса или он уже закрыт.
        const [row] = await tx.select().from(approval).where(eq(approval.id, id));
        if (!row) throw new NotFoundException(`Запрос на согласование ${id} не найден`);
        throw new BadRequestException(
          `Запрос ${id} уже закрыт решением "${row.decision}" — повторное решение не принимается.`,
        );
      }

      await tx.insert(event).values({
        source: "owner",
        type: "approval.decided",
        payload: { approvalId: id, decision },
      });
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: `approval.${decision}`,
        target: id,
        before: { ...updated, decision: "pending", decidedAt: null },
        after: updated,
      });

      // Одобрение исполняется сразу, той же транзакцией: «одобрить» должно
      // означать «результат появился», а не «записано в журнал». По виду payload
      // выбираем исполнителя — импорт карточек или накладная закупа.
      if (decision === "approved") {
        await this.executeImport(tx, updated, actorRef);
        await this.executePurchaseOrder(tx, updated, actorRef);
      }

      return updated;
    });
  }

  /**
   * Исполнение одобренного импорта: payload.import = { domain, type, records }.
   *
   * Дубли не плодим: запись с тем же названием и типом внутри направления
   * пропускается — повторное одобрение того же списка безопасно.
   * Кривой payload — не ошибка решения: одобрение остаётся, импорт пропускается.
   */
  private async executeImport(tx: Tx, row: ApprovalRow, actorRef: string): Promise<void> {
    const imp = (row.payload as { import?: unknown } | null)?.import as
      | { domain?: unknown; type?: unknown; records?: unknown }
      | undefined;
    if (!imp || typeof imp !== "object") return;

    const domain = typeof imp.domain === "string" ? imp.domain : "";
    const type = typeof imp.type === "string" ? imp.type.slice(0, 64) : "";
    const records = Array.isArray(imp.records) ? imp.records.slice(0, 500) : [];
    if (!DOMAINS.includes(domain as Domain) || type.length === 0 || records.length === 0) return;

    const [orgRow] = await tx.select().from(org).where(eq(org.code, domain as Domain)).limit(1);
    if (!orgRow) return;

    let created = 0;
    let skipped = 0;
    for (const r of records) {
      const rec = r as { name?: unknown; externalRef?: unknown; attrs?: unknown };
      const name = typeof rec.name === "string" ? rec.name.trim().slice(0, 512) : "";
      if (name.length === 0) continue;

      // Идентичность записи — внешний номер (серийник, ИНН), если он есть:
      // две машины могут стоять в одной точке с одинаковым названием.
      const ref = typeof rec.externalRef === "string" && rec.externalRef.length > 0
        ? rec.externalRef.slice(0, 256)
        : null;
      const [existing] = await tx
        .select({ id: entity.id })
        .from(entity)
        .where(
          and(
            eq(entity.orgId, orgRow.id),
            eq(entity.type, type),
            ref !== null ? eq(entity.externalRef, ref) : eq(entity.name, name),
          ),
        )
        .limit(1);
      if (existing) {
        skipped += 1;
        continue;
      }

      const [createdRow] = await tx
        .insert(entity)
        .values({
          orgId: orgRow.id,
          type,
          name,
          externalRef: ref,
          attrs:
            rec.attrs !== null && typeof rec.attrs === "object"
              ? (rec.attrs as Record<string, unknown>)
              : {},
        })
        .returning();
      created += 1;

      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "entity.create",
        target: createdRow.id,
        after: createdRow,
      });
    }

    await tx.insert(event).values({
      source: "owner",
      type: "import.executed",
      payload: { approvalId: row.id, domain, type, created, skipped },
    });
  }

  /**
   * Материализация накладной закупа при одобрении: payload.purchaseOrder →
   * строка `vending_purchase_order`. Снимок цифр берётся из заявки (зафиксирован
   * на момент решения, не пересчитывается). Идемпотентно: approval_id уникален,
   * повторное одобрение той же заявки невозможно (decide закрывает pending), а
   * ручной ретрай упрётся в уникальность — дубль-накладной не будет.
   * Нет/кривой payload — не ошибка решения: одобрение остаётся, накладная нет.
   */
  private async executePurchaseOrder(tx: Tx, row: ApprovalRow, actorRef: string): Promise<void> {
    const po = (row.payload as { purchaseOrder?: unknown } | null)?.purchaseOrder as
      | { positions?: unknown; totalBuy?: unknown; totalOrder?: unknown; costExact?: unknown; costRounded?: unknown; createdBy?: unknown }
      | undefined;
    if (!po || typeof po !== "object") return;

    const positions = Array.isArray(po.positions) ? po.positions : [];
    if (positions.length === 0) return;

    const int = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0);
    const money = (v: unknown): string => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : "0");

    const [order] = await tx
      .insert(vendingPurchaseOrder)
      .values({
        approvalId: row.id,
        positions,
        totalBuy: int(po.totalBuy),
        totalOrder: int(po.totalOrder),
        costExact: money(po.costExact),
        costRounded: money(po.costRounded),
        createdBy: typeof po.createdBy === "string" ? po.createdBy.slice(0, 128) : null,
      })
      .returning();

    await tx.insert(event).values({
      source: "owner",
      type: "vending.purchase_order.created",
      payload: { approvalId: row.id, orderId: order.id, positions: positions.length, costRounded: money(po.costRounded) },
    });
    await tx.insert(auditLog).values({
      actorKind: "human",
      actorRef,
      action: "vending.purchase_order.create",
      target: order.id,
      after: order,
    });
  }
}
