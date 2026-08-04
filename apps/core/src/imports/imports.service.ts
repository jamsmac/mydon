import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  auditLog,
  contractAct,
  entity,
  globerentUnit,
  grContract,
  grImportContract,
  moneyFlow,
  org,
} from "@mydon/db";
import {
  finalLifecycle,
  lifecycleFromUnits,
  monotonicLifecycleStep,
  UNIT_TRANSITIONS,
  type Domain,
  type ImportLifecycle,
} from "@mydon/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { EventsService } from "../events/events.service";
import { FinanceService } from "../finance/finance.service";

type ImportRow = typeof grImportContract.$inferSelect;
type UnitRow = typeof globerentUnit.$inferSelect;

export interface ImportItem {
  modelId?: string | null;
  name: string;
  qty: number;
  price: number;
}

export interface CreateImportInput {
  domain: Domain;
  contractNo: string;
  contractDate: string;
  supplierId?: string;
  currency?: string;
  items: ImportItem[];
  purpose?: "for_stock" | "under_client" | "for_sum_contract";
  saleContractId?: string;
  prepaymentAmount?: number;
  prepaymentDueDate?: string;
  balanceAmount?: number;
  balanceDueDate?: string;
  notes?: string;
}

export interface ImportListRow extends ImportRow {
  supplierName: string | null;
  unitsTotal: number;
  unitsActive: number;
}

