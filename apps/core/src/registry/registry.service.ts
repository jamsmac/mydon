import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { approval, entity, machineCard, moneyFlow, org, task } from "@mydon/db";
import { TZ, type Domain } from "@mydon/shared";
import { and, asc, count, desc, eq, lt, ne, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";

export interface ObligationsSummary {
  domain: Domain;
  /** Суммы разбиты ПО ВАЛЮТАМ: складывать UZS с USD в одно число бессмысленно. */
  totals: {
    direction: "in" | "out";
    status: string;
    currency: string;
    count: number;
    amount: string;
  }[];
  overdue: (typeof moneyFlow.$inferSelect)[];
  /** Сколько просроченных позиций всего и не обрезан ли список. */
  overdueTotal: number;
  overdueTruncated: boolean;
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
  /** Договоры с датой, которую не удалось разобрать — чтобы они не пропадали молча. */
  contractsBadDate: number;
  /** Задачи с прошедшим сроком: заводить задачи и не показывать просрочку бессмысленно. */
  overdueTasks: number;
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

    // Отменённые записи (ввод финконтура) — не обязательства: в своды не входят.
    const totals = await this.db
      .select({
        direction: moneyFlow.direction,
        status: moneyFlow.status,
        currency: moneyFlow.currency,
        count: count(),
        amount: sql<string>`coalesce(sum(${moneyFlow.amount}), 0)::text`,
      })
      .from(moneyFlow)
      .where(and(eq(moneyFlow.orgId, id), ne(moneyFlow.status, "cancelled")))
      .groupBy(moneyFlow.direction, moneyFlow.status, moneyFlow.currency);

    const overdueWhere = and(
      eq(moneyFlow.orgId, id),
      ne(moneyFlow.status, "actual"),
      ne(moneyFlow.status, "cancelled"),
      lt(moneyFlow.date, new Date()),
    );

    const OVERDUE_LIMIT = 200;
    const overdue = await this.db
      .select()
      .from(moneyFlow)
      .where(overdueWhere)
      .orderBy(asc(moneyFlow.date))
      .limit(OVERDUE_LIMIT);

    // Считаем общее число отдельно: без него владелец видел бы 200 позиций
    // и считал список полным, не зная, что часть просрочек скрыта.
    const [total] = await this.db.select({ n: count() }).from(moneyFlow).where(overdueWhere);
    const overdueTotal = total?.n ?? 0;

    return {
      domain,
      totals,
      overdue,
      overdueTotal,
      overdueTruncated: overdueTotal > overdue.length,
    };
  }

  /**
   * Сводка реестра: сколько каких записей в каждом направлении.
   * Владелец видит «GLOBERENT: контрагенты ×205, договоры ×496», а не пустой поиск.
   */
  async overview() {
    return this.db
      .select({ domain: org.code, type: entity.type, n: count() })
      .from(entity)
      .innerJoin(org, eq(org.id, entity.orgId))
      .groupBy(org.code, entity.type)
      .orderBy(org.code, entity.type);
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
      .where(
        and(
          ne(moneyFlow.status, "actual"),
          ne(moneyFlow.status, "cancelled"),
          lt(moneyFlow.date, now),
        ),
      );

    // Считаем по карточке автомата, а не по `attrs->>'status'`.
    //
    // Прежнее правило было мёртвым: атрибута `status` нет ни у одного автомата
    // парка, счётчик всегда возвращал ноль, и брифинг годами сообщал «все
    // работают» — включая дни, когда автомат стоял в мастерской. Теперь
    // состояние хранится явно (`machine_card.status`), и вопрос «сколько
    // автоматов не в работе» наконец имеет источник.
    const [idleMachines] = await this.db
      .select({ n: count() })
      .from(machineCard)
      .where(ne(machineCard.status, "in_service"));

    const [pendingApprovals] = await this.db
      .select({ n: count() })
      .from(approval)
      .where(eq(approval.decision, "pending"));

    // Даты сравниваем КАК СТРОКИ, без приведения к timestamptz.
    //
    // Приведение падало на датах, которые проходят проверку формы, но не существуют
    // ('2026-02-30' — типичная опечатка или результат выгрузки из Excel). Одна такая
    // строка роняла весь брифинг: владелец не получал НИ ОДНОЙ из четырёх тревог.
    // Строки в формате ISO-8601 сравниваются лексикографически так же, как даты,
    // и такое сравнение не может упасть в принципе.
    const today = this.dayKey(now);
    const horizon = this.dayKey(soon);

    const [contractsDueSoon] = await this.db
      .select({ n: count() })
      .from(entity)
      .where(
        and(
          eq(entity.type, "contract"),
          // Границы включают сегодняшний день: договор, истекающий сегодня, —
          // последняя возможность его продлить, о нём обязательно нужно сказать.
          sql`(${entity.attrs} ->> 'endDate') >= ${today}`,
          sql`(${entity.attrs} ->> 'endDate') < ${horizon}`,
        ),
      );

    // Договоры с датой, которую мы не понимаем (например «31.12.2026»), не должны
    // молча выпадать из тревог — считаем их отдельно и показываем владельцу.
    const [contractsBadDate] = await this.db
      .select({ n: count() })
      .from(entity)
      .where(
        and(
          eq(entity.type, "contract"),
          sql`(${entity.attrs} ->> 'endDate') is not null`,
          sql`(${entity.attrs} ->> 'endDate') !~ '^\\d{4}-\\d{2}-\\d{2}'`,
        ),
      );

    // Просроченные задачи — наравне с деньгами и автоматами: заводить задачи
    // и не показывать просрочку означало бы, что их можно спокойно не делать.
    const [overdueTasks] = await this.db
      .select({ n: count() })
      .from(task)
      .where(and(lt(task.due, now), ne(task.status, "done"), ne(task.status, "cancelled")));

    return {
      generatedAt: now.toISOString(),
      tz: TZ,
      overdueMoney: overdueMoney?.n ?? 0,
      idleMachines: idleMachines?.n ?? 0,
      pendingApprovals: pendingApprovals?.n ?? 0,
      contractsDueSoon: contractsDueSoon?.n ?? 0,
      contractsBadDate: contractsBadDate?.n ?? 0,
      overdueTasks: overdueTasks?.n ?? 0,
    };
  }

  /** Дата в виде YYYY-MM-DD по ташкентскому поясу — ключ для сравнения строк. */
  private dayKey(date: Date): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  }
}
