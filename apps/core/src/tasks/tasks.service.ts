import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { auditLog, machineCard, task, taskComment } from "@mydon/db";
import { machineIsOperational, type Domain } from "@mydon/shared";
import { and, asc, desc, eq, isNotNull, lt, ne, sql, type SQL, isNull } from "drizzle-orm";
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
  /** По какому объекту работа: автомат, точка, склад. */
  entityId?: string;
  /** Ключ идемпотентности от клиента: ретрай не даёт дубль-задачу. */
  clientKey?: string;
}

/** Сводка по исполнителю — «картина по людям» из контроля задач. */
export interface WorkloadRow {
  ownerKind: "human" | "agent";
  ownerRef: string | null;
  open: number;
  overdue: number;
  doneLast7d: number;
  /** Качество: сколько сделанных отмечено «отлично» и сколько вернулось на доработку. */
  excellent: number;
  redo: number;
  /** Дисциплина сроков: сделано в срок / сделано со сроком. */
  doneOnTime: number;
  doneWithDue: number;
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
          entityId: input.entityId ?? null,
          clientKey: input.clientKey ?? null,
        })
        .onConflictDoNothing({ target: task.clientKey })
        .returning();

      // Повтор по clientKey: заявка уже создана первой попыткой — возвращаем
      // её же, без второй записи в журнал.
      if (!created) {
        const [existing] = await tx
          .select()
          .from(task)
          .where(eq(task.clientKey, input.clientKey!))
          .limit(1);
        if (!existing) {
          throw new Error("Повтор заявки ещё сохраняется — попробуй ещё раз");
        }
        return existing;
      }

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
   * Правка полей задачи владельцем из панели: переназначить исполнителя,
   * сменить приоритет, срок, заголовок, описание. Меняем ТОЛЬКО переданные поля
   * (частичное обновление) — статус и отчёт живут своим потоком (setStatus/rate)
   * и здесь не трогаются. Пустой патч → возвращаем задачу без записи в журнал.
   */
  async edit(
    id: string,
    patch: {
      title?: string;
      description?: string | null;
      ownerKind?: "human" | "agent";
      ownerRef?: string | null;
      priority?: Priority;
      due?: Date | null;
      entityId?: string | null;
    },
    actorRef = "owner",
  ): Promise<TaskRow> {
    const set: Record<string, unknown> = {};
    if (patch.title !== undefined) {
      const t = patch.title.trim();
      if (t.length === 0) throw new BadRequestException("Заголовок не может быть пустым");
      set.title = t;
    }
    if (patch.description !== undefined) {
      const d = (patch.description ?? "").trim();
      set.description = d.length > 0 ? d : null;
    }
    if (patch.ownerKind !== undefined) set.ownerKind = patch.ownerKind;
    if (patch.ownerRef !== undefined) {
      const r = (patch.ownerRef ?? "").trim();
      set.ownerRef = r.length > 0 ? r : null;
    }
    if (patch.priority !== undefined) set.priority = patch.priority;
    if (patch.due !== undefined) set.due = patch.due;
    if (patch.entityId !== undefined) set.entityId = patch.entityId;

    if (Object.keys(set).length === 0) return this.byId(id);

    return this.db.transaction(async (tx) => {
      const [updated] = await tx.update(task).set(set).where(eq(task.id, id)).returning();
      if (!updated) throw new NotFoundException(`Задача ${id} не найдена`);
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "task.edit",
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
  /**
   * Автомат в эксплуатации? Объект без карточки автомата (техника, помещение,
   * договор) считается рабочим: признак заводился для парка, а не для всего
   * реестра, и молчаливое исключение всего остального было бы хуже задачи.
   */
  private async machineIsOperationalCheck(entityId: string): Promise<boolean> {
    const [card] = await this.db
      .select({ status: machineCard.status })
      .from(machineCard)
      .where(eq(machineCard.entityId, entityId))
      .limit(1);
    return machineIsOperational(card?.status);
  }

  async ensureForDay(input: CreateTaskInput & { dayKey: string }): Promise<TaskRow | null> {
    // Автомату вне эксплуатации повторяющиеся задачи не ставим.
    //
    // Правило соблюдает монитор графиков — он спрашивает состояние и
    // пропускает такие строки. Но правило, которое живёт у ОДНОГО вызывающего,
    // держится только пока вызывающий один: `POST /tasks/ensure-day` открыт, и
    // следующий источник повторяющихся задач обойдёт его молча, ничего не
    // нарушив явно.
    //
    // Проверка здесь — страховка, а не замена: монитор по-прежнему считает
    // пропуски и называет причину, потому что ему есть что сказать владельцу.
    // Core же просто не заводит работу, которую физически некому выполнить.
    if (input.entityId && !(await this.machineIsOperationalCheck(input.entityId))) return null;

    const source = `${input.source ?? "recurring"}:${input.dayKey}`;
    // Было select-then-insert: два тика монитора в одну секунду проходили
    // проверку оба и создавали две задачи на один день. Ставку делает БД —
    // частичный уникальный индекс task_source_key (миграция 0040).
    const [created] = await this.db
      .insert(task)
      .values({
        title: input.title,
        description: input.description ?? null,
        ownerKind: input.ownerKind,
        ownerRef: input.ownerRef ?? null,
        domain: input.domain ?? null,
        due: input.due ?? null,
        source,
        priority: input.priority ?? "normal",
        createdBy: input.createdBy ?? "scheduler",
        entityId: input.entityId ?? null,
      })
      .onConflictDoNothing({ target: task.source })
      .returning();
    if (!created) return null;

    await this.db.insert(auditLog).values({
      actorKind: "system",
      actorRef: "scheduler",
      action: "task.create",
      target: created.id,
      after: created,
    });
    return created;
  }

  // ── Общий пул: свободные задачи ────────────────────────────────────────────
  //
  // Закрепления сотрудников за объектами нет — все работают по всему парку,
  // поэтому автосозданная задача рождается без исполнителя и её разбирают.
  // Это нормальное состояние, а не дефект настройки.

  /** Свободные задачи: никто не взял, но работа стоит. */
  unassigned(limit = 50): Promise<TaskRow[]> {
    return this.db
      .select()
      .from(task)
      .where(
        and(
          eq(task.ownerKind, "human"),
          isNull(task.ownerRef),
          ne(task.status, "done"),
          ne(task.status, "cancelled"),
        ),
      )
      .orderBy(asc(task.due), desc(task.priority), asc(task.createdAt))
      .limit(limit);
  }

  /**
   * Взять свободную задачу.
   *
   * Двое, нажавших «Беру» одновременно, — это не редкий случай, а обычное утро
   * при одном общем дайджесте. Гонку разрешает БД: `WHERE owner_ref IS NULL`
   * внутри самого UPDATE. Проигравший получает null и увидит имя победителя,
   * а не ошибку.
   */
  async claim(id: string, personId: string): Promise<TaskRow | null> {
    return this.db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(task)
        .set({ ownerKind: "human", ownerRef: personId })
        .where(and(eq(task.id, id), eq(task.ownerKind, "human"), isNull(task.ownerRef)))
        .returning();
      if (!claimed) return null;

      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef: `person:${personId}`,
        action: "task.claimed",
        target: claimed.id,
        after: claimed,
      });
      return claimed;
    });
  }

  /**
   * Вернуть задачу в пул.
   *
   * Без этого техник, взявший задачу и застрявший (нет запчасти, точка
   * закрыта), молча блокирует её до срока: другим она уже не видна как
   * свободная, а он её не сделает.
   */
  async release(id: string, personId: string): Promise<TaskRow | null> {
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(task).where(eq(task.id, id)).limit(1);
      if (!before) throw new NotFoundException(`Задача ${id} не найдена`);
      // Отпустить можно только своё: иначе один сотрудник снимает задачу с другого.
      if (before.ownerRef !== personId) return null;

      const [freed] = await tx
        .update(task)
        .set({ ownerRef: null, status: before.status === "in_progress" ? "todo" : before.status })
        .where(eq(task.id, id))
        .returning();

      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef: `person:${personId}`,
        action: "task.released",
        target: id,
        before,
        after: freed,
      });
      return freed;
    });
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
  /**
   * Оценка сделанной задачи владельцем: отлично / принято / переделать.
   *
   * «Переделать» — не просто отметка: задача возвращается в работу, отчёт
   * остаётся в переписке, а напоминания включаются заново. Так качество
   * отмечается делом, а не забытым флажком.
   */
  async rate(id: string, quality: "excellent" | "accepted" | "redo", actorRef = "owner"): Promise<TaskRow> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(task).where(eq(task.id, id));
      if (!row) throw new NotFoundException(`Задача ${id} не найдена`);
      if (row.status !== "done") {
        throw new BadRequestException("Оценить можно только сделанную задачу");
      }

      const patch: Record<string, unknown> = { quality };
      if (quality === "redo") {
        patch.status = "in_progress";
        patch.completedAt = null;
        patch.remindedAt = null; // напоминания должны включиться заново
        patch.redoNotifiedAt = null; // и сообщение о возврате должно уйти снова
      }
      const [updated] = await tx.update(task).set(patch).where(eq(task.id, id)).returning();

      if (quality === "redo") {
        await tx.insert(taskComment).values({
          taskId: id,
          authorRef: actorRef,
          body: `Возвращено на доработку. Прошлый отчёт: ${row.resultNote ?? "—"}`,
        });
      }

      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: quality === "redo" ? "task.redo" : "task.rated",
        target: id,
        before: row,
        after: updated,
      });
      return updated;
    });
  }

  /** Кому ещё не сообщили о возврате на доработку — бот заберёт и доставит. */
  redoUnnotified(): Promise<TaskRow[]> {
    return this.db
      .select()
      .from(task)
      .where(
        and(
          eq(task.quality, "redo"),
          ne(task.status, "done"),
          ne(task.status, "cancelled"),
          isNull(task.redoNotifiedAt),
          eq(task.ownerKind, "human"),
          isNotNull(task.ownerRef),
        ),
      )
      .limit(50);
  }

  /** Отметка ставится ПОСЛЕ доставки — как у напоминаний: сбой сети не должен
   *  превращаться в «сотрудник так и не узнал». */
  async markRedoNotified(id: string): Promise<void> {
    await this.db.update(task).set({ redoNotifiedAt: new Date() }).where(eq(task.id, id));
  }

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
        excellent: sql<number>`count(*) filter (where ${task.quality} = 'excellent')`.as("excellent"),
        redo: sql<number>`count(*) filter (where ${task.quality} = 'redo')`.as("redo"),
        doneOnTime:
          sql<number>`count(*) filter (where ${task.status} = 'done' and ${task.due} is not null and ${task.completedAt} <= ${task.due})`.as(
            "done_on_time",
          ),
        doneWithDue:
          sql<number>`count(*) filter (where ${task.status} = 'done' and ${task.due} is not null)`.as(
            "done_with_due",
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
      excellent: Number(r.excellent ?? 0),
      redo: Number(r.redo ?? 0),
      doneOnTime: Number(r.doneOnTime ?? 0),
      doneWithDue: Number(r.doneWithDue ?? 0),
    }));
  }
}
