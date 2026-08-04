import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { auditLog, contractAct, entity, grContract, moneyFlow, org } from "@mydon/db";
import {
  contractTotals,
  installmentSchedule,
  trancheAmount,
  TZ,
  type ContractItem,
  type Domain,
} from "@mydon/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { EventsService } from "../events/events.service";
import { FinanceService } from "../finance/finance.service";
import {
  renderContractDocx,
  type ContractDocxInput,
  type ContractParty,
  type PayType,
} from "./contract-docx";

type ContractRow = typeof grContract.$inferSelect;
type ActRow = typeof contractAct.$inferSelect;
type FlowRow = typeof moneyFlow.$inferSelect;

/**
 * Разрешённые переходы статуса — ужесточение против донора (у PROMACH
 * guard'ов не было вовсе: PATCH принимал cancelled → closed). closed и
 * cancelled разъединены: между ними только через active.
 */
const STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  active: ["closed", "cancelled"],
  closed: ["active"],
  cancelled: ["active"],
};

/** Snapshot покупателя на момент подписания — реквизиты не «плывут» за справочником. */
export interface BuyerSnapshot {
  name?: string;
  director?: string;
  inn?: string;
  address?: string;
  account?: string;
  bank?: string;
  mfo?: string;
  oked?: string;
  nds?: string;
  phone?: string;
}

export interface CreateContractInput {
  domain: Domain;
  /** Пусто — сервер сам возьмёт max+1 в транзакции (у донора считал фронт — гонка). */
  contractNo?: string;
  contractDate: string;
  clientId?: string;
  buyer?: BuyerSnapshot;
  sellerCompanyId?: string;
  items: ContractItem[];
  payType?: "100" | "partial" | "install" | "post";
  warranty?: string;
  deliveryDays?: number;
  docParams?: Record<string, unknown>;
  agentId?: string;
  agentCommissionAmount?: number;
  agentCommissionCurrency?: string;
}

export interface ContractListRow extends ContractRow {
  clientName: string | null;
  /** Оплачено в сумовом эквиваленте (антибаг донора: валюты не складываются сырыми). */
  paidUzs: number;
  paymentsCount: number;
  actsCount: number;
}

export interface ContractDetail extends ContractListRow {
  payments: FlowRow[];
  planned: FlowRow[];
  acts: ActRow[];
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Сумовой эквивалент фактических платежей: свой сум → amount, валюта → amount_uzs. */
const PAID_UZS_SQL = sql<string>`coalesce(sum(
  case
    when ${moneyFlow.currency} = 'UZS' then ${moneyFlow.amount}
    else coalesce(${moneyFlow.amountUzs}, 0)
  end
) filter (where ${moneyFlow.direction} = 'in' and ${moneyFlow.status} = 'actual'), 0)::text`;

/**
 * UZS-договоры купли-продажи GLOBERENT — перенос модуля contracts PROMACH.
 * Платежи не заводят второй реестр денег: каждый платёж — запись money_flow
 * с contract_id, поэтому агинг/«к сроку»/термометр видят договор бесплатно.
 */
@Injectable()
export class ContractsService {
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

  async list(domain: Domain): Promise<ContractListRow[]> {
    const orgId = await this.orgId(domain);
    const rows = await this.db
      .select({
        contract: grContract,
        clientName: entity.name,
        paidUzs: PAID_UZS_SQL,
        paymentsCount: sql<number>`count(${moneyFlow.id}) filter (where ${moneyFlow.direction} = 'in' and ${moneyFlow.status} = 'actual')::int`,
        actsCount: sql<number>`(select count(*) from ${contractAct} where ${contractAct.contractId} = ${grContract.id})::int`,
      })
      .from(grContract)
      .leftJoin(entity, eq(entity.id, grContract.clientId))
      .leftJoin(moneyFlow, eq(moneyFlow.contractId, grContract.id))
      .where(eq(grContract.orgId, orgId))
      .groupBy(grContract.id, entity.name)
      .orderBy(desc(grContract.contractDate))
      .limit(500);
    return rows.map((r) => ({
      ...r.contract,
      clientName: r.clientName,
      paidUzs: Number(r.paidUzs),
      paymentsCount: r.paymentsCount,
      actsCount: r.actsCount,
    }));
  }

