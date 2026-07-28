import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { auditLog, task } from "@mydon/db";
import type { Domain } from "@mydon/shared";
import { and, asc, eq, lt, ne, type SQL } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";

type TaskRow = typeof task.$inferSelect;
type Status = "todo" | "in_progress" | "done" | "cancelled";

export interface CreateTaskInput {
  title: string;
  ownerKind: "human" | "agent";
  ownerRef?: string;
  domain?: Domain;
  due?: Date;
  source?: string;
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
          ownerKind: input.ownerKind,
          ownerRef: input.ownerRef ?? null,
          domain: input.domain ?? null,
          due: input.due ?? null,
          source: input.source ?? null,
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

  async list(filter: { status?: Status; domain?: Domain } = {}): Promise<TaskRow[]> {
    const conditions: SQL[] = [];
    if (filter.status) conditions.push(eq(task.status, filter.status));
    if (filter.domain) conditions.push(eq(task.domain, filter.domain));

    return this.db
      .select()
      .from(task)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(task.due), asc(task.createdAt))
      .limit(300);
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
  async setStatus(id: string, status: Status, actorRef = "owner"): Promise<TaskRow> {
    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(task)
        .set({ status })
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
}