export interface ImportDetail extends ImportListRow {
  units: UnitRow[];
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Массовые ГТД-переходы контракта: действия из единой матрицы склада. */
const BULK_ACTIONS = ["mark-ready-to-ship", "mark-in-transit", "mark-at-border", "mark-customs-im74", "mark-customs-im40", "mark-delivered"] as const;

/**
 * Импортные контракты GLOBERENT — перенос import_contracts PROMACH,
 * односторонний контур (менеджер отмечает за завод; портала у HELI нет).
 * Подписание материализует спецификацию в единицы склада; lifecycle —
 * монотонный синк от статусов единиц (shared/import-lifecycle, баг донора
 * с рангом paying исправлен); оплаты заводу — planned money_flow со сроками.
 */
@Injectable()
export class ImportsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly events: EventsService,
    private readonly finance: FinanceService,
  ) {}

  private async orgId(domain: Domain): Promise<string> {
    const [row] = await this.db.select({ id: org.id }).from(org).where(eq(org.code, domain));
    if (!row) throw new NotFoundException(`Направление "${domain}" не заведено (pnpm db:seed)`);
    return row.id;
  }

  async list(domain: Domain): Promise<ImportListRow[]> {
    const orgId = await this.orgId(domain);
    const rows = await this.db
      .select({
        contract: grImportContract,
        supplierName: entity.name,
        unitsTotal: sql<number>`count(${globerentUnit.id})::int`,
        unitsActive: sql<number>`count(${globerentUnit.id}) filter (where ${globerentUnit.status} not in ('CANCELLED','ARCHIVED'))::int`,
      })
      .from(grImportContract)
      .leftJoin(entity, eq(entity.id, grImportContract.supplierId))
      .leftJoin(globerentUnit, eq(globerentUnit.importContractId, grImportContract.id))
      .where(eq(grImportContract.orgId, orgId))
      .groupBy(grImportContract.id, entity.name)
      .orderBy(desc(grImportContract.contractDate))
      .limit(500);
    return rows.map((r) => ({
      ...r.contract,
      supplierName: r.supplierName,
      unitsTotal: r.unitsTotal,
      unitsActive: r.unitsActive,
    }));
  }

  async detail(id: string): Promise<ImportDetail> {
    const [row] = await this.db
      .select({ contract: grImportContract, supplierName: entity.name })
      .from(grImportContract)
      .leftJoin(entity, eq(entity.id, grImportContract.supplierId))
      .where(eq(grImportContract.id, id))
      .limit(1);
    if (!row) throw new NotFoundException("Импортный контракт не найден");
    const units = await this.db
      .select()
      .from(globerentUnit)
      .where(eq(globerentUnit.importContractId, id))
      .orderBy(globerentUnit.code);
    const active = units.filter((u) => u.status !== "CANCELLED" && u.status !== "ARCHIVED");
    return {
      ...row.contract,
      supplierName: row.supplierName,
      unitsTotal: units.length,
      unitsActive: active.length,
      units,
    };
  }

  async create(input: CreateImportInput, actorRef = "owner"): Promise<ImportRow> {
    if ((input.contractNo ?? "").trim() === "") throw new BadRequestException("Впиши номер контракта");
    if (!ISO_DAY.test(input.contractDate ?? "")) {
      throw new BadRequestException("Дата контракта — в формате ГГГГ-ММ-ДД");
    }
    const items = (input.items ?? []).filter((i) => (i.name ?? "").trim() !== "");
    if (items.length === 0) throw new BadRequestException("Добавь хотя бы одну позицию");
    for (const i of items) {
      if (!Number.isFinite(i.qty) || i.qty <= 0 || !Number.isInteger(i.qty)) {
        throw new BadRequestException(`Позиция «${i.name}»: количество — целое больше нуля`);
      }
      if (!Number.isFinite(i.price) || i.price <= 0) {
        throw new BadRequestException(`Позиция «${i.name}»: цена — число больше нуля`);
      }
    }
    const total = items.reduce((s, i) => s + i.qty * i.price, 0);
    // CHECK донора: предоплата + баланс ≤ итог (+0.01 допуск на округление).
    const prepay = input.prepaymentAmount ?? 0;
    const balance = input.balanceAmount ?? 0;
    if (prepay < 0 || balance < 0) throw new BadRequestException("Суммы графика не могут быть отрицательными");
    if (prepay + balance > total + 0.01) {
      throw new BadRequestException(
        `График (${prepay + balance}) больше суммы контракта (${total}) — проверь цифры`,
      );
    }
    for (const [label, d] of [
      ["Срок предоплаты", input.prepaymentDueDate],
      ["Срок баланса", input.balanceDueDate],
    ] as const) {
      if (d !== undefined && !ISO_DAY.test(d)) {
        throw new BadRequestException(`${label} — дата в формате ГГГГ-ММ-ДД`);
      }
    }
    if (input.purpose === "for_sum_contract" && input.saleContractId === undefined) {
      // CHECK донора: контракт «под договор продажи» обязан на него ссылаться.
      throw new BadRequestException("Для контракта под договор продажи укажи сам договор");
    }
    if (input.saleContractId !== undefined) {
      const [sale] = await this.db
        .select({ id: grContract.id })
        .from(grContract)
        .where(eq(grContract.id, input.saleContractId))
        .limit(1);
      if (!sale) throw new NotFoundException("Договор продажи не найден");
    }
    const orgId = await this.orgId(input.domain);

    return this.db.transaction(async (tx) => {
      if (input.supplierId !== undefined) {
        const [dup] = await tx
          .select({ id: grImportContract.id })
          .from(grImportContract)
          .where(
            and(
              eq(grImportContract.supplierId, input.supplierId),
              eq(grImportContract.contractNo, input.contractNo.trim()),
            ),
          )
          .limit(1);
        if (dup) throw new ConflictException("Контракт с этим номером у поставщика уже есть");
      }
      const [created] = await tx
        .insert(grImportContract)
        .values({
          orgId,
          domain: input.domain,
          contractNo: input.contractNo.trim(),
          contractDate: input.contractDate,
          supplierId: input.supplierId ?? null,
          currency: (input.currency ?? "USD").toUpperCase(),
          totalAmount: String(total),
          items: items as unknown as Record<string, unknown>[],
          purpose: input.purpose ?? "for_stock",
          saleContractId: input.saleContractId ?? null,
          prepaymentAmount: input.prepaymentAmount !== undefined ? String(input.prepaymentAmount) : null,
          prepaymentDueDate: input.prepaymentDueDate ?? null,
          balanceAmount: input.balanceAmount !== undefined ? String(input.balanceAmount) : null,
          balanceDueDate: input.balanceDueDate ?? null,
          notes: input.notes ?? null,
        })
        .returning();
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "import.create",
        target: created.id,
        after: { ...created, items: undefined, itemsCount: items.length },
      });
      return created;
    });
  }

  /**
   * Подписание (менеджер отмечает за обе стороны) → материализация:
   * каждая единица qty спецификации — отдельная строка склада
   * (CONTRACT_SIGNED, VIN пуст). Идемпотентно: единицы уже есть — пропуск.
   * График оплат заводу становится planned money_flow со сроками.
   */
  async sign(id: string, actorRef = "owner"): Promise<ImportDetail> {
    const row = await this.db.transaction(async (tx) => {
      const [c] = await tx.select().from(grImportContract).where(eq(grImportContract.id, id)).for("update");
      if (!c) throw new NotFoundException("Импортный контракт не найден");
      if (c.status !== "draft") {
        throw new ConflictException(`Контракт уже подписан (${c.status})`);
      }
      const [updated] = await tx
        .update(grImportContract)
        .set({ status: "in_progress", lifecycleStatus: "signed", updatedAt: new Date() })
        .where(eq(grImportContract.id, id))
        .returning();

      // Материализация — идемпотентна (правило донора existed_already).
      const [existing] = await tx
        .select({ id: globerentUnit.id })
        .from(globerentUnit)
        .where(eq(globerentUnit.importContractId, id))
        .limit(1);
      if (!existing) {
        const [m] = await tx
          .select({
            n: sql<string>`coalesce(max((substring(${globerentUnit.code} from 4))::int), 0)::text`,
          })
          .from(globerentUnit)
          .where(eq(globerentUnit.orgId, c.orgId ?? sql`null`));
        let next = Number(m?.n ?? "0");
        const items = (c.items ?? []) as unknown as ImportItem[];
        for (const item of items) {
          for (let k = 0; k < item.qty; k += 1) {
            next += 1;
            await tx.insert(globerentUnit).values({
              orgId: c.orgId,
              domain: c.domain,
              code: `WH-${String(next).padStart(4, "0")}`,
              name: item.name,
              modelId: item.modelId ?? null,
              status: "CONTRACT_SIGNED",
              importContractId: id,
            });
          }
        }
      }
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "import.signed",
        target: id,
        before: { status: c.status },
        after: { status: updated.status },
      });
      return updated;
    });

    // График оплат заводу → planned money_flow (агинг и «к сроку» видят сразу).
    // Провал не роняет подписание — обязательства можно завести руками.
    try {
      await this.createPaymentPlan(row, actorRef);
    } catch {
      // след — в отсутствии planned-строк
    }
    await this.events.record({
      source: "imports",
      type: "import.signed",
      payload: { importContractId: id, contractNo: row.contractNo },
    });
    return this.detail(id);
  }

  private async createPaymentPlan(row: ImportRow, actorRef: string): Promise<void> {
    const mk = async (amount: string | null, due: string | null, label: string): Promise<void> => {
      if (amount === null || Number(amount) <= 0) return;
      const created = await this.finance.createFlow(
        {
          domain: row.domain,
          direction: "out",
          status: "planned",
          amount: Number(amount),
          currency: row.currency,
          category: "supplier",
          counterpartyId: row.supplierId ?? undefined,
          purpose: `${label} по импортному контракту № ${row.contractNo}`,
          dueDate: due ?? undefined,
        },
        actorRef,
      );
      await this.db
        .update(moneyFlow)
        .set({ importContractId: row.id })
        .where(eq(moneyFlow.id, created.id));
    };
    await mk(row.prepaymentAmount, row.prepaymentDueDate, "предоплата заводу");
    await mk(row.balanceAmount, row.balanceDueDate, "балансовый платёж заводу");
  }

  /**
   * Отметить оплату по графику: закрывает соответствующую planned-запись
   * (если есть) и ставит флаг на контракте. kind: prepayment | balance.
   */
  async markPaid(id: string, kind: "prepayment" | "balance", actorRef = "owner"): Promise<ImportRow> {
    if (kind !== "prepayment" && kind !== "balance") {
      throw new BadRequestException("kind: prepayment | balance");
    }
    const row = await this.db.transaction(async (tx) => {
      const [c] = await tx.select().from(grImportContract).where(eq(grImportContract.id, id)).for("update");
      if (!c) throw new NotFoundException("Импортный контракт не найден");
      const already = kind === "prepayment" ? c.prepaymentPaidAt : c.balancePaidAt;
      if (already !== null) throw new ConflictException("Эта оплата уже отмечена");
      const [updated] = await tx
        .update(grImportContract)
        .set(
          kind === "prepayment"
            ? { prepaymentPaidAt: new Date(), lifecycleStatus: c.lifecycleStatus === "signed" ? "paying" : c.lifecycleStatus, updatedAt: new Date() }
            : { balancePaidAt: new Date(), updatedAt: new Date() },
        )
        .where(eq(grImportContract.id, id))
        .returning();
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: `import.${kind}_paid`,
        target: id,
      });
      return updated;
    });
    // Закрыть planned-обязательство этим же фактом (если оно есть и открыто).
    const [planned] = await this.db
      .select()
      .from(moneyFlow)
      .where(
        and(
          eq(moneyFlow.importContractId, id),
          eq(moneyFlow.status, "planned"),
          eq(moneyFlow.direction, "out"),
          sql`${moneyFlow.purpose} like ${kind === "prepayment" ? "предоплата%" : "балансовый%"}`,
        ),
      )
      .limit(1);
    if (planned) {
      try {
        await this.finance.markPaid(planned.id, {}, actorRef);
      } catch {
        // обязательство закроют руками во вкладке «Финансы»
      }
    }
    return row;
  }

  /**
   * Массовое действие по единицам контракта (отгрузка/граница/ГТД/склад):
   * идемпотентный UPDATE по fromStatuses матрицы — продвинутые единицы не
   * трогаются и возвращаются числом skipped (правило донора).
   */
  async bulkUnitAction(
    id: string,
    action: string,
    extra: { declarationNumber?: string; declarationDate?: string; transportCompany?: string } = {},
    actorRef = "owner",
  ): Promise<{ moved: number; skipped: number; lifecycle: string }> {
    if (!(BULK_ACTIONS as readonly string[]).includes(action)) {
      throw new BadRequestException(`Массовые действия: ${BULK_ACTIONS.join(", ")}`);
    }
    const t = UNIT_TRANSITIONS[action];
    if (t === undefined) throw new BadRequestException("Неизвестное действие");
    if ((action === "mark-customs-im74" || action === "mark-customs-im40")) {
      if ((extra.declarationNumber ?? "").trim() === "") throw new BadRequestException("Укажи номер ГТД");
      if (!ISO_DAY.test(extra.declarationDate ?? "")) throw new BadRequestException("Дата ГТД — ГГГГ-ММ-ДД");
    }
    if (action === "mark-in-transit" && (extra.transportCompany ?? "").trim() === "") {
      throw new BadRequestException("Укажи перевозчика");
    }

    const result = await this.db.transaction(async (tx) => {
      const [c] = await tx.select().from(grImportContract).where(eq(grImportContract.id, id)).for("update");
      if (!c) throw new NotFoundException("Импортный контракт не найден");
      const units = await tx
        .select({ id: globerentUnit.id, status: globerentUnit.status })
        .from(globerentUnit)
        .where(eq(globerentUnit.importContractId, id));
      const eligible = units.filter((u) => (t.from as readonly string[]).includes(u.status));
      const activeCount = units.filter((u) => u.status !== "CANCELLED" && u.status !== "ARCHIVED").length;
      if (eligible.length > 0) {
        await tx
          .update(globerentUnit)
          .set({
            status: t.to,
            updatedAt: new Date(),
            ...(action === "mark-in-transit" ? { transportCompany: extra.transportCompany?.trim() } : {}),
            ...(action === "mark-customs-im74" || action === "mark-customs-im40"
              ? {
                  declarationType: action === "mark-customs-im74" ? "IM74" : "IM40",
                  declarationNumber: extra.declarationNumber?.trim(),
                  declarationDate: extra.declarationDate,
                }
              : {}),
            ...(action === "mark-delivered" ? { arrivalDate: sql`coalesce(arrival_date, current_date)` } : {}),
          })
          .where(
            and(
              eq(globerentUnit.importContractId, id),
              inArray(
                globerentUnit.id,
                eligible.map((u) => u.id),
              ),
              inArray(globerentUnit.status, [...t.from]),
            ),
          );
      }
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: `import.bulk_${action}`,
        target: id,
        after: { moved: eligible.length, skipped: activeCount - eligible.length },
      });
      return { moved: eligible.length, skipped: activeCount - eligible.length };
    });

    const lifecycle = await this.recomputeLifecycle(id);
    await this.events.record({
      source: "imports",
      type: "import.bulk_action",
      payload: { importContractId: id, action, ...result, lifecycle },
    });
    return { ...result, lifecycle };
  }

  /**
   * Монотонный синк lifecycle от единиц (правила донора; ранг paying
   * исправлен). delivered/closed — по актам и оплате UZS-договоров,
   * оплаченность — в сумовом эквиваленте (антибаг донора).
   */
  async recomputeLifecycle(id: string): Promise<string> {
    const [c] = await this.db.select().from(grImportContract).where(eq(grImportContract.id, id)).limit(1);
    if (!c) throw new NotFoundException("Импортный контракт не найден");
    const units = await this.db
      .select()
      .from(globerentUnit)
      .where(eq(globerentUnit.importContractId, id));
    const active = units.filter((u) => u.status !== "CANCELLED" && u.status !== "ARCHIVED");

    // Фаза от статусов единиц.
    let target = lifecycleFromUnits(units.map((u) => u.status));

    // Финальные фазы: все единицы в актах и с договором; договоры оплачены.
    if (active.length > 0) {
      const contractIds = [...new Set(active.map((u) => u.contractId).filter((v): v is string => v !== null))];
      if (contractIds.length > 0) {
        const acts = await this.db
          .select({ itemRefs: contractAct.itemRefs, contractId: contractAct.contractId })
          .from(contractAct)
          .where(inArray(contractAct.contractId, contractIds));
        const actedUnitIds = new Set<string>();
        for (const a of acts) {
          for (const ref of (a.itemRefs ?? []) as { equipmentId?: string | null }[]) {
            if (ref.equipmentId != null) actedUnitIds.add(ref.equipmentId);
          }
        }
        const sales = await this.db
          .select({
            id: grContract.id,
            total: grContract.totalWithVat,
            paid: sql<string>`coalesce((
              select sum(case when mf.currency = 'UZS' then mf.amount else coalesce(mf.amount_uzs, 0) end)
              from ${moneyFlow} mf
              where mf.contract_id = ${grContract.id} and mf.direction = 'in' and mf.status = 'actual'
            ), 0)::text`,
          })
          .from(grContract)
          .where(inArray(grContract.id, contractIds));
        const allPaid = sales.every((s2) => Number(s2.total) > 0 && Number(s2.paid) >= Number(s2.total));
        const fin = finalLifecycle({
          activeUnits: active.map((u) => ({
            inHandoverAct: actedUnitIds.has(u.id),
            hasSaleContract: u.contractId !== null,
          })),
          allSaleContractsPaid: allPaid,
        });
        if (fin !== null) target = fin;
      }
    }

    const step = monotonicLifecycleStep(c.lifecycleStatus as ImportLifecycle, target);
    if (step === null) return c.lifecycleStatus;
    await this.db
      .update(grImportContract)
      .set({ lifecycleStatus: step, updatedAt: new Date() })
      .where(eq(grImportContract.id, id));
    await this.events.record({
      source: "imports",
      type: "import.lifecycle",
      payload: { importContractId: id, from: c.lifecycleStatus, to: step },
    });
    return step;
  }

  /** Отмена: запрещена при активных единицах (донор: has_linked_entities). */
  async cancel(id: string, actorRef = "owner"): Promise<ImportRow> {
    return this.db.transaction(async (tx) => {
      const [c] = await tx.select().from(grImportContract).where(eq(grImportContract.id, id)).for("update");
      if (!c) throw new NotFoundException("Импортный контракт не найден");
      if (c.status === "cancelled") throw new ConflictException("Контракт уже отменён");
      const [linked] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(globerentUnit)
        .where(
          and(
            eq(globerentUnit.importContractId, id),
            sql`${globerentUnit.status} not in ('CANCELLED','ARCHIVED')`,
          ),
        );
      if ((linked?.n ?? 0) > 0) {
        throw new ConflictException(
          `К контракту привязано единиц: ${linked!.n} — сначала отмени или заархивируй их`,
        );
      }
      const [updated] = await tx
        .update(grImportContract)
        .set({ status: "cancelled", lifecycleStatus: "cancelled", updatedAt: new Date() })
        .where(eq(grImportContract.id, id))
        .returning();
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "import.cancelled",
        target: id,
        before: { status: c.status },
      });
      return updated;
    });
  }
}