  async detail(id: string): Promise<ContractDetail> {
    const [row] = await this.db
      .select({ contract: grContract, clientName: entity.name })
      .from(grContract)
      .leftJoin(entity, eq(entity.id, grContract.clientId))
      .where(eq(grContract.id, id))
      .limit(1);
    if (!row) throw new NotFoundException("Договор не найден");
    const flows = await this.db
      .select()
      .from(moneyFlow)
      .where(eq(moneyFlow.contractId, id))
      .orderBy(desc(moneyFlow.date));
    const acts = await this.db
      .select()
      .from(contractAct)
      .where(eq(contractAct.contractId, id))
      .orderBy(desc(contractAct.actDate));
    const paidUzs = flows
      .filter((f) => f.direction === "in" && f.status === "actual")
      .reduce((s, f) => s + (f.currency === "UZS" ? Number(f.amount) : Number(f.amountUzs ?? 0)), 0);
    const actual = flows.filter((f) => f.status === "actual" && f.direction === "in");
    return {
      ...row.contract,
      clientName: row.clientName,
      paidUzs,
      paymentsCount: actual.length,
      actsCount: acts.length,
      payments: actual,
      planned: flows.filter((f) => f.status === "planned"),
      acts,
    };
  }

  /**
   * Создание договора. Итоги пересчитываются НА СЕРВЕРЕ (донор верил числам
   * с фронта); номер — max+1 в транзакции (у донора считал фронт — гонка);
   * график оплат сразу порождает planned-записи money_flow со сроками.
   */
  async create(input: CreateContractInput, actorRef = "owner"): Promise<ContractRow> {
    if (!ISO_DAY.test(input.contractDate ?? "")) {
      throw new BadRequestException("Дата договора — в формате ГГГГ-ММ-ДД");
    }
    const items = (input.items ?? []).filter((i) => (i.name ?? "").trim().length > 0);
    if (items.length === 0) throw new BadRequestException("Добавь хотя бы одну позицию");
    for (const i of items) {
      if (!Number.isFinite(i.qty) || i.qty <= 0) {
        throw new BadRequestException(`Позиция «${i.name}»: количество — целое больше нуля`);
      }
      if (!Number.isFinite(i.price) || i.price <= 0) {
        throw new BadRequestException(`Позиция «${i.name}»: цена — число больше нуля`);
      }
    }
    if (
      input.payType !== undefined &&
      !["100", "partial", "install", "post"].includes(input.payType)
    ) {
      throw new BadRequestException("Тип оплаты: 100 | partial | install | post");
    }
    const orgId = await this.orgId(input.domain);

    // Snapshot покупателя: базой — карточка реестра, поверх — что передали руками.
    let buyer: BuyerSnapshot = input.buyer ?? {};
    if (input.clientId !== undefined) {
      const [client] = await this.db
        .select()
        .from(entity)
        .where(eq(entity.id, input.clientId))
        .limit(1);
      if (!client) throw new NotFoundException("Клиент не найден в реестре");
      const a = (client.attrs ?? {}) as Record<string, unknown>;
      const s = (v: unknown): string | undefined =>
        typeof v === "string" && v.trim() !== "" ? v : undefined;
      buyer = {
        name: client.name,
        inn: client.externalRef ?? undefined,
        director: s(a["director"]) ?? s((a["contacts"] as Record<string, { fullName?: string }> | undefined)?.["director"]?.fullName),
        address: s(a["address"]),
        account: s(a["account"]),
        bank: s(a["bank"]),
        mfo: s(a["mfo"]),
        oked: s(a["oked"]),
        nds: s(a["nds_code"]),
        phone: s(a["phone"]),
        ...Object.fromEntries(Object.entries(input.buyer ?? {}).filter(([, v]) => v !== undefined && v !== "")),
      };
    }

    const totals = contractTotals(items);
    if (totals.totalWithVat <= 0) throw new BadRequestException("Сумма договора должна быть больше нуля");

    const created = await this.db.transaction(async (tx) => {
      // Автономер: max по числовым номерам направления + 1, под блокировкой транзакции.
      let contractNo = (input.contractNo ?? "").trim();
      if (contractNo === "") {
        const [m] = await tx
          .select({
            n: sql<string>`coalesce(max((${grContract.contractNo})::int) filter (where ${grContract.contractNo} ~ '^\\d+$'), 0)::text`,
          })
          .from(grContract)
          .where(eq(grContract.orgId, orgId));
        contractNo = String(Number(m?.n ?? "0") + 1);
      }
      const [dup] = await tx
        .select({ id: grContract.id })
        .from(grContract)
        .where(and(eq(grContract.orgId, orgId), eq(grContract.contractNo, contractNo)))
        .limit(1);
      if (dup) {
        throw new ConflictException(`Договор № ${contractNo}/ОП уже существует`);
      }

      const [row] = await tx
        .insert(grContract)
        .values({
          orgId,
          domain: input.domain,
          contractNo,
          contractDate: input.contractDate,
          clientId: input.clientId ?? null,
          buyer: buyer as Record<string, unknown>,
          sellerCompanyId: input.sellerCompanyId ?? null,
          totalWithVat: String(totals.totalWithVat),
          totalVat: String(totals.totalVat),
          payType: input.payType ?? null,
          warranty: input.warranty ?? null,
          deliveryDays: input.deliveryDays ?? null,
          items: items as unknown as Record<string, unknown>[],
          docParams: input.docParams ?? {},
          agentId: input.agentId ?? null,
          agentCommissionAmount:
            input.agentCommissionAmount !== undefined ? String(input.agentCommissionAmount) : null,
          agentCommissionCurrency: input.agentCommissionCurrency ?? null,
        })
        .returning();

      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "contract.create",
        target: row.id,
        after: { ...row, items: undefined, itemsCount: items.length },
      });
      return row;
    });

