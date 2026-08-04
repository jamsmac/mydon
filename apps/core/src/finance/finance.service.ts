import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { auditLog, entity, fxRate, moneyFlow, org } from "@mydon/db";
import { TZ, type Domain } from "@mydon/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import {
  aging,
  byMonth,
  concentration,
  dayKey,
  dueSoon,
  uzsEquivalent,
  type AgingReport,
  type ConcentrationReport,
  type FlowForMath,
  type MonthCash,
} from "./finance.math";

type FlowRow = typeof moneyFlow.$inferSelect;
type FxRow = typeof fxRate.$inferSelect;

/** Категории — словарь PROMACH (warehouse_payments), сжатый под GLOBERENT. */
export const FLOW_CATEGORIES = [
  "sale", // продажа техники/услуг клиенту
  "service", // сервис и запчасти
  "supplier", // оплата заводу/поставщику
  "logistics",
  "customs",
  "certification",
  "tax",
  "rent",
  "other",
] as const;

const METHODS = ["bank", "cash"] as const;
const CURRENCY_RE = /^[A-Z]{3}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface CreateFlowInput {
  domain: Domain;
  direction: "in" | "out";
  /** planned — обязательство (долг/счёт), actual — свершившийся платёж. */
  status: "planned" | "actual";
  amount: number;
  currency?: string;
  category?: string;
  method?: "bank" | "cash";
  isOfficial?: boolean;
  /** Курс к суму на дату операции. Не задан — берётся действующий из fx_rate. */
  rate?: number;
  counterpartyId?: string;
  counterparty?: string;
  docNo?: string;
  purpose?: string;
  /** Дата операции (ISO). По умолчанию — сейчас. */
  date?: string;
  /** Срок оплаты YYYY-MM-DD — для planned. */
  dueDate?: string;
}

/** Строка списка: с именем контрагента из реестра — панель не делает лишних запросов. */
export interface FlowListRow extends FlowRow {
  counterpartyEntityName: string | null;
  /** Эквивалент в сумах (null — курса нет). */
  uzs: number | null;
}

export interface FxCurrent {
  currency: string;
  rate: string;
  source: string;
  note: string | null;
  setBy: string | null;
  createdAt: Date;
}

export interface FinanceSummary {
  domain: Domain;
  today: string;
  receivables: AgingReport;
  payables: AgingReport;
  dueSoonIn: FlowListRow[];
  dueSoonOut: FlowListRow[];
  concentration: ConcentrationReport;
  months: MonthCash[];
  fx: FxCurrent[];
}

/**
 * Финансовый контур GLOBERENT — перенос модели PROMACH на реестр MYDON.
 *
 * money_flow держит и план (обязательство со сроком), и факт (платёж).
 * Агинг, «к сроку ≤ 7 дней», термометр концентрации и кэш-флоу считаются
 * чистыми функциями (finance.math.ts) — их покрывают golden-тесты: главная
 * слабость донора (деньги без тестов) не переезжает вместе с кодом.
 */
