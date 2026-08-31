import { createHash } from "node:crypto";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { approval, entity, grContract, machineCard, moneyFlow, org, task } from "@mydon/db";
import { MAX_FIND_LIMIT, TZ, type Domain } from "@mydon/shared";
import { and, asc, count, desc, eq, gte, isNotNull, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { AGENT_SCHEDULE_SOURCE } from "../tasks/agent-schedule";

/**
 * Предикаты «строка НЕ из личного контура» (R-P5-7b).
 *
 * briefing/overview считают тревоги по ВСЕМ доменам, включая personal, и при
 * ужесточении отдавали бы не-владельцу число просрочек/задач личного контура.
 * Гейт по видимости (excludePersonal), а не глухой: владелец с owner-токеном
 * своё видит. Коррелированный `not exists`, а не `orgId <> personalId` —
 * `orgId` бывает NULL (осиротевшая строка), и `NULL <> …` вычеркнул бы её,
 * хотя личной она не является. Для task — NULL-safe `is distinct from`.
 */
function moneyNotPersonal(): SQL {
  return sql`not exists (select 1 from ${org} where ${org.id} = ${moneyFlow.orgId} and ${org.code} = 'personal')`;
}
function entityNotPersonal(): SQL {
  return sql`not exists (select 1 from ${org} where ${org.id} = ${entity.orgId} and ${org.code} = 'personal')`;
}
function taskNotPersonal(): SQL {
  return sql`${task.domain} is distinct from 'personal'`;
}
/** Автомат личного контура: карточка ссылается на entity личной org. */
function machineNotPersonal(): SQL {
  return sql`not exists (select 1 from ${entity} join ${org} on ${org.id} = ${entity.orgId} where ${entity.id} = ${machineCard.entityId} and ${org.code} = 'personal')`;
}

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
  /**
   * Договоры с приближающимся сроком: собранные карточки реестра с endDate в
   * горизонте ПЛЮС действующие договоры таблицы contract, у которых в том же
   * горизонте срок оплаты по графику (planned-строки money_flow).
   */
  contractsDueSoon: number;
  /** Договоры с датой, которую не удалось разобрать — чтобы они не пропадали молча. */
  contractsBadDate: number;
  /** Задачи с прошедшим сроком: заводить задачи и не показывать просрочку бессмысленно. */
  overdueTasks: number;
  /**
   * Стабильные различители СОСТАВА тревог — не число, а КАКИЕ ИМЕННО сущности
   * тревожат. Детерминированный (сортировка id) хеш по каждой категории. Нужен
   * дельта-памяти агентов: при РОТАЦИИ на том же числе (автомат A починен, встал
   * B — idleMachines по-прежнему 1) число не меняется, а состав меняется —
   * значит меняется и хеш, и агент подаёт НОВОЕ предложение, а не глотает его
   * как «ничего не изменилось». morning-digest кладёт эти хеши в signatureFacts
   * (ключ дедупа), а НЕ в отображаемые владельцу facts: показывать их незачем.
   * Пустая категория → пустая строка (нет тревоги — нечего различать).
   */
  alarmComposition: {
    overdueMoney: string;
    idleMachines: string;
    contractsDueSoon: string;
    overdueTasks: string;
  };
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
  async overview(excludePersonal = false) {
    return this.db
      .select({ domain: org.code, type: entity.type, n: count() })
      .from(entity)
      .innerJoin(org, eq(org.id, entity.orgId))
      // org уже в join — тут достаточно прямого сравнения кода направления,
      // not exists не нужен. Флаг выключен (дефолт) → undefined → SQL прежний.
      .where(excludePersonal ? ne(org.code, "personal") : undefined)
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
      // Потолок — общий MAX_FIND_LIMIT (как у /entities), а не зашитые 500.
      // Зашитый предел молча резал выборку: в GLOBERENT 988 registry-строк и
      // 704 счёта, а потребитель видел 500 «всех» записей и считал список
      // полным (аудит 31.08, п. 6). Усечение без признака усечения — худший
      // вид ответа; до потолка реестру расти на порядок.
      .limit(MAX_FIND_LIMIT);
  }

  /**
   * Данные утреннего брифинга (FR-6). Все четыре тревоги владельца из Ф11.
   * `now` — параметром: границы горизонта проверяемы тестом, а не часами машины.
   */
  async briefing(now: Date = new Date(), excludePersonal = false): Promise<Briefing> {
    const soon = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    // При ужесточении и не-owner запросе тревоги личного контура (деньги,
    // задачи, договоры, автоматы) в сводку не входят — гейт по видимости, не
    // глухой: owner-токен всё это видит. Флаг выключен (дефолт) → undefined →
    // предикат не добавляется, SQL и все четыре числа прежние (R-P5-7b).
    const moneyGate = excludePersonal ? moneyNotPersonal() : undefined;
    const entityGate = excludePersonal ? entityNotPersonal() : undefined;
    const taskGate = excludePersonal ? taskNotPersonal() : undefined;
    const machineGate = excludePersonal ? machineNotPersonal() : undefined;

    // Даты сравниваем КАК СТРОКИ, без приведения к timestamptz.
    //
    // Приведение падало на датах, которые проходят проверку формы, но не существуют
    // ('2026-02-30' — типичная опечатка или результат выгрузки из Excel). Одна такая
    // строка роняла весь брифинг: владелец не получал НИ ОДНОЙ из четырёх тревог.
    // Строки в формате ISO-8601 сравниваются лексикографически так же, как даты,
    // и такое сравнение не может упасть в принципе.
    const today = this.dayKey(now);
    const horizon = this.dayKey(soon);

    // Просрочка денег — по СРОКУ, когда срок задан. У строк графика оплат
    // (planned) `date` — момент создания записи (finance.service.ts, writeFlow
    // подставляет new Date()), и по `date` любая такая строка «просрочена»
    // сразу после создания — даже та, чей dueDate ещё впереди: один договор
    // давал бы сразу две тревоги (overdueMoney и contractsDueSoon). Поэтому
    // строки с dueDate считаются просроченными по dueDate < сегодня, и только
    // строки без срока (ручные обязательства, комиссии) — по прежнему признаку.
    // Берём id, а не count(): число — это длина списка, а состав (для различителя
    // дельта-памяти) — сами id. Один запрос вместо двух даёт и то, и другое.
    const overdueMoneyRows = await this.db
      .select({ id: moneyFlow.id })
      .from(moneyFlow)
      .where(
        and(
          ne(moneyFlow.status, "actual"),
          ne(moneyFlow.status, "cancelled"),
          or(
            and(isNotNull(moneyFlow.dueDate), lt(moneyFlow.dueDate, today)),
            and(isNull(moneyFlow.dueDate), lt(moneyFlow.date, now)),
          ),
          moneyGate,
        ),
      );

    // Считаем по карточке автомата, а не по `attrs->>'status'`.
    //
    // Прежнее правило было мёртвым: атрибута `status` нет ни у одного автомата
    // парка, счётчик всегда возвращал ноль, и брифинг годами сообщал «все
    // работают» — включая дни, когда автомат стоял в мастерской. Теперь
    // состояние хранится явно (`machine_card.status`), и вопрос «сколько
    // автоматов не в работе» наконец имеет источник.
    const idleMachineRows = await this.db
      .select({ id: machineCard.entityId })
      .from(machineCard)
      .where(and(ne(machineCard.status, "in_service"), machineGate));

    const [pendingApprovals] = await this.db
      .select({ n: count() })
      .from(approval)
      .where(eq(approval.decision, "pending"));

    const contractsDueSoonLegacyRows = await this.db
      .select({ id: entity.id })
      .from(entity)
      .where(
        and(
          eq(entity.type, "contract"),
          // Границы включают сегодняшний день: договор, истекающий сегодня, —
          // последняя возможность его продлить, о нём обязательно нужно сказать.
          sql`(${entity.attrs} ->> 'endDate') >= ${today}`,
          sql`(${entity.attrs} ->> 'endDate') < ${horizon}`,
          entityGate,
        ),
      );

    // Типизированные договоры — таблица contract, её же показывает раздел
    // «Договоры купли-продажи» (аудит 31.08, п. 6). Собранных карточек
    // entity.type='contract' на проде НОЛЬ при 265 договорах в таблице, и
    // прежний подсчёт держал тревогу на нуле при живом контуре. endDate у
    // договора купли-продажи нет — его «срок» это график оплат: действующие
    // договоры с planned-строкой money_flow, чей dueDate попадает в тот же
    // 14-дневный горизонт. Просроченные сроки сюда не входят — их уже считает
    // overdueMoney (для строк с dueDate — именно по dueDate < сегодня, см.
    // выше), поэтому границы не пересекаются и двойной тревоги по одной
    // строке нет: dueDate < сегодня — просрочка, ≥ сегодня и < горизонта — «к сроку».
    const contractsDueSoonTypedRows = await this.db
      .select({ contractId: moneyFlow.contractId })
      .from(moneyFlow)
      .innerJoin(grContract, eq(grContract.id, moneyFlow.contractId))
      .where(
        and(
          eq(grContract.status, "active"),
          eq(moneyFlow.status, "planned"),
          eq(moneyFlow.direction, "in"),
          gte(moneyFlow.dueDate, today),
          lt(moneyFlow.dueDate, horizon),
          moneyGate,
        ),
      );
    // distinct по договору: у одного договора может быть несколько planned-строк
    // графика в горизонте — тревога всё равно про ОДИН договор.
    const contractsDueSoonTypedIds = [
      ...new Set(
        contractsDueSoonTypedRows.map((r) => r.contractId).filter((v): v is string => v !== null),
      ),
    ];

    // Договоры с датой, которую мы не понимаем (например «31.12.2026»), не должны
    // молча выпадать из тревог — считаем их отдельно и показываем владельцу.
    // Только собранные карточки: в типизированной таблице дата — колонка date,
    // кривой строкой она не бывает по построению.
    const [contractsBadDate] = await this.db
      .select({ n: count() })
      .from(entity)
      .where(
        and(
          eq(entity.type, "contract"),
          sql`(${entity.attrs} ->> 'endDate') is not null`,
          sql`(${entity.attrs} ->> 'endDate') !~ '^\\d{4}-\\d{2}-\\d{2}'`,
          entityGate,
        ),
      );

    // Просроченные задачи — наравне с деньгами и автоматами: заводить задачи
    // и не показывать просрочку означало бы, что их можно спокойно не делать.
    const overdueTaskRows = await this.db
      .select({ id: task.id })
      .from(task)
      .where(
        and(
          lt(task.due, now),
          ne(task.status, "done"),
          ne(task.status, "cancelled"),
          or(isNull(task.source), ne(task.source, AGENT_SCHEDULE_SOURCE)),
          taskGate,
        ),
      );

    const overdueMoneyIds = overdueMoneyRows.map((r) => r.id);
    const idleMachineIds = idleMachineRows.map((r) => r.id);
    // Договоры «на исходе» — из ДВУХ источников (собранные карточки + типизированная
    // таблица). Метим префиксом, чтобы совпавший UUID из разных таблиц не слился.
    const contractsDueSoonIds = [
      ...contractsDueSoonLegacyRows.map((r) => `e:${r.id}`),
      ...contractsDueSoonTypedIds.map((id) => `c:${id}`),
    ];
    const overdueTaskIds = overdueTaskRows.map((r) => r.id);

    return {
      generatedAt: now.toISOString(),
      tz: TZ,
      overdueMoney: overdueMoneyIds.length,
      idleMachines: idleMachineIds.length,
      pendingApprovals: pendingApprovals?.n ?? 0,
      contractsDueSoon: contractsDueSoonIds.length,
      contractsBadDate: contractsBadDate?.n ?? 0,
      overdueTasks: overdueTaskIds.length,
      alarmComposition: {
        overdueMoney: this.composition(overdueMoneyIds),
        idleMachines: this.composition(idleMachineIds),
        contractsDueSoon: this.composition(contractsDueSoonIds),
        overdueTasks: this.composition(overdueTaskIds),
      },
    };
  }

  /**
   * Детерминированный различитель состава: sha256 по ОТСОРТИРОВАННЫМ id.
   * Сортировка обязательна — без неё порядок строк из БД «плавал» бы и хеш
   * менялся сам по себе (ложная тревога дельта-памяти). Пусто → пустая строка:
   * нет тревоги — нечего различать (и сигнатура morning-digest не «застынет» на
   * несуществующем ключе).
   */
  private composition(ids: string[]): string {
    if (ids.length === 0) return "";
    return createHash("sha256").update([...ids].sort().join("\n")).digest("hex");
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
