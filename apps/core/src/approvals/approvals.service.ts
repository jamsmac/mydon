import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  approval,
  auditLog,
  coffeeConsumable,
  coffeeContainerReturn,
  coffeeLocation,
  coffeeRefill,
  entity,
  event,
  org,
  vendingPurchaseOrder,
} from "@mydon/db";
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
        await this.executeCoffeeImport(tx, updated);
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

  /**
   * Материализация исторического импорта кофе-бункеров при одобрении:
   * `payload.coffeeImport = { records: [...] }` → строки `coffee_refill`.
   * Источник — `tools/import-telegram-coffee.mjs`: LLM извлекает записи из
   * экспорта переписки, но ничего не пишет в базу напрямую — только заявкой,
   * тот же T0-гейт, что и у site-ingest (payload.import).
   *
   * Точка записи — существующий `locationId` ЛИБО `locationName` из списка
   * `newLocations` (исторические точки, которых в справочнике уже нет —
   * создаются здесь же, после «Одобрить»). Остальному payload не доверяем:
   * модель могла ошибиться или выдумать точку.
   * Дубли (тот же адрес/позиция/дата/вес/упаковки) пропускаются — повторное
   * одобрение или ретрай импорта безопасны. Кривой payload — не ошибка
   * решения: одобрение остаётся, импорт пропускается.
   */
  private async executeCoffeeImport(tx: Tx, row: ApprovalRow): Promise<void> {
    const imp = (row.payload as { coffeeImport?: unknown } | null)?.coffeeImport as
      | { records?: unknown; returns?: unknown; consumables?: unknown; newLocations?: unknown }
      | undefined;
    if (!imp || typeof imp !== "object") return;
    const records = Array.isArray(imp.records) ? imp.records.slice(0, 2000) : [];
    const returns = Array.isArray(imp.returns) ? imp.returns.slice(0, 2000) : [];
    const consumables = Array.isArray(imp.consumables) ? imp.consumables.slice(0, 2000) : [];
    if (records.length === 0 && returns.length === 0 && consumables.length === 0) return;

    const locations = await tx.select({ id: coffeeLocation.id, name: coffeeLocation.name }).from(coffeeLocation);
    const validLocationIds = new Set(locations.map((l) => l.id));
    const idByName = new Map(locations.map((l) => [l.name.toLowerCase().trim(), l.id]));

    // ── Исторические точки: в архиве встречаются адреса, которых в сегодняшнем
    // справочнике нет (машину перевезли, точку закрыли). Импорт предлагает их
    // списком newLocations; создаём ПОСЛЕ «Одобрить» — владелец видел имена в
    // сводке согласования. Идемпотентно по имени (без учёта регистра).
    let locationsCreated = 0;
    const newLocations = Array.isArray(imp.newLocations) ? imp.newLocations.slice(0, 50) : [];
    for (const n of newLocations) {
      const name = typeof n === "string" ? n.trim().slice(0, 128) : "";
      if (name.length < 2 || idByName.has(name.toLowerCase())) continue;
      const [createdLoc] = await tx.insert(coffeeLocation).values({ name }).returning({ id: coffeeLocation.id });
      idByName.set(name.toLowerCase(), createdLoc.id);
      validLocationIds.add(createdLoc.id);
      locationsCreated += 1;
    }

    // Точка записи: либо существующий id, либо имя (для исторических точек).
    const resolveLocation = (rec: { locationId?: unknown; locationName?: unknown }): string | null => {
      if (typeof rec.locationId === "string" && validLocationIds.has(rec.locationId)) return rec.locationId;
      if (typeof rec.locationName === "string") {
        return idByName.get(rec.locationName.toLowerCase().trim()) ?? null;
      }
      return null;
    };

    let created = 0;
    let skipped = 0;
    for (const r of records) {
      const rec = r as {
        locationId?: unknown;
        locationName?: unknown;
        position?: unknown;
        containerNumber?: unknown;
        filledWeight?: unknown;
        measuredBefore?: unknown;
        packageCount?: unknown;
        enteredDate?: unknown;
      };
      const locationId = resolveLocation(rec) ?? "";
      const position = typeof rec.position === "number" ? Math.trunc(rec.position) : NaN;
      const filledWeight = typeof rec.filledWeight === "number" ? Math.trunc(rec.filledWeight) : NaN;
      const enteredDate = typeof rec.enteredDate === "string" ? rec.enteredDate.slice(0, 10) : "";
      const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(enteredDate);
      if (locationId === "" || position < 1 || position > 8 || !(filledWeight > 0) || !dateOk) {
        skipped += 1;
        continue;
      }
      const containerNumber =
        typeof rec.containerNumber === "number" && rec.containerNumber >= 1 && rec.containerNumber <= 27
          ? Math.trunc(rec.containerNumber)
          : null;
      const measuredBefore =
        typeof rec.measuredBefore === "number" && rec.measuredBefore >= 0 ? Math.trunc(rec.measuredBefore) : null;
      const packageCount =
        typeof rec.packageCount === "number" && rec.packageCount >= 1 ? Math.trunc(rec.packageCount) : 1;

      const [existing] = await tx
        .select({ id: coffeeRefill.id })
        .from(coffeeRefill)
        .where(
          and(
            eq(coffeeRefill.locationId, locationId),
            eq(coffeeRefill.position, position),
            eq(coffeeRefill.enteredDate, enteredDate),
            eq(coffeeRefill.filledWeight, filledWeight),
            eq(coffeeRefill.packageCount, packageCount),
          ),
        )
        .limit(1);
      if (existing) {
        skipped += 1;
        continue;
      }

      await tx.insert(coffeeRefill).values({
        locationId,
        position,
        containerNumber,
        filledWeight,
        measuredBefore,
        packageCount,
        enteredDate,
        createdBy: "import:telegram-history",
      });
      created += 1;
    }

    // ── Возвраты наборов: «позиция. набор. вес» из темы «Остатки с бункеров» ──
    let returnsCreated = 0;
    let returnsSkipped = 0;
    for (const r of returns) {
      const rec = r as {
        position?: unknown;
        containerNumber?: unknown;
        weight?: unknown;
        returnedDate?: unknown;
        locationNote?: unknown;
      };
      const position = typeof rec.position === "number" ? Math.trunc(rec.position) : NaN;
      const containerNumber = typeof rec.containerNumber === "number" ? Math.trunc(rec.containerNumber) : NaN;
      const weight = typeof rec.weight === "number" ? Math.trunc(rec.weight) : NaN;
      const returnedDate = typeof rec.returnedDate === "string" ? rec.returnedDate.slice(0, 10) : "";
      const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(returnedDate);
      if (position < 1 || position > 8 || containerNumber < 1 || containerNumber > 27 || !(weight >= 0) || weight > 10000 || !dateOk) {
        returnsSkipped += 1;
        continue;
      }
      const locationNote =
        typeof rec.locationNote === "string" && rec.locationNote.trim().length > 0
          ? rec.locationNote.trim().slice(0, 256)
          : null;

      const [existing] = await tx
        .select({ id: coffeeContainerReturn.id })
        .from(coffeeContainerReturn)
        .where(
          and(
            eq(coffeeContainerReturn.position, position),
            eq(coffeeContainerReturn.containerNumber, containerNumber),
            eq(coffeeContainerReturn.returnedDate, returnedDate),
            eq(coffeeContainerReturn.weight, weight),
          ),
        )
        .limit(1);
      if (existing) {
        returnsSkipped += 1;
        continue;
      }

      await tx.insert(coffeeContainerReturn).values({
        position,
        containerNumber,
        weight,
        returnedDate,
        locationNote,
        createdBy: "import:telegram-history",
      });
      returnsCreated += 1;
    }

    // ── Расходники: «Вода, стаканчики и крышки» из фото-таблиц ──────────────
    // Upsert по (точка, дата) — как ручной ввод: повторное одобрение правит
    // ту же строку, а не плодит дубли.
    let consumablesUpserted = 0;
    let consumablesSkipped = 0;
    for (const c of consumables) {
      const rec = c as { locationId?: unknown; locationName?: unknown; loggedDate?: unknown; water?: unknown; cups?: unknown; lids?: unknown };
      const locationId = resolveLocation(rec) ?? "";
      const loggedDate = typeof rec.loggedDate === "string" ? rec.loggedDate.slice(0, 10) : "";
      const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(loggedDate);
      const num = (v: unknown) => (typeof v === "number" && v >= 0 ? Math.trunc(v) : 0);
      if (locationId === "" || !dateOk) {
        consumablesSkipped += 1;
        continue;
      }
      await tx
        .insert(coffeeConsumable)
        .values({ locationId, loggedDate, water: num(rec.water), cups: num(rec.cups), lids: num(rec.lids), createdBy: "import:telegram-history" })
        .onConflictDoUpdate({
          target: [coffeeConsumable.locationId, coffeeConsumable.loggedDate],
          set: { water: num(rec.water), cups: num(rec.cups), lids: num(rec.lids) },
        });
      consumablesUpserted += 1;
    }

    await tx.insert(event).values({
      source: "owner",
      type: "coffee.import.executed",
      payload: { approvalId: row.id, created, skipped, returnsCreated, returnsSkipped, consumablesUpserted, consumablesSkipped, locationsCreated },
    });
  }
}
