import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { auditLog, entity, globerentUnit, org, unitReserve } from "@mydon/db";
import {
  RESERVE_ALLOWED,
  SALE_START_ALLOWED,
  SALES_STAGES,
  STAGES_REQUIRE_PRICE,
  TZ,
  UNIT_GROUPS,
  UNIT_TRANSITIONS,
  unitTransitionError,
  VIN_UNBIND_ALLOWED,
  type Domain,
  type SalesStage,
  type UnitStatus,
} from "@mydon/shared";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { EventsService } from "../events/events.service";

type UnitRow = typeof globerentUnit.$inferSelect;
type ReserveRow = typeof unitReserve.$inferSelect;

export interface CreateUnitInput {
  domain: Domain;
  name: string;
  modelId?: string;
  year?: number;
  vin?: string;
  /** true — своя техника сразу на складе (IN_STOCK), иначе заявка (NEW_REQUEST). */
  inStock?: boolean;
  salesPrice?: number;
  notes?: string;
}

export interface UnitListRow extends UnitRow {
  clientName: string | null;
  activeReserve: ReserveRow | null;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Склад техники GLOBERENT — перенос warehouse_vehicles PROMACH.
 * Все смены статуса идут через applyAction: единая матрица переходов из
 * shared, идемпотентный UPDATE (WHERE status = ANY), аудит и событие.
 */
@Injectable()
export class UnitsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly events: EventsService,
  ) {}

  private async orgId(domain: Domain): Promise<string> {
    const [row] = await this.db.select({ id: org.id }).from(org).where(eq(org.code, domain));
    if (!row) throw new NotFoundException(`Направление "${domain}" не заведено (pnpm db:seed)`);
    return row.id;
  }

  private todayKey(): string {
    return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  }

  /**
   * Снятие просроченных резервов — при каждом чтении списка (паттерн донора):
   * active с end_date < сегодня → expired; RESERVED без активного резерва → IN_STOCK.
   */
  private async expireReserves(): Promise<void> {
    const today = this.todayKey();
    await this.db
      .update(unitReserve)
      .set({ status: "expired" })
      .where(and(eq(unitReserve.status, "active"), lt(unitReserve.endDate, today)));
    await this.db.execute(sql`
      update ${globerentUnit} u set status = 'IN_STOCK', updated_at = now()
      where u.status = 'RESERVED'
        and not exists (
          select 1 from ${unitReserve} r
          where r.unit_id = u.id and r.status = 'active'
        )
    `);
  }

  async list(domain: Domain, groupKey?: string): Promise<UnitListRow[]> {
    const orgId = await this.orgId(domain);
    await this.expireReserves();
    const conditions = [eq(globerentUnit.orgId, orgId)];
    if (groupKey !== undefined) {
      const group = UNIT_GROUPS.find((g) => g.key === groupKey);
      if (!group) throw new BadRequestException(`Неизвестная группа «${groupKey}»`);
      conditions.push(inArray(globerentUnit.status, [...group.statuses]));
    }
    const rows = await this.db
      .select({ unit: globerentUnit, clientName: entity.name, reserve: unitReserve })
      .from(globerentUnit)
      .leftJoin(entity, eq(entity.id, globerentUnit.clientId))
      .leftJoin(
        unitReserve,
        and(eq(unitReserve.unitId, globerentUnit.id), eq(unitReserve.status, "active")),
      )
      .where(and(...conditions))
      .orderBy(desc(globerentUnit.updatedAt))
      .limit(500);
    return rows.map((r) => ({ ...r.unit, clientName: r.clientName, activeReserve: r.reserve }));
  }

  /** Заявка или своя техника на склад. Складской номер WH-#### — в транзакции. */
  async create(input: CreateUnitInput, actorRef = "owner"): Promise<UnitRow> {
    if ((input.name ?? "").trim().length < 2) {
      throw new BadRequestException("Впиши название единицы (модель, год)");
    }
    if (input.salesPrice !== undefined && (!Number.isFinite(input.salesPrice) || input.salesPrice <= 0)) {
      throw new BadRequestException("Цена продажи — число больше нуля");
    }
    const orgId = await this.orgId(input.domain);
    return this.db.transaction(async (tx) => {
      const [m] = await tx
        .select({
          n: sql<string>`coalesce(max((substring(${globerentUnit.code} from 4))::int), 0)::text`,
        })
        .from(globerentUnit)
        .where(eq(globerentUnit.orgId, orgId));
      const code = `WH-${String(Number(m?.n ?? "0") + 1).padStart(4, "0")}`;
      const [created] = await tx
        .insert(globerentUnit)
        .values({
          orgId,
          domain: input.domain,
          code,
          name: input.name.trim(),
          modelId: input.modelId ?? null,
          year: input.year ?? null,
          vin: input.vin?.trim() || null,
          status: input.inStock === true ? "IN_STOCK" : "NEW_REQUEST",
          arrivalDate: input.inStock === true ? this.todayKey() : null,
          salesPrice: input.salesPrice !== undefined ? String(input.salesPrice) : null,
          notes: input.notes ?? null,
        })
        .returning();
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "unit.create",
        target: created.id,
        after: created,
      });
      return created;
    });
  }

  /**
   * Семантический переход. Матрица — shared UNIT_TRANSITIONS; UPDATE
   * идемпотентен: условие «текущий статус разрешён» стоит в WHERE, гонка
   * двух логистов не даёт двойного перехода.
   */
  async applyAction(
    id: string,
    action: string,
    extra: {
      transportCompany?: string;
      declarationNumber?: string;
      declarationDate?: string;
      arrivalDate?: string;
    } = {},
    actorRef = "owner",
  ): Promise<UnitRow> {
    const t = UNIT_TRANSITIONS[action];
    if (t === undefined) throw new BadRequestException(`Неизвестное действие «${action}»`);
    if (action === "mark-in-transit" && (extra.transportCompany ?? "").trim() === "") {
      throw new BadRequestException("Укажи перевозчика — без него «в пути» не отмечается");
    }
    if (action === "mark-customs-im74" || action === "mark-customs-im40") {
      if ((extra.declarationNumber ?? "").trim() === "") {
        throw new BadRequestException("Укажи номер ГТД");
      }
      if (!ISO_DAY.test(extra.declarationDate ?? "")) {
        throw new BadRequestException("Дата ГТД — в формате ГГГГ-ММ-ДД");
      }
    }
    return this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(globerentUnit)
        .where(eq(globerentUnit.id, id))
        .for("update");
      if (!before) throw new NotFoundException("Единица не найдена");
      const err = unitTransitionError(action, before.status);
      if (err !== null) throw new ConflictException(err);

      const [updated] = await tx
        .update(globerentUnit)
        .set({
          status: t.to,
          updatedAt: new Date(),
          ...(action === "mark-in-transit"
            ? { transportCompany: extra.transportCompany?.trim() }
            : {}),
          ...(action === "mark-customs-im74" || action === "mark-customs-im40"
            ? {
                declarationType: action === "mark-customs-im74" ? "IM74" : "IM40",
                declarationNumber: extra.declarationNumber?.trim(),
                declarationDate: extra.declarationDate,
              }
            : {}),
          ...(action === "mark-delivered"
            ? { arrivalDate: extra.arrivalDate ?? this.todayKey() }
            : {}),
        })
        // Идемпотентность: статус проверяется и в WHERE — гонка не проскочит.
        .where(and(eq(globerentUnit.id, id), inArray(globerentUnit.status, [...t.from])))
        .returning();
      if (!updated) {
        throw new ConflictException("Статус уже изменён параллельным действием — обнови список");
      }
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: `unit.${action}`,
        target: id,
        before: { status: before.status },
        after: { status: updated.status },
      });
      return updated;
    }).then(async (updated) => {
      await this.events.record({
        source: "units",
        type: "unit.status_changed",
        payload: { unitId: id, action, to: t.to },
      });
      return updated;
    });
  }

  /** Привязать VIN (уникален среди заполненных — индекс не даст дубля). */
  async setVin(id: string, vin: string, actorRef = "owner"): Promise<UnitRow> {
    if ((vin ?? "").trim().length < 5) throw new BadRequestException("VIN слишком короткий");
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(globerentUnit).where(eq(globerentUnit.id, id)).for("update");
      if (!before) throw new NotFoundException("Единица не найдена");
      const [updated] = await tx
        .update(globerentUnit)
        .set({ vin: vin.trim(), updatedAt: new Date() })
        .where(eq(globerentUnit.id, id))
        .returning();
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "unit.vin_set",
        target: id,
        before: { vin: before.vin },
        after: { vin: updated.vin },
      });
      return updated;
    });
  }

  /** Откат VIN — только из разрешённых статусов (правило skipped_advanced донора). */
  async unbindVin(id: string, actorRef = "owner"): Promise<UnitRow> {
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(globerentUnit).where(eq(globerentUnit.id, id)).for("update");
      if (!before) throw new NotFoundException("Единица не найдена");
      if (!(VIN_UNBIND_ALLOWED as readonly string[]).includes(before.status)) {
        throw new ConflictException(
          "С этой машиной логист уже работал физически — VIN не откатывается (правило донора)",
        );
      }
      const [updated] = await tx
        .update(globerentUnit)
        .set({ vin: null, status: "CONTRACT_SIGNED", updatedAt: new Date() })
        .where(eq(globerentUnit.id, id))
        .returning();
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "unit.vin_unbind",
        target: id,
        before: { vin: before.vin, status: before.status },
        after: { status: updated.status },
      });
      return updated;
    });
  }

  /** Резерв: только со склада, максимум один активный (частичный индекс — страховка). */
  async reserve(
    id: string,
    input: { endDate: string; clientId?: string; note?: string },
    actorRef = "owner",
  ): Promise<ReserveRow> {
    if (!ISO_DAY.test(input.endDate ?? "")) {
      throw new BadRequestException("«Держим до» — дата в формате ГГГГ-ММ-ДД");
    }
    if (input.endDate < this.todayKey()) {
      throw new BadRequestException("Дата резерва уже прошла");
    }
    return this.db.transaction(async (tx) => {
      const [unit] = await tx.select().from(globerentUnit).where(eq(globerentUnit.id, id)).for("update");
      if (!unit) throw new NotFoundException("Единица не найдена");
      if (!(RESERVE_ALLOWED as readonly string[]).includes(unit.status)) {
        throw new ConflictException("Резерв ставится только на технику на складе");
      }
      const [existing] = await tx
        .select({ id: unitReserve.id })
        .from(unitReserve)
        .where(and(eq(unitReserve.unitId, id), eq(unitReserve.status, "active")))
        .limit(1);
      if (existing) throw new ConflictException("На эту единицу уже есть активный резерв");
      const [created] = await tx
        .insert(unitReserve)
        .values({
          unitId: id,
          clientId: input.clientId ?? null,
          endDate: input.endDate,
          note: input.note ?? null,
          createdBy: actorRef,
        })
        .returning();
      await tx
        .update(globerentUnit)
        .set({ status: "RESERVED", updatedAt: new Date() })
        .where(eq(globerentUnit.id, id));
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "unit.reserved",
        target: id,
        after: created,
      });
      return created;
    });
  }

  /** Снять резерв: единица возвращается на склад, строка остаётся историей. */
  async cancelReserve(id: string, actorRef = "owner"): Promise<UnitRow> {
    return this.db.transaction(async (tx) => {
      const [unit] = await tx.select().from(globerentUnit).where(eq(globerentUnit.id, id)).for("update");
      if (!unit) throw new NotFoundException("Единица не найдена");
      await tx
        .update(unitReserve)
        .set({ status: "cancelled" })
        .where(and(eq(unitReserve.unitId, id), eq(unitReserve.status, "active")));
      const [updated] = await tx
        .update(globerentUnit)
        .set({ status: "IN_STOCK", updatedAt: new Date() })
        .where(and(eq(globerentUnit.id, id), eq(globerentUnit.status, "RESERVED")))
        .returning();
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "unit.reserve_cancelled",
        target: id,
      });
      return updated ?? unit;
    });
  }

  /**
   * Стадия продажи. Старт — только со склада/резерва и только один раз
   * (409 при повторном, правило донора); стадии с деньгами требуют цену.
   */
  async setSalesStage(
    id: string,
    stage: string,
    extra: { lostReason?: string; salesPrice?: number; clientId?: string } = {},
    actorRef = "owner",
  ): Promise<UnitRow> {
    if (!(SALES_STAGES as readonly string[]).includes(stage)) {
      throw new BadRequestException(`Неизвестная стадия «${stage}»`);
    }
    if (stage === "LOST" && (extra.lostReason ?? "").trim() === "") {
      throw new BadRequestException("Для «потеряна» обязательна причина — иначе уроки не выучатся");
    }
    if (extra.salesPrice !== undefined && (!Number.isFinite(extra.salesPrice) || extra.salesPrice <= 0)) {
      throw new BadRequestException("Цена продажи — число больше нуля");
    }
    return this.db.transaction(async (tx) => {
      const [unit] = await tx.select().from(globerentUnit).where(eq(globerentUnit.id, id)).for("update");
      if (!unit) throw new NotFoundException("Единица не найдена");
      if (unit.salesStage === null && !(SALE_START_ALLOWED as readonly string[]).includes(unit.status)) {
        throw new ConflictException("Продажа начинается только по технике на складе или в резерве");
      }
      const price = extra.salesPrice !== undefined ? extra.salesPrice : unit.salesPrice !== null ? Number(unit.salesPrice) : null;
      if ((STAGES_REQUIRE_PRICE as readonly string[]).includes(stage) && (price === null || price <= 0)) {
        throw new ConflictException("Для этой стадии нужна цена продажи — заполни её");
      }
      const [updated] = await tx
        .update(globerentUnit)
        .set({
          salesStage: stage as SalesStage,
          lostReason: stage === "LOST" ? (extra.lostReason ?? "").trim() : unit.lostReason,
          ...(extra.salesPrice !== undefined ? { salesPrice: String(extra.salesPrice) } : {}),
          ...(extra.clientId !== undefined ? { clientId: extra.clientId } : {}),
          updatedAt: new Date(),
        })
        .where(eq(globerentUnit.id, id))
        .returning();
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "unit.sales_stage",
        target: id,
        before: { salesStage: unit.salesStage },
        after: { salesStage: stage },
      });
      return updated;
    });
  }

  /** Сводка по группам конвейера — плитки дашборда. */
  async pipelineSummary(domain: Domain): Promise<{ key: string; label: string; n: number }[]> {
    const orgId = await this.orgId(domain);
    const rows = await this.db
      .select({ status: globerentUnit.status, n: sql<number>`count(*)::int` })
      .from(globerentUnit)
      .where(eq(globerentUnit.orgId, orgId))
      .groupBy(globerentUnit.status);
    const byStatus = new Map(rows.map((r) => [r.status, r.n]));
    return UNIT_GROUPS.map((g) => ({
      key: g.key,
      label: g.label,
      n: g.statuses.reduce((s, st) => s + (byStatus.get(st) ?? 0), 0),
    }));
  }
}

/** Статус, из которого действие уводит (для подсказок UI). */
export type { UnitStatus };
