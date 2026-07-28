import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { auditLog, task, taskComment } from "@mydon/db";
import type { Domain } from "@mydon/shared";
import { and, asc, desc, eq, isNotNull, lt, ne, sql, type SQL } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";

type TaskRow = typeof task.$inferSelect;
type CommentRow = typeof taskComment.$inferSelect;
type Status = "todo" | "in_progress" | "done" | "cancelled";
type Priority = "low" | "normal" | "high" | "urgent";

export interface CreateTaskInput {
  title: string;
  ownerKind: "human" | "agent";
  ownerRef?: string;
  domain?: Domain;
  due?: Date;
  source?: string;
  description?: string;
  priority?: Priority;
  createdBy?: string;
}

/** Сводка по исполнителю — «картина по людям» из контроля задач. */
export interface WorkloadRow {
  ownerKind: "human" | "agent";
  ownerRef: string | null;
  open: number;
  overdue: number;
  doneLast7d: number;
}

/**
 * Задачи (ТЗ §7).
 *
 * Владелец — человек или агент: одна очередь на обоих, чтобы «кто это делает»
 * было видно в одном месте, а не в голове.
 *
 * Просроченные задачи попадают в утренний брифинг наравне с деньгами
 * и автоматами — иначе смысла заводить их в системе нет.
 */