    // График оплат → planned money_flow со сроками: договор сразу виден
    // агингу и «к сроку ≤ 7 дней». Провал генерации не роняет договор.
    try {
      await this.createPlannedSchedule(created, actorRef);
    } catch {
      // след останется в отсутствии planned-строк; владелец заведёт руками
    }

    // Комиссия агента — обязательство наружу: у донора комиссия только
    // записывалась и нигде не жила дальше, здесь она сразу в агинге.
    if (created.agentId !== null && created.agentCommissionAmount !== null) {
      try {
        await this.finance.createFlow(
          {
            domain: input.domain,
            direction: "out",
            status: "planned",
            amount: Number(created.agentCommissionAmount),
            currency: created.agentCommissionCurrency ?? "UZS",
            category: "commission",
            counterpartyId: created.agentId,
            purpose: `комиссия агента по договору № ${created.contractNo}/ОП`,
          },
          actorRef,
        );
        await this.db
          .update(moneyFlow)
          .set({ contractId: created.id })
          .where(
            and(
              eq(moneyFlow.counterpartyId, created.agentId),
              eq(moneyFlow.category, "commission"),
              sql`${moneyFlow.contractId} is null`,
            ),
          );
      } catch {
        // комиссию можно завести руками во вкладке «Финансы»
      }
    }

