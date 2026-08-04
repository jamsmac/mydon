import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { auditLog, entity, grPreorder, org } from "@mydon/db";
import {
  PREORDER_ACTIONS,
  preorderActionError,
  type Domain,
  type PreorderStatus,
} from "@mydon/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { EventsService } from "../events/events.service";

type PreorderRow = typeof grPreorder.$inferSelect;

export interface CreatePreorderInput {
  domain: Domain;
  name: string;
  qty?: number;
  modelId?: string;
  clientId?: string;
  supplierId?: string;
  notes?: string;
  /** true — сразу в requested (submit_immediately донора). */
  submitImmediately?: boolean;
}

export interface PreorderListRow extends PreorderRow {
  clientName: string | null;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Предзаказы GLOBERENT — перенос pre_orders PROMACH: 8 статусов,
 * ALLOWED_TRANSITIONS дословно (shared/preorder-status), переходы атомарны
 * (UPDATE WHERE status IN fromStatuses), отмена — только с причиной.
 */
@Injectable()
export class PreordersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly events: EventsService,
  ) {}

  private async orgId(domain: Domain): Promise<string> {
    const [row] = await this.db.select({ id: org.id }).from(org).where(eq(org.code, domain));
    if (!row) throw new NotFoundException(`Направление "${domain}" не заведено (pnpm db:seed)`);
    return row.id;
  }

  async list(domain: Domain): Promise<PreorderListRow[]> {
    const orgId = await this.orgId(domain);
    const rows = await this.db
      .select({ preorder: grPreorder, clientName: entity.name })
      .from(grPreorder)
      .leftJoin(entity, eq(entity.id, grPreorder.clientId))
      .where(eq(grPreorder.orgId, orgId))
      .orderBy(desc(grPreorder.createdAt))
      .limit(500);
    return rows.map((r) => ({ ...r.preorder, clientName: r.clientName }));
  }

  async create(input: CreatePreorderInput, actorRef = "owner"): Promise<PreorderRow> {
    if ((input.name ?? "").trim().length < 2) {
      throw new BadRequestException("Впиши, что заказываем (модель)");
    }
    const qty = input.qty ?? 1;
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new BadRequestException("Количество — целое больше нуля");
    }
    const orgId = await this.orgId(input.domain);
    return this.db.transaction(async (tx) => {
      const [m] = await tx
        .select({
          n: sql<string>`coalesce(max((substring(${grPreorder.code} from 4))::int), 0)::text`,
        })
        .from(grPreorder)
        .where(eq(grPreorder.orgId, orgId));
      const code = `PO-${String(Number(m?.n ?? "0") + 1).padStart(4, "0")}`;
      const [created] = await tx
        .insert(grPreorder)
        .values({
          orgId,
          domain: input.domain,
          code,
          name: input.name.trim(),
          qty,
          modelId: input.modelId ?? null,
          clientId: input.clientId ?? null,
          supplierId: input.supplierId ?? null,
          notes: input.notes ?? null,
          status: input.submitImmediately === true ? "requested" : "draft",
          createdBy: actorRef,
        })
        .returning();
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "preorder.create",
        target: created.id,
        after: created,
      });
      return created;
    });
  }

  /**
   * Переход по матрице. order требует contract_ref (правило донора);
   * атомарность — статус проверяется и в WHERE (конкурентная защита донора).
   */
  async applyAction(
    id: string,
    action: string,
    extra: { contractRef?: string; factoryPriceUsd?: number; promisedDeliveryDate?: string } = {},
    actorRef = "owner",
  ): Promise<PreorderRow> {
    const t = PREORDER_ACTIONS[action];
    if (t === undefined) throw new BadRequestException(`Неизвестное действие «${action}»`);
    if (action === "order" && (extra.contractRef ?? "").trim() === "") {
      throw new BadRequestException("Для «заказан заводу» обязательна ссылка на контракт");
    }
    if (
      extra.promisedDeliveryDate !== undefined &&
      !ISO_DAY.test(extra.promisedDeliveryDate)
    ) {
      throw new BadRequestException("Обещанная дата поставки — ГГГГ-ММ-ДД");
    }
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(grPreorder).where(eq(grPreorder.id, id)).for("update");
      if (!before) throw new NotFoundException("Предзаказ не найден");
      const err = preorderActionError(action, before.status);
      if (err !== null) throw new ConflictException(err);
      const [updated] = await tx
        .update(grPreorder)
        .set({
          status: t.to,
          updatedAt: new Date(),
          ...(action === "order"
            ? {
                contractRef: extra.contractRef?.trim(),
                ...(extra.factoryPriceUsd !== undefined
                  ? { factoryPriceUsd: String(extra.factoryPriceUsd) }
                  : {}),
                ...(extra.promisedDeliveryDate !== undefined
                  ? { promisedDeliveryDate: extra.promisedDeliveryDate }
                  : {}),
              }
            : {}),
        })
        .where(and(eq(grPreorder.id, id), inArray(grPreorder.status, [...t.from])))
        .returning();
      if (!updated) {
        throw new ConflictException("Статус уже изменён параллельным действием — обнови список");
      }
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: `preorder.${action}`,
        target: id,
        before: { status: before.status },
        after: { status: updated.status },
      });
      return updated;
    }).then(async (row) => {
      await this.events.record({
        source: "preorders",
        type: "preorder.status_changed",
        payload: { preorderId: id, action, to: t.to },
      });
      return row;
    });
  }

  /** Отмена — из любого нетерминального, причина обязательна (правило донора). */
  async cancel(id: string, reason: string, actorRef = "owner"): Promise<PreorderRow> {
    if ((reason ?? "").trim() === "") {
      throw new BadRequestException("Причина отмены обязательна — иначе уроки не выучатся");
    }
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(grPreorder).where(eq(grPreorder.id, id)).for("update");
      if (!before) throw new NotFoundException("Предзаказ не найден");
      if (before.status === "closed" || before.status === "cancelled") {
        throw new ConflictException("Предзаказ уже в терминальном статусе");
      }
      const [updated] = await tx
        .update(grPreorder)
        .set({ status: "cancelled" as PreorderStatus, cancelledReason: reason.trim(), updatedAt: new Date() })
        .where(eq(grPreorder.id, id))
        .returning();
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "preorder.cancelled",
        target: id,
        before: { status: before.status },
        after: { reason: reason.trim() },
      });
      return updated;
    });
  }
}
