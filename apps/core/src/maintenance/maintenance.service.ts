import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  auditLog,
  collection,
  entity,
  machineCard,
  machinePart,
  maintenanceLog,
  maintenancePlan,
} from "@mydon/db";
import {
  actorKindOf,
  advanceAnchor,
  machineIdleReason,
  machineIsOperational,
  computeDue,
  firstDue,
  maintenanceKindLabel,
  normKey,
  normsFor,
  partLabel,
  TZ,
  type DueStatus,
} from "@mydon/shared";
import { and, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";

/** Транзакция Drizzle — та же, что даёт `db.transaction(async (tx) => …)`. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

type LogRow = typeof maintenanceLog.$inferSelect;
type PartRow = typeof machinePart.$inferSelect;
type PlanRow = typeof maintenancePlan.$inferSelect;

export type MaintenanceKind =
  | "cleaning"
  | "sanitation"
  | "service"
  | "part_replace"
  | "inspection"
  | "calibration"
  | "repair"
  | "other"
  | "part_install"
  | "part_remove";

export type MaintenanceOutcome = "done" | "partial" | "failed";
export type PartSwapReason = "failure" | "preventive" | "upgrade" | "warranty" | "moved";

export interface CreateLogInput {
  entityId: string;
  kind: MaintenanceKind;
  partKind?: string;
  planId?: string;
  personId?: string;
  taskId?: string;
  /** Календарный день по Ташкенту. Не задан — сегодня. */
  performedOn?: string;
  outcome?: MaintenanceOutcome;
  note?: string;
  counterValue?: number;
  /** Ключ идемпотентности от клиента: ретрай не даёт вторую запись. */
  clientKey?: string;
  createdBy?: string;
}

export type PartOffLocation = "warehouse" | "washing" | "drying" | "repair";

export interface InstallPartInput {
  machineId: string;
  partKind: string;
  slot?: number;
  /** Открытый период «узел вне автомата» — если ставим существующий экземпляр. */
  partId?: string;
  serialNumber?: string;
  model?: string;
  warrantyUntil?: string;
  reason?: PartSwapReason;
  personId?: string;
  taskId?: string;
  note?: string;
  performedOn?: string;
  clientKey?: string;
  createdBy?: string;
}

export interface RemovePartInput {
  machineId: string;
  partKind: string;
  slot?: number;
  /** Куда узел уехал: склад, мойка, сушка или ремонт. */
  toLocation: PartOffLocation;
  /** Серийник, переписанный при снятии, — дописывается, если был пуст. */
  serial?: string;
  personId?: string;
  taskId?: string;
  note?: string;
  performedOn?: string;
  clientKey?: string;
  createdBy?: string;
}

export interface SwapPartInput {
  machineId: string;
  partKind: string;
  slot?: number;
  oldSerial?: string;
  newSerial?: string;
  model?: string;
  reason?: PartSwapReason;
  personId?: string;
  taskId?: string;
  note?: string;
  warrantyUntil?: string;
  performedOn?: string;
  /** Ключ идемпотентности от клиента: ретрай не даёт вторую замену. */
  clientKey?: string;
  createdBy?: string;
}

/**
 * Окно, в течение которого сотрудник может удалить свою запись сам.
 *
 * Час — потому что ошибку замечают на той же точке или на следующей. Дальше
 * запись становится историей: по ней уже посчитаны сроки следующих работ, и
 * тихое исчезновение строки сдвинуло бы график задним числом.
 */
const SELF_DELETE_WINDOW_MS = 60 * 60_000;

/** Строка сводки сроков — то, что видят монитор, бот и панель. */
export interface MaintenanceDueRow {
  planId: string;
  targetId: string;
  targetName: string;
  kind: string;
  kindLabel: string;
  partKind: string | null;
  partLabel: string | null;
  title: string | null;
  nextDueOn: string | null;
  lastDoneOn: string | null;
  taskLeadDays: number;
  daysLeft: number | null;
  countLeft: number | null;
  status: DueStatus;
  assigneeId: string | null;
  autoTask: boolean;
  /** Состояние автомата: in_service | warehouse | repair. Не автомат — null. */
  machineStatus: string | null;
  /**
   * Работы по объекту имеют смысл.
   *
   * Строка НЕ исчезает из сводки, когда автомат в ремонте: норматив всё равно
   * подходит к сроку, и владелец должен это видеть — иначе автомат вернётся
   * из мастерской с невидимым долгом. Исчезает только ЗАДАЧА: ставить её
   * некому и не на чем.
   */
  operational: boolean;
  /** Почему работа не назначается. `null` — назначается. */
  idleReason: string | null;
}

/**
 * Пересчёт срока при правке периодичности.
 *
 * Если периодичность не менялась, срок остаётся. Изменилась — считаем от
 * последней плановой даты новым шагом, а при её отсутствии от сегодня.
 */
function recalcDue(
  before: { dueOn: string | null; everyDays: number | null; everyMonths: number | null },
  next: { everyDays: number | null; everyMonths: number | null },
): string | null {
  const same = before.everyDays === next.everyDays && before.everyMonths === next.everyMonths;
  if (same) return before.dueOn;
  return firstDue(before.dueOn ?? todayInTz(), next);
}