    await this.events.record({
      source: "contracts",
      type: "contract.created",
      payload: { contractId: created.id, contractNo: created.contractNo, items },
    });
    return created;
  }

  /** planned-строки графика: 100% — один срок, транши — по дням, рассрочка — помесячно. */
  private async createPlannedSchedule(row: ContractRow, actorRef: string): Promise<void> {
    const p = (row.docParams ?? {}) as Record<string, unknown>;
    const total = Number(row.totalWithVat);
    const base = new Date(`${row.contractDate}T00:00:00`);
    const dayKey = (d: Date): string => d.toLocaleDateString("en-CA", { timeZone: TZ });
    const addDays = (days: number): string => {
      const d = new Date(base);
      d.setDate(d.getDate() + days);
      return dayKey(d);
    };
    const mk = async (amount: number, dueDate: string, purpose: string): Promise<void> => {
      const created = await this.finance.createFlow(
        {
          domain: row.domain,
          direction: "in",
          status: "planned",
          amount,
          currency: "UZS",
          category: "sale",
          counterpartyId: row.clientId ?? undefined,
          purpose,
          dueDate,
        },
        actorRef,
      );
      await this.db
        .update(moneyFlow)
        .set({ contractId: row.id })
        .where(eq(moneyFlow.id, created.id));
    };

    const no = `№ ${row.contractNo}/ОП`;
    if (row.payType === "100") {
      const payDays = Number(p["payDays"] ?? 0);
      await mk(total, addDays(Number.isFinite(payDays) ? payDays : 0), `оплата 100% по договору ${no}`);
      return;
    }
    if (row.payType === "partial") {
      const tranches = Array.isArray(p["partialTranches"])
        ? (p["partialTranches"] as { pct?: number; days?: number }[])
        : [];
      for (const [i, t] of tranches.entries()) {
        const pct = Number(t.pct ?? 0);
        if (!Number.isFinite(pct) || pct <= 0) continue;
        await mk(
          trancheAmount(total, pct),
          addDays(Number(t.days ?? 0) || 0),
          `транш ${i + 1} (${pct}%) по договору ${no}`,
        );
      }
      return;
    }
    if (row.payType === "install") {
      const months = Number(p["installMonths"] ?? 0);
      if (!Number.isFinite(months) || months <= 0) return;
      const prepayPct = Number(p["prepayPct"] ?? 0);
      const firstRaw = typeof p["installFirstDate"] === "string" ? p["installFirstDate"] : row.contractDate;
      const first = ISO_DAY.test(firstRaw) ? new Date(`${firstRaw}T00:00:00`) : base;
      if (prepayPct > 0) {
        await mk(trancheAmount(total, prepayPct), row.contractDate, `предоплата ${prepayPct}% по договору ${no}`);
      }
      const schedule = installmentSchedule({
        totalWithVat: total,
        prepayPct,
        months,
        annualRatePct: Number(p["installInterest"] ?? 0) || 0,
        firstDate: first,
      });
      for (const r of schedule) {
        await mk(r.amount, dayKey(r.due), `рассрочка ${r.n}/${schedule.length} по договору ${no}`);
      }
    }
    // post — оплата после поставки: срок неизвестен, planned не создаём.
  }

  /** Смена статуса с guard'ами (ужесточение против донора — у него guard'ов не было). */
  async setStatus(id: string, to: string, actorRef = "owner"): Promise<ContractRow> {
    if (!["active", "closed", "cancelled"].includes(to)) {
      throw new BadRequestException("Статус: active | closed | cancelled");
    }
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(grContract).where(eq(grContract.id, id)).for("update");
      if (!row) throw new NotFoundException("Договор не найден");
      if (row.status === to) return row; // no-op: без записи в журнал
      if (!(STATUS_TRANSITIONS[row.status] ?? []).includes(to)) {
        throw new ConflictException(
          `Переход ${row.status} → ${to} запрещён (между closed и cancelled — только через active)`,
        );
      }
      const [updated] = await tx
        .update(grContract)
        .set({ status: to, updatedAt: new Date() })
        .where(eq(grContract.id, id))
        .returning();
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "contract.status_change",
        target: id,
        before: { status: row.status },
        after: { status: to },
      });
      return updated;
    });
  }

  /**
   * Платёж по договору: одна запись money_flow (direction=in, category=sale).
   * По cancelled — 409; по closed — разрешено (осознанное решение донора:
   * доплата после закрытия), зафиксировано тестом.
   */
  async addPayment(
    id: string,
    input: { amount: number; currency?: string; docNo?: string; date?: string; rate?: number },
    actorRef = "owner",
  ): Promise<FlowRow> {
    const [row] = await this.db.select().from(grContract).where(eq(grContract.id, id)).limit(1);
    if (!row) throw new NotFoundException("Договор не найден");
    if (row.status === "cancelled") {
      throw new ConflictException("Договор отменён — платежи по нему не принимаются");
    }
    const before = await this.paidUzs(id);

    const created = await this.finance.createFlow(
      {
        domain: row.domain,
        direction: "in",
        status: "actual",
        amount: input.amount,
        currency: input.currency,
        category: "sale",
        rate: input.rate,
        counterpartyId: row.clientId ?? undefined,
        docNo: input.docNo,
        purpose: `оплата по договору № ${row.contractNo}/ОП`,
        date: input.date,
      },
      actorRef,
    );
    await this.db.update(moneyFlow).set({ contractId: id }).where(eq(moneyFlow.id, created.id));

    // Полная оплата — ровно одно событие: было < total, стало ≥ total.
    const total = Number(row.totalWithVat);
    const after = await this.paidUzs(id);
    if (total > 0 && before < total && after >= total) {
      await this.events.record({
        source: "contracts",
        type: "contract.paid_in_full",
        payload: { contractId: id, contractNo: row.contractNo, paidUzs: after, totalWithVat: total },
      });
    }
    return created;
  }

  private async paidUzs(id: string): Promise<number> {
    const [r] = await this.db
      .select({ paid: PAID_UZS_SQL })
      .from(moneyFlow)
      .where(eq(moneyFlow.contractId, id));
    return Number(r?.paid ?? 0);
  }

  /**
   * DOCX договора — серверный рендер (перенос generateDocx донора 1:1).
   * Продавец — карточка own_company из реестра (замена SELLER-хардкода):
   * либо привязанная к договору, либо единственная в направлении.
   */
  async renderDocx(id: string): Promise<{ buffer: Buffer; filename: string }> {
    const [row] = await this.db.select().from(grContract).where(eq(grContract.id, id)).limit(1);
    if (!row) throw new NotFoundException("Договор не найден");

    let sellerEntity: { name: string; attrs: unknown } | null = null;
    if (row.sellerCompanyId !== null) {
      const [e] = await this.db
        .select({ name: entity.name, attrs: entity.attrs })
        .from(entity)
        .where(eq(entity.id, row.sellerCompanyId))
        .limit(1);
      sellerEntity = e ?? null;
    } else {
      const [e] = await this.db
        .select({ name: entity.name, attrs: entity.attrs })
        .from(entity)
        .where(and(eq(entity.orgId, row.orgId ?? sql`null`), eq(entity.type, "own_company")))
        .limit(1);
      sellerEntity = e ?? null;
    }
    if (sellerEntity === null) {
      throw new BadRequestException(
        "Не заведена карточка своей компании (тип own_company) — реквизиты продавца брать неоткуда",
      );
    }
    const a = (sellerEntity.attrs ?? {}) as Record<string, unknown>;
    const s = (k: string): string => (typeof a[k] === "string" ? (a[k] as string) : "");
    const seller: ContractParty = {
      name: sellerEntity.name,
      director: s("director"),
      inn: s("inn"),
      address: s("address"),
      account: s("account"),
      bank: s("bank"),
      mfo: s("mfo"),
      oked: s("oked"),
      nds: s("nds_code") || s("nds"),
      phone: s("phone"),
    };

    const buyer = (row.buyer ?? {}) as ContractDocxInput["buyer"];
    const input: ContractDocxInput = {
      contractNo: row.contractNo,
      contractDate: row.contractDate,
      buyer: { ...buyer, name: buyer.name ?? "Покупатель" },
      seller,
      items: (row.items ?? []) as ContractDocxInput["items"],
      payType: (row.payType ?? "100") as PayType,
      docParams: (row.docParams ?? {}) as ContractDocxInput["docParams"],
      deliveryDays: row.deliveryDays ?? 0,
    };
    const buffer = await renderContractDocx(input);
    return { buffer, filename: `Dogovor_KP_${row.contractNo}_${row.contractDate}.docx` };
  }

  /** Акт приёма-передачи. По cancelled — 409. Создаёт событие для будущего склада. */
  async addAct(
    id: string,
    input: {
      actNo: string;
      actDate: string;
      itemRefs?: { equipmentId?: string | null; name: string }[];
      signedBySeller?: string;
      signedByBuyer?: string;
      notes?: string;
    },
    actorRef = "owner",
  ): Promise<ActRow> {
    if ((input.actNo ?? "").trim() === "") throw new BadRequestException("Впиши номер акта");
    if (!ISO_DAY.test(input.actDate ?? "")) {
      throw new BadRequestException("Дата акта — в формате ГГГГ-ММ-ДД");
    }
    const created = await this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(grContract).where(eq(grContract.id, id)).for("update");
      if (!row) throw new NotFoundException("Договор не найден");
      if (row.status === "cancelled") {
        throw new ConflictException("Договор отменён — акты по нему не оформляются");
      }
      const [act] = await tx
        .insert(contractAct)
        .values({
          contractId: id,
          actNo: input.actNo.trim(),
          actDate: input.actDate,
          itemRefs: (input.itemRefs ?? []) as unknown as Record<string, unknown>[],
          signedBySeller: input.signedBySeller ?? null,
          signedByBuyer: input.signedByBuyer ?? null,
          notes: input.notes ?? null,
          createdBy: actorRef,
        })
        .returning();
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "contract.act_add",
        target: id,
        after: act,
      });
      return act;
    });
    await this.events.record({
      source: "contracts",
      type: "contract.act_created",
      payload: { contractId: id, actId: created.id, itemRefs: created.itemRefs },
    });
    return created;
  }
}
