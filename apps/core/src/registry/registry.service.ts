import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { approval, entity, moneyFlow, org } from "@mydon/db";
import type { Domain } from "@mydon/shared";
import { and, asc, count, desc, eq, lt, ne, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";

export interface ObligationsSummary {
  domain: Domain;
  totals: { direction: "in" | "out"; status: string; count: number; amount: string }[];
  overdue: (typeof moneyFlow.$inferSelect)[];
}

export interface Briefing {
  generatedAt: string;
  tz: string;
  /** Просрочено — то, что будит ночью (Ф11). */
  overdueMoney: number;
  /** Автоматы без признака работы. */
  idleMachines: number;
  /** Требует решения сегодня — очередь согласований (FR-3). */
  pendingApprovals: number;
  /** Договоры с приближающимся сроком. */
  contractsDueSoon: number;
}

/**
 * Запросы к реестру, ради которых строится Core (ТЗ Фаза 3 DoD):
 * «все обязательства GLOBERENT» и «статус автоматов».
 * Источник данных для утреннего брифинга 07:30 (FR-6).
 */
@Injectable()
export class RegistryService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async orgId(domain: Domain): Promise<string> {
    const [row] = await this.db.select({ id: org.id }).from(org).where(eq(org.code, domain));
    if (!row) {
      throw new NotFoundException(
        `Направление "${domain}" не заведено. Выполните структурный сид (pnpm db:seed).`,
      );
    }
    return row.id;
  }

  /** Обязательства направления: сводка по направлению движения и статусу + просроченное. */
  async obligations(domain: Domain): Promise<ObligationsSummary> {
    const id = await this.orgId(domain);

    const totals = await this.db
      .select({
        direction: moneyFlow.direction,
        status: moneyFlow.status,
        count: count(),
        amount: sql<string>`coalesce(sum(${moneyFlow.amount}), 0)::text`,
      })
      .from(moneyFlow)
      .where(eq(moneyFlow.orgId, id))
      .groupBy(moneyFlow.direction, moneyFlow.status);

    const overdue = await this.db
      .select()
      .from(moneyFlow)
      .where(
        and(eq(moneyFlow.orgId, id), ne(moneyFlow.status, "actual"), lt(moneyFlow.date, new Date())),
      )
      .orderBy(asc(moneyFlow.date))
      .limit(200);

    return { domain, totals, overdue };
  }

  /** Сущности направления по типу — например автоматы VendHub. */
  async byType(domain: Domain, type: string) {
    const id = await this.orgId(domain);
    return this.db
      .select()
      .from(entity)
      .where(and(eq(entity.orgId, id), eq(entity.type, type)))
      .orderBy(desc(entity.updatedAt))
      .limit(500);
  }

  /** Данные утреннего брифинга (FR-6). Все четыре тревоги владельца из Ф11. */
  async briefing(): Promise<Briefing> {
    const now = new Date();
    const soon = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    const [overdueMoney] = await this.db
      .select({ n: count() })
      .from(moneyFlow)
      .where(and(ne(moneyFlow.status, "actual"), lt(moneyFlow.date, now)));

    const [idleMachines] = await this.db
      .select({ n: count() })
      .from(entity)
      .where(and(eq(entity.type, "machine"), sql`${entity.attrs} ->> 'status' = 'idle'`));

    const [pendingApprovals] = await this.db
      .select({ n: count() })
      .from(approval)
      .where(eq(approval.decision, "pending"));

    // Дату передаём строкой ISO с явным приведением: драйвер не принимает объект Date
    // внутри сырого SQL. CASE защищает от битой даты в attrs — иначе одна кривая
    // строка уронила бы весь брифинг в 07:30.
    const [contractsDueSoon] = await this.db
      .select({ n: count() })
      .from(entity)
      .where(
        and(
          eq(entity.type, "contract"),
          sql`case
                when (${entity.attrs} ->> 'endDate') ~ '^\\d{4}-\\d{2}-\\d{2}'
                then (${entity.attrs} ->> 'endDate')::timestamptz
                else null
              end between ${now.toISOString()}::timestamptz and ${soon.toISOString()}::timestamptz`,
        ),
      );

    return {
      generatedAt: now.toISOString(),
      tz: process.env.TZ ?? "Asia/Tashkent",
      overdueMoney: overdueMoney?.n ?? 0,
      idleMachines: idleMachines?.n ?? 0,
      pendingApprovals: pendingApprovals?.n ?? 0,
      contractsDueSoon: contractsDueSoon?.n ?? 0,
    };
  }
}