/** Сегодняшний календарный день по Ташкенту (YYYY-MM-DD). */
export function todayInTz(now = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: TZ });
}

/**
 * Журнал обслуживания и узлы автоматов.
 *
 * Здесь только ФАКТ и СОСТОЯНИЕ. Норматив («как часто положено») — отдельная
 * таблица, и статус «пора / просрочено» не хранится: он зависит от now() и
 * считается на чтении.
 */
@Injectable()
export class MaintenanceService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Записать факт работы.
   *
   * `outcome` можно не указывать — тогда работа считается начатой и не
   * закрытой. Это не дефект ввода, а реальный случай: техник отметился на
   * точке, а закончил через час.
   */
  async createLog(input: CreateLogInput, outerTx?: Tx): Promise<LogRow> {
    // Внешняя транзакция — для вызовов из чужого модуля (закрытие задачи ТО):
    // факт работы и статус задачи должны закоммититься или откатиться вместе.
    const run = async (tx: Tx): Promise<LogRow> => {
      const [row] = await tx
        .insert(maintenanceLog)
        .values({
          entityId: input.entityId,
          kind: input.kind,
          partKind: (input.partKind ?? null) as LogRow["partKind"],
          planId: input.planId ?? null,
          personId: input.personId ?? null,
          taskId: input.taskId ?? null,
          performedOn: input.performedOn ?? todayInTz(),
          outcome: input.outcome ?? null,
          note: input.note ?? null,
          counterValue: input.counterValue ?? null,
          clientKey: input.clientKey ?? null,
          createdBy: input.createdBy ?? "owner",
        })
        .onConflictDoNothing({ target: maintenanceLog.clientKey })
        .returning();

      // Повтор по clientKey: та же кнопка нажата второй раз после таймаута.
      // Возвращаем прежнюю запись; якорь и аудит уже отработали в первый раз.
      if (!row) {
        const [existing] = await tx
          .select()
          .from(maintenanceLog)
          .where(eq(maintenanceLog.clientKey, input.clientKey!))
          .limit(1);
        if (!existing) {
          throw new BadRequestException("Повтор записи ещё сохраняется — нажми ещё раз через минуту");
        }
        return existing;
      }

      // Факт может прийти сразу закрытым — так делает бот в «🗓 Графики».
      // Тогда срок обязан сдвинуться здесь же, иначе сообщение сотруднику
      // «Следующий срок пересчитан» окажется ложью.
      await this.advanceAnchorFor(tx, row);

      await tx.insert(auditLog).values({
        actorKind: input.personId ? "human" : "system",
        actorRef: input.createdBy ?? "owner",
        action: "maintenance.log_created",
        target: row.id,
        after: row,
      });
      return row;
    };
    return outerTx ? run(outerTx) : this.db.transaction(run);
  }

  /**
   * Замыкание цикла: сделал → срок сдвинулся.
   *
   * Вынесено из `closeLog` и вызывается ОБОИМИ путями записи факта. Раньше
   * якорь двигал только `closeLog`, а бот в «🗓 Графики» закрывает работу
   * через `createLog` (сразу с `outcome: "done"`) и писал сотруднику
   * «Следующий срок пересчитан» — чего не происходило. График оставался
   * стоять, где стоял, и назавтра требовал ту же работу, накапливая по дню
   * просрочки в сутки. Найдено разбором до первого факта: на 07.08.2026 в
   * журнале ноль записей, то есть парк ещё не пострадал.
   */
  private async advanceAnchorFor(
    tx: Tx,
    log: { planId: string | null; outcome: string | null; performedOn: string },
  ): Promise<void> {
    if (!log.planId || log.outcome !== "done") return;
    const [plan] = await tx
      .select()
      .from(maintenancePlan)
      .where(eq(maintenancePlan.id, log.planId))
      .limit(1);
    if (!plan?.dueOn) return;
    await tx
      .update(maintenancePlan)
      .set({ dueOn: advanceAnchor(plan.dueOn, log.performedOn, plan), updatedAt: new Date() })
      .where(eq(maintenancePlan.id, plan.id));
  }

  /** Закрыть начатую работу: результат, заметка, показания счётчика. */
  async closeLog(
    id: string,
    patch: { outcome: MaintenanceOutcome; note?: string; counterValue?: number },
    actorRef = "owner",
  ): Promise<LogRow> {
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(maintenanceLog).where(eq(maintenanceLog.id, id)).limit(1);
      if (!before) throw new NotFoundException("Записи обслуживания нет");

      const [after] = await tx
        .update(maintenanceLog)
        .set({
          outcome: patch.outcome,
          ...(patch.note !== undefined ? { note: patch.note } : {}),
          ...(patch.counterValue !== undefined ? { counterValue: patch.counterValue } : {}),
          updatedAt: new Date(),
        })
        .where(eq(maintenanceLog.id, id))
        .returning();

      await this.advanceAnchorFor(tx, after);

      await tx.insert(auditLog).values({
        actorKind: actorKindOf(actorRef),
        actorRef,
        action: "maintenance.log_closed",
        target: id,
        before,
        after,
      });
      return after;
    });
  }

  // ── Нормативы: как часто положено ──────────────────────────────────────────

  /**
   * Нормативы объекта или все активные.
   *
   * `includeInactive` нужен тем, кто решает «чего не хватает»: снятый с паузы
   * норматив существует, просто молчит, и считать его отсутствующим значит
   * заводить дубль на каждом прогоне. Панели и монитору наоборот нужны только
   * активные — потому умолчание прежнее.
   */
  plans(entityId?: string, includeInactive = false): Promise<PlanRow[]> {
    const conditions: SQL[] = [];
    if (!includeInactive) conditions.push(eq(maintenancePlan.isActive, true));
    if (entityId) conditions.push(eq(maintenancePlan.entityId, entityId));
    return this.db
      .select()
      .from(maintenancePlan)
      .where(and(...conditions))
      .orderBy(maintenancePlan.dueOn)
      .limit(500);
  }

  /**
   * Завести или поправить норматив.
   *
   * Первый срок считается от сегодня, а не от последней работы: норматив
   * заводят, когда решили следить, и требовать работу задним числом за
   * период, за который никто не отвечал, значит начать с красного экрана.
   */
  async upsertPlan(
    input: {
      id?: string;
      entityId: string;
      kind: MaintenanceKind;
      partKind?: string;
      title?: string;
      everyDays?: number;
      everyMonths?: number;
      everyCount?: number;
      counterLabel?: string;
      dueOn?: string;
      taskLeadDays?: number;
      autoTask?: boolean;
      assigneeId?: string;
      note?: string;
      /**
       * Норматив в строю. Выключить можно было и раньше (`DELETE /plans/:id`
       * не удаляет, а гасит), а включить обратно — нечем: автомат, вернувшийся
       * из ремонта, оставался без графика навсегда. Пропуск поля ничего не
       * меняет — паузу снимает только явное `true`.
       */
      isActive?: boolean;
    },
    actorRef = "owner",
  ): Promise<PlanRow> {
    const period = {
      everyDays: input.everyDays ?? null,
      everyMonths: input.everyMonths ?? null,
      everyCount: input.everyCount ?? null,
    };
    return this.db.transaction(async (tx) => {
      if (input.id) {
        const [before] = await tx
          .select()
          .from(maintenancePlan)
          .where(eq(maintenancePlan.id, input.id))
          .limit(1);
        if (!before) throw new NotFoundException("Норматива нет");
        const [after] = await tx
          .update(maintenancePlan)
          .set({
            kind: input.kind,
            partKind: (input.partKind ?? null) as PlanRow["partKind"],
            title: input.title ?? null,
            ...period,
            counterLabel: input.counterLabel ?? null,
            // Правка периодичности пересчитывает срок тем же UPDATE: иначе
            // норматив сказал бы «раз в неделю», а ждал бы месяц.
            dueOn: input.dueOn ?? recalcDue(before, period),
            taskLeadDays: input.taskLeadDays ?? before.taskLeadDays,
            autoTask: input.autoTask ?? before.autoTask,
            assigneeId: input.assigneeId ?? null,
            note: input.note ?? null,
            isActive: input.isActive ?? before.isActive,
            // Норматив, вернувшийся из паузы, не должен прийти сразу
            // просроченным: пока автомат стоял в ремонте, срок капал впустую.
            // Считаем следующий срок от сегодня — так же, как при заведении.
            ...(input.isActive === true && before.isActive === false && input.dueOn === undefined
              ? { dueOn: firstDue(todayInTz(), period) }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(maintenancePlan.id, input.id))
          .returning();
        await tx.insert(auditLog).values({
          actorKind: actorKindOf(actorRef),
          actorRef,
          action:
            input.isActive === true && before.isActive === false
              ? "maintenance.plan_resumed"
              : "maintenance.plan_updated",
          target: input.id,
          before,
          after,
        });
        return after;
      }

      const today = todayInTz();
      const [created] = await tx
        .insert(maintenancePlan)
        .values({
          entityId: input.entityId,
          kind: input.kind,
          partKind: (input.partKind ?? null) as PlanRow["partKind"],
          title: input.title ?? null,
          ...period,
          counterLabel: input.counterLabel ?? null,
          dueOn: input.dueOn ?? firstDue(today, period),
          taskLeadDays: input.taskLeadDays ?? 3,
          autoTask: input.autoTask ?? true,
          assigneeId: input.assigneeId ?? null,
          note: input.note ?? null,
          createdBy: actorRef,
        })
        .returning();
      await tx.insert(auditLog).values({
        actorKind: actorKindOf(actorRef),
        actorRef,
        action: "maintenance.plan_created",
        target: created.id,
        after: created,
      });
      return created;
    });
  }

  /**
   * Завести стандартные нормативы (10 / 45 / 90) на список объектов.
   *
   * Ради этого метода график вообще заводится: заводить три плана на каждый
   * автомат руками — сорок автоматов × три формы, и парк растёт. Здесь же —
   * один вызов на весь парк.
   *
   * ИДЕМПОТЕНТНО. Повторный прогон ничего не создаёт и ничего не трогает:
   * уже заведённый план мог быть поправлен владельцем («этот моем реже»), и
   * молча вернуть его к норме значит стереть решение. Поэтому существующие
   * только считаются в `skipped`, а не обновляются.
   *
   * Выключенный план (`is_active = false`) считается отсутствующим и будет
   * заведён заново. Это осознанно: уникальный индекс тоже частичный
   * (`where is_active`), и выключение — это «мы за этим больше не следим», а
   * повторный вызов метода — прямое «следим снова».
   *
   * Кофейные нормативы (мойка миксера, фильтр воды) идут только автоматам
   * вида `coffee` — по карточке `machine_card`, а не по привязке к кофейной
   * точке. Привязка была косвенным признаком: три автомата с кофейными
   * серийниками её не имели и получали бы неполный комплект не потому, что
   * они не кофейные, а потому что связь никто не завёл.
   *
   * Автомат без карточки считается неразмеченным и получает только общие
   * нормативы. Это консервативно намеренно: пустой график чинится одной
   * командой после разметки, красный — потерянным доверием к разделу.
   */
  async applyStandardNorms(
    entityIds: string[],
    actorRef = "owner",
  ): Promise<{ created: PlanRow[]; skipped: number; coffee: number; other: number }> {
    if (entityIds.length === 0) return { created: [], skipped: 0, coffee: 0, other: 0 };
    const today = todayInTz();

    return this.db.transaction(async (tx) => {
      const cards = await tx
        .select({ entityId: machineCard.entityId, kind: machineCard.kind })
        .from(machineCard)
        .where(inArray(machineCard.entityId, entityIds));
      const kindOf = new Map(cards.map((c) => [c.entityId, c.kind]));

      // ВСЕ нормативы объекта, включая снятые с паузы «выключенные».
      //
      // Раньше здесь стоял фильтр `isActive = true`, и выключенный норматив
      // становился невидимым: массовое заведение считало его отсутствующим и
      // заводило заново. Пауза не держалась дольше одного прогона — автомат в
      // ремонте снова начинал требовать работу. Возврат норматива в строй —
      // отдельное осознанное действие (`upsertPlan` с `isActive: true`), а не
      // побочный эффект уборки.
      const existing = await tx
        .select({
          entityId: maintenancePlan.entityId,
          kind: maintenancePlan.kind,
          partKind: maintenancePlan.partKind,
        })
        .from(maintenancePlan)
        .where(inArray(maintenancePlan.entityId, entityIds));
      const taken = new Set(existing.map((p) => normKey(p.entityId, p.kind, p.partKind)));

      const created: PlanRow[] = [];
      let skipped = 0;
      const seen = new Set<string>();
      for (const entityId of entityIds) {
        seen.add(entityId);
        for (const norm of normsFor(kindOf.get(entityId))) {
          if (taken.has(normKey(entityId, norm.kind, norm.partKind))) {
            skipped += 1;
            continue;
          }
          const period = { everyDays: norm.everyDays, everyMonths: null, everyCount: null };
          const [row] = await tx
            .insert(maintenancePlan)
            .values({
              entityId,
              kind: norm.kind,
              partKind: norm.partKind,
              title: norm.title,
              ...period,
              // Первый срок — от сегодня, а не от «когда-то делали». Иначе при
              // запуске весь парк встанет красным, и в график перестанут
              // смотреть на второй день (FIELD_OPS_SPEC §7.1).
              dueOn: firstDue(today, period),
              createdBy: actorRef,
            })
            .returning();
          await tx.insert(auditLog).values({
            actorKind: actorKindOf(actorRef),
            actorRef,
            action: "maintenance.plan_created",
            target: row.id,
            after: row,
          });
          created.push(row);
          // Тот же прогон не должен завести дубль, если объект пришёл в
          // списке дважды: вызывающий не обязан за этим следить.
          taken.add(normKey(entityId, norm.kind, norm.partKind));
        }
      }
      const coffee = [...seen].filter((id) => kindOf.get(id) === "coffee").length;
      return { created, skipped, coffee, other: seen.size - coffee };
    });
  }

  /**
   * Выключить норматив, а не удалить.
   *
   * Исключение для отдельного автомата («этот моем реже») выражается именно
   * выключением: удалённый норматив унёс бы с собой историю, по которой видно,
   * что раньше следили.
   */
  async deactivatePlan(id: string, actorRef = "owner"): Promise<PlanRow> {
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(maintenancePlan).where(eq(maintenancePlan.id, id)).limit(1);
      if (!before) throw new NotFoundException("Норматива нет");
      const [after] = await tx
        .update(maintenancePlan)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(maintenancePlan.id, id))
        .returning();
      await tx.insert(auditLog).values({
        actorKind: actorKindOf(actorRef),
        actorRef,
        action: "maintenance.plan_deactivated",
        target: id,
        before,
        after,
      });
      return after;
    });
  }

  /**
   * Что подходит к сроку — read-model для монитора, бота и панели.
   *
   * Без N+1: три выборки на любое число нормативов. Тот же дефект есть
   * в washScheduleStatus(), который тянет весь журнал в память, — этот приём
   * не копируем.
   */
  async dueList(today = todayInTz()): Promise<MaintenanceDueRow[]> {
    const plans = await this.plans();
    if (plans.length === 0) return [];

    const targetIds = [...new Set(plans.map((p) => p.entityId))];
    const names = new Map(
      (await this.db
        .select({ id: entity.id, name: entity.name })
        .from(entity)
        .where(inArray(entity.id, targetIds))
      ).map((r) => [r.id, r.name]),
    );

    // Состояние автомата — оно решает, ставить ли задачу. Объекты без карточки
    // автомата (техника, помещения) состояния не имеют и считаются рабочими:
    // признак заводился для парка, а не для всего реестра.
    const statuses = new Map(
      (await this.db
        .select({ entityId: machineCard.entityId, status: machineCard.status })
        .from(machineCard)
        .where(inArray(machineCard.entityId, targetIds))
      ).map((r) => [r.entityId, r.status as string]),
    );

    // Последний закрытый факт по каждому нормативу — одним запросом.
    const lastDone = new Map(
      (await this.db
        .select({
          planId: maintenanceLog.planId,
          performedOn: sql<string>`max(${maintenanceLog.performedOn})`,
        })
        .from(maintenanceLog)
        .where(
          and(
            inArray(maintenanceLog.planId, plans.map((p) => p.id)),
            sql`${maintenanceLog.outcome} is not null`,
          ),
        )
        .groupBy(maintenanceLog.planId)
      ).map((r) => [r.planId, r.performedOn]),
    );

    return plans.map((p) => {
      const due = computeDue(
        {
          everyDays: p.everyDays,
          everyMonths: p.everyMonths,
          everyCount: p.everyCount,
          dueOn: p.dueOn,
          lastDoneOn: lastDone.get(p.id) ?? null,
          taskLeadDays: p.taskLeadDays,
        },
        today,
      );
      return {
        planId: p.id,
        targetId: p.entityId,
        targetName: names.get(p.entityId) ?? "объект",
        kind: p.kind,
        kindLabel: maintenanceKindLabel(p.kind),
        partKind: p.partKind,
        partLabel: p.partKind ? partLabel(p.partKind) : null,
        title: p.title,
        nextDueOn: due.nextDueOn,
        lastDoneOn: lastDone.get(p.id) ?? null,
        taskLeadDays: p.taskLeadDays,
        daysLeft: due.daysLeft,
        countLeft: due.countLeft,
        status: due.status,
        assigneeId: p.assigneeId,
        autoTask: p.autoTask,
        machineStatus: statuses.get(p.entityId) ?? null,
        operational: machineIsOperational(statuses.get(p.entityId)),
        idleReason: machineIdleReason(statuses.get(p.entityId)),
      };
    });
  }

  /**
   * Удалить свою запись — «ошибся, внесу заново».
   *
   * Три ограничения, и каждое закрывает свой способ испортить историю:
   * только автор, только в течение часа, и только если на записи не висит
   * узел (иначе удаление осиротило бы период жизни детали).
   */
  async removeLog(id: string, personId: string, actorRef: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(maintenanceLog).where(eq(maintenanceLog.id, id)).limit(1);
      if (!row) throw new NotFoundException("Записи обслуживания нет");
      if (row.personId !== personId) throw new ForbiddenException("Это не твоя запись");

      const ageMs = Date.now() - row.createdAt.getTime();
      if (ageMs > SELF_DELETE_WINDOW_MS) {
        throw new BadRequestException(
          "Запись старше часа — по ней уже посчитаны сроки. Скажи владельцу, он поправит.",
        );
      }

      const linked = await tx
        .select({ id: machinePart.id })
        .from(machinePart)
        .where(sql`${machinePart.installLogId} = ${id} or ${machinePart.removeLogId} = ${id}`)
        .limit(1);
      if (linked.length > 0) {
        throw new BadRequestException("На этой записи держится замена узла — удалить нельзя.");
      }

      await tx.delete(maintenanceLog).where(eq(maintenanceLog.id, id));
      await tx.insert(auditLog).values({
        actorKind: actorKindOf(actorRef),
        actorRef,
        action: "maintenance.log_removed",
        target: id,
        before: row,
      });
    });
  }

  /** Лента работ с фильтрами — для панели владельца. */
  list(filter: { entityId?: string; personId?: string; from?: string; to?: string } = {}): Promise<LogRow[]> {
    const conditions: SQL[] = [];
    if (filter.entityId) conditions.push(eq(maintenanceLog.entityId, filter.entityId));
    if (filter.personId) conditions.push(eq(maintenanceLog.personId, filter.personId));
    if (filter.from) conditions.push(gte(maintenanceLog.performedOn, filter.from));
    if (filter.to) conditions.push(lte(maintenanceLog.performedOn, filter.to));

    return this.db
      .select()
      .from(maintenanceLog)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(maintenanceLog.performedOn), desc(maintenanceLog.performedAt))
      .limit(300);
  }

  /** Узлы автомата: сначала стоящие сейчас, затем история. */
  parts(machineId: string): Promise<PartRow[]> {
    return this.db
      .select()
      .from(machinePart)
      .where(eq(machinePart.machineId, machineId))
      .orderBy(machinePart.removedOn, desc(machinePart.installedOn))
      .limit(200);
  }

  /**
   * Замена узла: закрыть старый период и открыть новый — одной транзакцией.
   *
   * Половина операции хуже, чем ни одной: снятый, но не поставленный узел
   * означает автомат без купюроприёмника в реестре, а поставленный без
   * снятого — два «текущих» узла на одном месте. Второе не пропустит
   * частичный уникальный индекс, первое — только транзакция.
   */
  async swapPart(input: SwapPartInput): Promise<{ log: LogRow; removed: PartRow | null; installed: PartRow }> {
    const performedOn = input.performedOn ?? todayInTz();
    const slot = input.slot ?? null;

    return this.db.transaction(async (tx) => {
      const [log] = await tx
        .insert(maintenanceLog)
        .values({
          entityId: input.machineId,
          kind: "part_replace",
          partKind: input.partKind as LogRow["partKind"],
          personId: input.personId ?? null,
          taskId: input.taskId ?? null,
          performedOn,
          outcome: "done",
          note: input.note ?? null,
          clientKey: input.clientKey ?? null,
          createdBy: input.createdBy ?? "owner",
        })
        .onConflictDoNothing({ target: maintenanceLog.clientKey })
        .returning();

      // Повтор по clientKey: замена уже записана первой попыткой. Собираем
      // тот же ответ из существующих строк — узлы не трогаем, иначе ретрай
      // «снимал» бы только что поставленную деталь как прежнюю.
      if (!log) {
        const [existing] = await tx
          .select()
          .from(maintenanceLog)
          .where(eq(maintenanceLog.clientKey, input.clientKey!))
          .limit(1);
        const [installedBefore] = existing
          ? await tx.select().from(machinePart).where(eq(machinePart.installLogId, existing.id)).limit(1)
          : [];
        // Конфликт по ключу без видимой записи — гонка с ещё не закоммиченной
        // первой попыткой. Честная ошибка лучше «замены наполовину»: клиент
        // повторит то же нажатие, и повтор попадёт в готовый replay.
        if (!existing || !installedBefore) {
          throw new BadRequestException("Повтор замены ещё записывается — нажми ещё раз через минуту");
        }
        const [removedBefore] = await tx
          .select()
          .from(machinePart)
          .where(eq(machinePart.removeLogId, existing.id))
          .limit(1);
        return { log: existing, removed: removedBefore ?? null, installed: installedBefore };
      }

      // Что стояло на этом месте до сих пор.
      const [open] = await tx
        .select()
        .from(machinePart)
        .where(
          and(
            eq(machinePart.machineId, input.machineId),
            eq(machinePart.partKind, input.partKind as PartRow["partKind"]),
            slot === null ? isNull(machinePart.slot) : eq(machinePart.slot, slot),
            isNull(machinePart.removedOn),
          ),
        )
        .limit(1);

      let removed: PartRow | null = null;
      if (open) {
        [removed] = await tx
          .update(machinePart)
          .set({
            removedOn: performedOn,
            removeLogId: log.id,
            // Серийник старого узла мог быть неизвестен при установке, но
            // техник переписал его сейчас, снимая деталь. Дописываем, а не
            // затираем: пустое значение — не то же самое, что «другое».
            ...(input.oldSerial && !open.serialNumber ? { serialNumber: input.oldSerial } : {}),
          })
          .where(eq(machinePart.id, open.id))
          .returning();
      }

      const [installed] = await tx
        .insert(machinePart)
        .values({
          machineId: input.machineId,
          partKind: input.partKind as PartRow["partKind"],
          slot,
          serialNumber: input.newSerial ?? null,
          model: input.model ?? null,
          installedOn: performedOn,
          installLogId: log.id,
          warrantyUntil: input.warrantyUntil ?? null,
          reason: input.reason ?? null,
          note: input.note ?? null,
          createdBy: input.createdBy ?? "owner",
        })
        .returning();

      await tx.insert(auditLog).values({
        actorKind: input.personId ? "human" : "system",
        actorRef: input.createdBy ?? "owner",
        action: "maintenance.part_swapped",
        target: installed.id,
        before: removed,
        after: installed,
      });

      return { log, removed, installed };
    });
  }

  /** Узлы вне автоматов: что лежит на складе, мойке, сушке, в ремонте. */
  storageParts(): Promise<PartRow[]> {
    return this.db
      .select()
      .from(machinePart)
      .where(and(isNull(machinePart.machineId), isNull(machinePart.removedOn)))
      .orderBy(machinePart.partKind, desc(machinePart.installedOn))
      .limit(200);
  }

  /**
   * История экземпляров по серийнику и/или модели: все периоды — автоматы,
   * мойки, ремонты.
   *
   * Серийник — нить одного физического узла: id строки живёт один период, а
   * деталь — годы. Модель — нить номенклатуры: карточка запчасти видит все
   * экземпляры своей модели, даже когда серийники не переписаны.
   */
  async partHistory(
    serial?: string,
    model?: string,
  ): Promise<(PartRow & { machineName: string | null })[]> {
    const conditions: SQL[] = [];
    if (serial) conditions.push(eq(machinePart.serialNumber, serial));
    if (model) conditions.push(eq(machinePart.model, model));
    if (conditions.length === 0) return [];

    const rows = await this.db
      .select()
      .from(machinePart)
      .where(conditions.length === 1 ? conditions[0] : sql`${conditions[0]} or ${conditions[1]}`)
      .orderBy(desc(machinePart.installedOn))
      .limit(100);

    const machineIds = [...new Set(rows.flatMap((r) => (r.machineId === null ? [] : [r.machineId])))];
    const names =
      machineIds.length > 0
        ? await this.db
            .select({ id: entity.id, name: entity.name })
            .from(entity)
            .where(inArray(entity.id, machineIds))
        : [];
    const nameById = new Map(names.map((n) => [n.id, n.name]));
    return rows.map((r) => ({
      ...r,
      machineName: r.machineId !== null ? (nameById.get(r.machineId) ?? null) : null,
    }));
  }

  /**
   * Установка узла: со склада (partId) или новый — открыть период на автомате.
   *
   * Занятое место — отказ, а не молчаливая замена: «поставить поверх» и
   * «заменить» — разные работы, и вторая фиксирует снятие прежнего узла.
   */
  async installPart(input: InstallPartInput): Promise<{ log: LogRow; installed: PartRow }> {
    const performedOn = input.performedOn ?? todayInTz();
    const slot = input.slot ?? null;

    return this.db.transaction(async (tx) => {
      const [log] = await tx
        .insert(maintenanceLog)
        .values({
          entityId: input.machineId,
          kind: "part_install",
          partKind: input.partKind as LogRow["partKind"],
          personId: input.personId ?? null,
          taskId: input.taskId ?? null,
          performedOn,
          outcome: "done",
          note: input.note ?? null,
          clientKey: input.clientKey ?? null,
          createdBy: input.createdBy ?? "owner",
        })
        .onConflictDoNothing({ target: maintenanceLog.clientKey })
        .returning();

      // Повтор по clientKey — установка уже записана, собираем прежний ответ.
      if (!log) {
        const [existing] = await tx
          .select()
          .from(maintenanceLog)
          .where(eq(maintenanceLog.clientKey, input.clientKey!))
          .limit(1);
        const [installedBefore] = existing
          ? await tx
              .select()
              .from(machinePart)
              .where(and(eq(machinePart.installLogId, existing.id), eq(machinePart.location, "machine")))
              .limit(1)
          : [];
        if (!existing || !installedBefore) {
          throw new BadRequestException("Повтор установки ещё записывается — нажми ещё раз через минуту");
        }
        return { log: existing, installed: installedBefore };
      }

      // Место должно быть свободно.
      const [occupied] = await tx
        .select({ id: machinePart.id })
        .from(machinePart)
        .where(
          and(
            eq(machinePart.machineId, input.machineId),
            eq(machinePart.partKind, input.partKind as PartRow["partKind"]),
            slot === null ? isNull(machinePart.slot) : eq(machinePart.slot, slot),
            isNull(machinePart.removedOn),
          ),
        )
        .limit(1);
      if (occupied) {
        throw new BadRequestException("Место занято — снимите узел или оформите замену");
      }

      // Экземпляр со склада: закрыть его «лежачий» период и перенести паспорт.
      let serialNumber = input.serialNumber ?? null;
      let model = input.model ?? null;
      let warrantyUntil = input.warrantyUntil ?? null;
      if (input.partId) {
        const [stored] = await tx
          .select()
          .from(machinePart)
          .where(eq(machinePart.id, input.partId))
          .limit(1);
        if (!stored) throw new NotFoundException("Такого узла на складе нет");
        if (stored.machineId !== null || stored.removedOn !== null) {
          throw new BadRequestException("Этот узел не лежит на складе — выбери из списка свободных");
        }
        if (stored.partKind !== input.partKind) {
          throw new BadRequestException("Узел другого вида — установка невозможна");
        }
        await tx
          .update(machinePart)
          .set({ removedOn: performedOn, removeLogId: log.id })
          .where(eq(machinePart.id, stored.id));
        serialNumber = stored.serialNumber ?? serialNumber;
        model = stored.model ?? model;
        warrantyUntil = stored.warrantyUntil ?? warrantyUntil;
      }

      const [installed] = await tx
        .insert(machinePart)
        .values({
          machineId: input.machineId,
          location: "machine",
          partKind: input.partKind as PartRow["partKind"],
          slot,
          serialNumber,
          model,
          installedOn: performedOn,
          installLogId: log.id,
          warrantyUntil,
          reason: input.reason ?? null,
          note: input.note ?? null,
          createdBy: input.createdBy ?? "owner",
        })
        .returning();

      await tx.insert(auditLog).values({
        actorKind: input.personId ? "human" : "system",
        actorRef: input.createdBy ?? "owner",
        action: "maintenance.part_installed",
        target: installed.id,
        after: installed,
      });

      return { log, installed };
    });
  }

  /**
   * Снятие узла: закрыть период на автомате и открыть период «вне автомата».
   *
   * Снятый узел не исчезает из учёта — он лежит на мойке или в ремонте и
   * вернётся. Терялся бы без второй строки: закрытый период — уже история.
   */
  async removePart(input: RemovePartInput): Promise<{ log: LogRow; removed: PartRow; stored: PartRow }> {
    const performedOn = input.performedOn ?? todayInTz();
    const slot = input.slot ?? null;

    return this.db.transaction(async (tx) => {
      const [log] = await tx
        .insert(maintenanceLog)
        .values({
          entityId: input.machineId,
          kind: "part_remove",
          partKind: input.partKind as LogRow["partKind"],
          personId: input.personId ?? null,
          taskId: input.taskId ?? null,
          performedOn,
          outcome: "done",
          note: input.note ?? null,
          clientKey: input.clientKey ?? null,
          createdBy: input.createdBy ?? "owner",
        })
        .onConflictDoNothing({ target: maintenanceLog.clientKey })
        .returning();

      // Повтор по clientKey — снятие уже записано, собираем прежний ответ.
      if (!log) {
        const [existing] = await tx
          .select()
          .from(maintenanceLog)
          .where(eq(maintenanceLog.clientKey, input.clientKey!))
          .limit(1);
        const [removedBefore] = existing
          ? await tx.select().from(machinePart).where(eq(machinePart.removeLogId, existing.id)).limit(1)
          : [];
        const [storedBefore] = existing
          ? await tx
              .select()
              .from(machinePart)
              .where(and(eq(machinePart.installLogId, existing.id), isNull(machinePart.machineId)))
              .limit(1)
          : [];
        if (!existing || !removedBefore || !storedBefore) {
          throw new BadRequestException("Повтор снятия ещё записывается — нажми ещё раз через минуту");
        }
        return { log: existing, removed: removedBefore, stored: storedBefore };
      }

      const [open] = await tx
        .select()
        .from(machinePart)
        .where(
          and(
            eq(machinePart.machineId, input.machineId),
            eq(machinePart.partKind, input.partKind as PartRow["partKind"]),
            slot === null ? isNull(machinePart.slot) : eq(machinePart.slot, slot),
            isNull(machinePart.removedOn),
          ),
        )
        .limit(1);
      if (!open) throw new NotFoundException("На этом месте узел не числится");

      const [removed] = await tx
        .update(machinePart)
        .set({
          removedOn: performedOn,
          removeLogId: log.id,
          // Как в swapPart: серийник дописываем, если был пуст, — не затираем.
          ...(input.serial && !open.serialNumber ? { serialNumber: input.serial } : {}),
        })
        .where(eq(machinePart.id, open.id))
        .returning();

      // Период «вне автомата» открывает та же запись журнала, что закрыла
      // период на автомате, — по installLogId/removeLogId история читается
      // в обе стороны без отдельной таблицы связей.
      const [stored] = await tx
        .insert(machinePart)
        .values({
          machineId: null,
          location: input.toLocation,
          partKind: removed.partKind,
          slot: null,
          serialNumber: removed.serialNumber,
          model: removed.model,
          installedOn: performedOn,
          installLogId: log.id,
          warrantyUntil: removed.warrantyUntil,
          note: input.note ?? null,
          createdBy: input.createdBy ?? "owner",
        })
        .returning();

      await tx.insert(auditLog).values({
        actorKind: input.personId ? "human" : "system",
        actorRef: input.createdBy ?? "owner",
        action: "maintenance.part_removed",
        target: removed.id,
        before: removed,
        after: stored,
      });

      return { log, removed, stored };
    });
  }

  /**
   * Объекты, на которых сотрудник работал недавно, — для пикера в боте.
   *
   * Закрепления за объектами нет: формально каждому доступен весь парк, и
   * список из полусотни автоматов на телефоне бесполезен. Но маршрут дня
   * повторяется, поэтому «недавние» закрывают большинство случаев. Берём из
   * двух источников: обслуживание и инкассация.
   */
  async recentObjects(personId: string, limit = 5): Promise<{ id: string; name: string }[]> {
    const rows = await this.db
      .select({ id: entity.id, name: entity.name, at: sql<string>`max(src.at)` })
      .from(
        sql`(
          select ${maintenanceLog.entityId} as entity_id, max(${maintenanceLog.performedAt}) as at
            from ${maintenanceLog} where ${maintenanceLog.personId} = ${personId}
           group by ${maintenanceLog.entityId}
          union all
          select ${collection.machineId} as entity_id, max(${collection.collectedAt}) as at
            from ${collection} where ${collection.operatorId} = ${personId}
           group by ${collection.machineId}
        ) as src`,
      )
      .innerJoin(entity, sql`${entity.id} = src.entity_id`)
      .groupBy(entity.id, entity.name)
      .orderBy(sql`max(src.at) desc`)
      .limit(limit);
    return rows.map((r) => ({ id: r.id, name: r.name }));
  }
}