@Injectable()
export class TasksService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Создание вместе с записью в журнал — одной транзакцией. */
  async create(input: CreateTaskInput, actorRef = "system"): Promise<TaskRow> {
    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(task)
        .values({
          title: input.title,
          description: input.description ?? null,
          ownerKind: input.ownerKind,
          ownerRef: input.ownerRef ?? null,
          domain: input.domain ?? null,
          due: input.due ?? null,
          source: input.source ?? null,
          priority: input.priority ?? "normal",
          createdBy: input.createdBy ?? actorRef,
        })
        .returning();

      await tx.insert(auditLog).values({
        actorKind: "system",
        actorRef,
        action: "task.create",
        target: created.id,
        after: created,
      });
      return created;
    });
  }

  async list(
    filter: {
      status?: Status;
      domain?: Domain;
      ownerKind?: "human" | "agent";
      ownerRef?: string;
      openOnly?: boolean;
    } = {},
  ): Promise<TaskRow[]> {
    const conditions: SQL[] = [];
    if (filter.status) conditions.push(eq(task.status, filter.status));
    if (filter.domain) conditions.push(eq(task.domain, filter.domain));
    if (filter.ownerKind) conditions.push(eq(task.ownerKind, filter.ownerKind));
    if (filter.ownerRef) conditions.push(eq(task.ownerRef, filter.ownerRef));
    // «Открытые» — то, что реально в работе; закрытое не должно засорять список.
    if (filter.openOnly) {
      conditions.push(ne(task.status, "done"));
      conditions.push(ne(task.status, "cancelled"));
    }

    return this.db
      .select()
      .from(task)
      .where(conditions.length ? and(...conditions) : undefined)
      // Сначала срочное и с ближайшим сроком: список читается сверху вниз.
      .orderBy(asc(task.due), desc(task.priority), asc(task.createdAt))
      .limit(300);
  }

  async byId(id: string): Promise<TaskRow> {
    const [row] = await this.db.select().from(task).where(eq(task.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Задача ${id} не найдена`);
    return row;
  }

  /** Задачи одного исполнителя — то, что сотрудник видит в боте. */
  mine(ownerKind: "human" | "agent", ownerRef: string): Promise<TaskRow[]> {
    return this.list({ ownerKind, ownerRef, openOnly: true });
  }

  /** Просроченное: срок прошёл, а задача ещё не закрыта. */
  async overdue(): Promise<TaskRow[]> {
    return this.db
      .select()
      .from(task)
      .where(and(lt(task.due, new Date()), ne(task.status, "done"), ne(task.status, "cancelled")))
      .orderBy(asc(task.due))
      .limit(100);
  }

  /**
   * Смена статуса.
   *
   * Условие «статус ещё не такой» стоит в самом UPDATE: два одновременных
   * нажатия «Готово» иначе оба отчитались бы об успехе, а в журнале осталась
   * бы одна запись с непонятным автором.
   */
  async setStatus(
    id: string,
    status: Status,
    actorRef = "owner",
    resultNote?: string,
  ): Promise<TaskRow> {
    return this.db.transaction(async (tx) => {
      // Отчёт и время закрытия проставляются только при закрытии: иначе
      // «взял в работу» затирал бы отчёт о прошлом выполнении.
      const patch: Record<string, unknown> = { status };
      if (status === "done") {
        patch.completedAt = new Date();
        if (resultNote !== undefined && resultNote.trim().length > 0) {
          patch.resultNote = resultNote.trim();
        }
      }

      const [updated] = await tx
        .update(task)
        .set(patch)
        .where(and(eq(task.id, id), ne(task.status, status)))
        .returning();

      if (!updated) {
        const [row] = await tx.select().from(task).where(eq(task.id, id));
        if (!row) throw new NotFoundException(`Задача ${id} не найдена`);
        return row; // статус уже такой — повторное нажатие не ошибка
      }

      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: `task.${status}`,
        target: id,
        after: updated,
      });
      return updated;
    });
  }

  /**
   * Заводит задачу, если такой ещё нет на сегодня.
   *
   * Нужно для повторяющихся задач: планировщик может сработать дважды
   * (перезапуск контейнера, наложение расписаний), и без этой проверки
   * владелец каждое утро получал бы по три одинаковых «сделать инвентаризацию».
   */
  async ensureForDay(input: CreateTaskInput & { dayKey: string }): Promise<TaskRow | null> {
    const source = `${input.source ?? "recurring"}:${input.dayKey}`;
    const [existing] = await this.db.select().from(task).where(eq(task.source, source));
    if (existing) return null;
    return this.create({ ...input, source }, "scheduler");
  }

  // ── Переписка по задаче ────────────────────────────────────────────────────

  comments(taskId: string): Promise<CommentRow[]> {
    return this.db
      .select()
      .from(taskComment)
      .where(eq(taskComment.taskId, taskId))
      .orderBy(asc(taskComment.createdAt))
      .limit(200);
  }

  /** Комментарий = уточнение, вопрос или отчёт. Проверяем, что задача есть. */
  async addComment(taskId: string, authorRef: string, body: string): Promise<CommentRow> {
    await this.byId(taskId);
    const [created] = await this.db
      .insert(taskComment)
      .values({ taskId, authorRef, body })
      .returning();
    return created;
  }

  // ── Контроль ───────────────────────────────────────────────────────────────

  /**
   * Кому пора напомнить: срок близко (или прошёл), задача открыта,
   * и раньше мы про неё не напоминали. `remindedAt` — защита от повторов:
   * без неё сотрудник получал бы одно и то же напоминание каждый час.
   */
  dueSoon(withinHours = 24): Promise<TaskRow[]> {
    const until = new Date(Date.now() + withinHours * 3600_000);
    return this.db
      .select()
      .from(task)
      .where(
        and(
          isNotNull(task.due),
          lt(task.due, until),
          ne(task.status, "done"),
          ne(task.status, "cancelled"),
          sql`${task.remindedAt} is null`,
        ),
      )
      .orderBy(asc(task.due))
      .limit(50);
  }

  /** Отметка «напомнили» — ставится после фактической отправки. */
  async markReminded(id: string): Promise<void> {
    await this.db.update(task).set({ remindedAt: new Date() }).where(eq(task.id, id));
  }

  /**
   * Картина по людям и агентам: что висит, что просрочено, что сделано за неделю.
   * Один запрос вместо трёх на каждого исполнителя — список может быть длинным.
   */
  async workload(): Promise<WorkloadRow[]> {
    // Дату передаём строкой с явным приведением: без ::timestamptz PostgreSQL
    // не может вывести тип параметра внутри count(case ...) и падает.
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const rows = await this.db
      .select({
        ownerKind: task.ownerKind,
        ownerRef: task.ownerRef,
        open: sql<number>`count(*) filter (where ${task.status} not in ('done','cancelled'))`.as(
          "open",
        ),
        overdue:
          sql<number>`count(*) filter (where ${task.status} not in ('done','cancelled') and ${task.due} < now())`.as(
            "overdue",
          ),
        doneLast7d:
          sql<number>`count(*) filter (where ${task.status} = 'done' and ${task.completedAt} >= ${weekAgo}::timestamptz)`.as(
            "done_last_7d",
          ),
      })
      .from(task)
      .groupBy(task.ownerKind, task.ownerRef);

    return rows.map((r) => ({
      ownerKind: r.ownerKind,
      ownerRef: r.ownerRef,
      open: Number(r.open ?? 0),
      overdue: Number(r.overdue ?? 0),
      doneLast7d: Number(r.doneLast7d ?? 0),
    }));
  }
}