@Injectable()
export class FinanceService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async orgId(domain: Domain): Promise<string> {
    const [row] = await this.db.select({ id: org.id }).from(org).where(eq(org.code, domain));
    if (!row) {
      throw new NotFoundException(`Направление "${domain}" не заведено. Выполните pnpm db:seed.`);
    }
    return row.id;
  }

  /** Действующий курс каждой валюты — последняя запись истории. */
  async fxCurrent(): Promise<FxCurrent[]> {
    const rows = await this.db
      .select()
      .from(fxRate)
      .orderBy(desc(fxRate.createdAt))
      .limit(200);
    const latest = new Map<string, FxRow>();
    for (const r of rows) {
      if (!latest.has(r.currency)) latest.set(r.currency, r);
    }
    return [...latest.values()].map((r) => ({
      currency: r.currency,
      rate: r.rate,
      source: r.source,
      note: r.note,
      setBy: r.setBy,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Задать курс вручную (PROMACH: manual override — у нас основной путь).
   * История не переписывается: каждая установка — новая строка.
   */
  async setFx(input: { currency: string; rate: number; note?: string }, actorRef = "owner"): Promise<FxCurrent[]> {
    const currency = (input.currency ?? "").toUpperCase().trim();
    if (!CURRENCY_RE.test(currency)) {
      throw new BadRequestException("Валюта — трёхбуквенный код: USD, CNY, EUR…");
    }
    if (currency === "UZS") {
      throw new BadRequestException("Курс сума к суму всегда 1 — задавать его не нужно");
    }
    if (!Number.isFinite(input.rate) || input.rate <= 0) {
      throw new BadRequestException("Курс — положительное число сумов за единицу валюты");
    }
    await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(fxRate)
        .values({
          currency,
          rate: String(input.rate),
          source: "manual",
          note: input.note ?? null,
          setBy: actorRef,
        })
        .returning();
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "finance.fx_set",
        target: currency,
        after: created,
      });
    });
    return this.fxCurrent();
  }

  /** Завести обязательство или платёж. Курс не задан — подставляется действующий. */
  async createFlow(input: CreateFlowInput, actorRef = "owner"): Promise<FlowRow> {
    const currency = (input.currency ?? "UZS").toUpperCase().trim();
    if (!CURRENCY_RE.test(currency)) {
      throw new BadRequestException("Валюта — трёхбуквенный код: UZS, USD, CNY…");
    }
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      throw new BadRequestException("Сумма — положительное число");
    }
    if (input.status !== "planned" && input.status !== "actual") {
      throw new BadRequestException("Статус — planned (обязательство) или actual (платёж)");
    }
    if (input.category !== undefined && !(FLOW_CATEGORIES as readonly string[]).includes(input.category)) {
      throw new BadRequestException(`Категория — одна из: ${FLOW_CATEGORIES.join(", ")}`);
    }
    if (input.method !== undefined && !(METHODS as readonly string[]).includes(input.method)) {
      throw new BadRequestException("Способ — bank или cash");
    }
    if (input.dueDate !== undefined && !ISO_DAY.test(input.dueDate)) {
      throw new BadRequestException("Срок оплаты — дата в формате ГГГГ-ММ-ДД");
    }
    if (input.rate !== undefined && (!Number.isFinite(input.rate) || input.rate <= 0)) {
      throw new BadRequestException("Курс — положительное число");
    }
    const orgId = await this.orgId(input.domain);

    if (input.counterpartyId !== undefined) {
      const [cp] = await this.db
        .select({ id: entity.id })
        .from(entity)
        .where(eq(entity.id, input.counterpartyId))
        .limit(1);
      if (!cp) throw new NotFoundException("Контрагент не найден в реестре");
    }

    // Курс на дату операции фиксируется В ЗАПИСИ (PROMACH, миграция 083):
    // исторические суммы не плавают при смене действующего курса.
    let rate: number | null = input.rate ?? null;
    if (rate === null && currency !== "UZS") {
      const current = await this.fxCurrent();
      const found = current.find((r) => r.currency === currency);
      if (found) rate = Number(found.rate);
    }
    const amountUzs = currency === "UZS" ? null : rate !== null ? input.amount * rate : null;

    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(moneyFlow)
        .values({
          orgId,
          domain: input.domain,
          direction: input.direction,
          amount: String(input.amount),
          currency,
          source: "manual",
          purpose: input.purpose ?? null,
          category: input.category ?? null,
          method: input.method ?? null,
          isOfficial: input.isOfficial ?? input.method !== "cash",
          rate: rate !== null ? String(rate) : null,
          amountUzs: amountUzs !== null ? String(amountUzs) : null,
          counterpartyId: input.counterpartyId ?? null,
          counterparty: input.counterparty ?? null,
          docNo: input.docNo ?? null,
          date: input.date !== undefined ? new Date(input.date) : new Date(),
          status: input.status,
          dueDate: input.dueDate ?? null,
          paidAt: input.status === "actual" ? new Date() : null,
        })
        .returning();
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "finance.flow_created",
        target: created.id,
        after: created,
      });
      return created;
    });
  }

  /** Отметить обязательство оплаченным: план становится фактом, след — в журнале. */
  async markPaid(id: string, opts: { rate?: number } = {}, actorRef = "owner"): Promise<FlowRow> {
    if (opts.rate !== undefined && (!Number.isFinite(opts.rate) || opts.rate <= 0)) {
      throw new BadRequestException("Курс — положительное число");
    }
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(moneyFlow).where(eq(moneyFlow.id, id)).for("update");
      if (!row) throw new NotFoundException("Запись не найдена");
      if (row.status !== "planned") {
        throw new BadRequestException(`Запись уже закрыта (${row.status})`);
      }
      const rate = opts.rate !== undefined ? opts.rate : row.rate !== null ? Number(row.rate) : null;
      const amountUzs =
        row.currency === "UZS"
          ? null
          : rate !== null
            ? Number(row.amount) * rate
            : row.amountUzs !== null
              ? Number(row.amountUzs)
              : null;
      const [updated] = await tx
        .update(moneyFlow)
        .set({
          status: "actual",
          paidAt: new Date(),
          rate: rate !== null ? String(rate) : null,
          amountUzs: amountUzs !== null ? String(amountUzs) : null,
        })
        .where(eq(moneyFlow.id, id))
        .returning();
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "finance.flow_paid",
        target: id,
        before: row,
        after: updated,
      });
      return updated;
    });
  }

  /** Отмена ошибочной записи. Строка остаётся — из сводов уходит. */
  async cancelFlow(id: string, actorRef = "owner"): Promise<FlowRow> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(moneyFlow).where(eq(moneyFlow.id, id)).for("update");
      if (!row) throw new NotFoundException("Запись не найдена");
      if (row.status === "cancelled") {
        throw new BadRequestException("Запись уже отменена");
      }
      const [updated] = await tx
        .update(moneyFlow)
        .set({ status: "cancelled" })
        .where(eq(moneyFlow.id, id))
        .returning();
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "finance.flow_cancelled",
        target: id,
        before: row,
        after: updated,
      });
      return updated;
    });
  }

  /** Лента записей направления с именами контрагентов. */
  async flows(
    domain: Domain,
    opts: { status?: "planned" | "actual" | "cancelled"; direction?: "in" | "out"; limit?: number } = {},
  ): Promise<FlowListRow[]> {
    const orgId = await this.orgId(domain);
    const conditions = [eq(moneyFlow.orgId, orgId)];
    if (opts.status !== undefined) conditions.push(eq(moneyFlow.status, opts.status));
    if (opts.direction !== undefined) conditions.push(eq(moneyFlow.direction, opts.direction));
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
    const rows = await this.db
      .select({ flow: moneyFlow, counterpartyEntityName: entity.name })
      .from(moneyFlow)
      .leftJoin(entity, eq(entity.id, moneyFlow.counterpartyId))
      .where(and(...conditions))
      .orderBy(desc(moneyFlow.date))
      .limit(limit);
    return rows.map((r) => ({
      ...r.flow,
      counterpartyEntityName: r.counterpartyEntityName,
      uzs: uzsEquivalent(r.flow),
    }));
  }

  /** Финансовый свод направления: агинг, «к сроку», термометр, кэш-флоу, курс. */
  async summary(domain: Domain): Promise<FinanceSummary> {
    const orgId = await this.orgId(domain);
    const today = dayKey(new Date(), TZ);
    const yearAgo = new Date();
    yearAgo.setDate(yearAgo.getDate() - 366);

    // Открытые планы нужны все (долг живёт годами), факты — за 12 месяцев.
    const rows = await this.db
      .select({ flow: moneyFlow, counterpartyEntityName: entity.name })
      .from(moneyFlow)
      .leftJoin(entity, eq(entity.id, moneyFlow.counterpartyId))
      .where(
        and(
          eq(moneyFlow.orgId, orgId),
          sql`(${moneyFlow.status} = 'planned' or (${moneyFlow.status} = 'actual' and ${moneyFlow.date} >= ${yearAgo}))`,
        ),
      )
      .orderBy(desc(moneyFlow.date))
      .limit(5000);

    const forMath: (FlowForMath & { row: FlowListRow })[] = rows.map((r) => ({
      id: r.flow.id,
      direction: r.flow.direction,
      status: r.flow.status,
      amount: r.flow.amount,
      currency: r.flow.currency,
      rate: r.flow.rate,
      amountUzs: r.flow.amountUzs,
      dueDate: r.flow.dueDate,
      date: r.flow.date,
      counterpartyKey: r.flow.counterpartyId ?? r.flow.counterparty,
      counterpartyName: r.counterpartyEntityName ?? r.flow.counterparty,
      row: { ...r.flow, counterpartyEntityName: r.counterpartyEntityName, uzs: uzsEquivalent(r.flow) },
    }));

    const soonIn = dueSoon(forMath, "in", today, 7);
    const soonOut = dueSoon(forMath, "out", today, 7);
    const pick = (list: FlowForMath[]): FlowListRow[] =>
      list.map((f) => (f as FlowForMath & { row: FlowListRow }).row);

    return {
      domain,
      today,
      receivables: aging(forMath, "in", today),
      payables: aging(forMath, "out", today),
      dueSoonIn: pick(soonIn),
      dueSoonOut: pick(soonOut),
      concentration: concentration(forMath),
      months: byMonth(forMath, TZ, 12),
      fx: await this.fxCurrent(),
    };
  }

  /** Контрагенты направления — кандидаты привязки записи. */
  async counterpartyCandidates(domain: Domain): Promise<{ id: string; name: string; inn: string | null }[]> {
    const orgId = await this.orgId(domain);
    const rows = await this.db
      .select({ id: entity.id, name: entity.name, inn: entity.externalRef })
      .from(entity)
      .where(and(eq(entity.orgId, orgId), inArray(entity.type, ["contractor", "counterparty", "supplier"])))
      .orderBy(entity.name)
      .limit(500);
    return rows;
  }
}
