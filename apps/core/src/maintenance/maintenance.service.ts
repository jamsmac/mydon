import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  auditLog,
  coffeeLocation,
  collection,
  entity,
  machinePart,
  maintenanceLog,
  maintenancePlan,
} from "@mydon/db";
import {
  advanceAnchor,
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
  | "other";

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
  async createLog(input: CreateLogInput): Promise<LogRow> {
    return this.db.transaction(async (tx) => {
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
          createdBy: input.createdBy ?? "owner",
        })
        .returning();

      await tx.insert(auditLog).values({
        actorKind: input.personId ? "human" : "system",
        actorRef: input.createdBy ?? "owner",
        action: "maintenance.log_created",
        target: row.id,
        after: row,
      });
      return row;
    });
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

      // Замыкание цикла: сделал → срок сдвинулся. Без этого график остаётся
      // стоять там же, где стоял, и назавтра снова требует ту же работу.
      if (after.planId && after.outcome === "done") {
        const [plan] = await tx
          .select()
          .from(maintenancePlan)
          .where(eq(maintenancePlan.id, after.planId))
          .limit(1);
        if (plan?.dueOn) {
          await tx
            .update(maintenancePlan)
            .set({
              dueOn: advanceAnchor(plan.dueOn, after.performedOn, plan),
              updatedAt: new Date(),
            })
            .where(eq(maintenancePlan.id, plan.id));
        }
      }

      await tx.insert(auditLog).values({
        actorKind: "human",
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

  /** Нормативы объекта или все активные. */
  plans(entityId?: string): Promise<PlanRow[]> {
    const conditions: SQL[] = [eq(maintenancePlan.isActive, true)];
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
            updatedAt: new Date(),
          })
          .where(eq(maintenancePlan.id, input.id))
          .returning();
        await tx.insert(auditLog).values({
          actorKind: "human",
          actorRef,
          action: "maintenance.plan_updated",
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
        actorKind: "human",
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
   * Кофейные нормативы (мойка миксера, фильтр воды) идут только на автоматы,
   * привязанные к кофейной точке. Различает это Core, а не вызывающий: связь
   * лежит в `coffee_location.entity_id`, и заставлять каждого клиента её
   * вычислять значит завести второе место правды, которое однажды разойдётся
   * с первым.
   */
  async applyStandardNorms(
    entityIds: string[],
    actorRef = "owner",
  ): Promise<{ created: PlanRow[]; skipped: number; coffee: number; other: number }> {
    if (entityIds.length === 0) return { created: [], skipped: 0, coffee: 0, other: 0 };
    const today = todayInTz();

    return this.db.transaction(async (tx) => {
      const linked = await tx
        .select({ entityId: coffeeLocation.entityId })
        .from(coffeeLocation)
        .where(inArray(coffeeLocation.entityId, entityIds));
      const isCoffee = new Set(linked.map((r) => r.entityId).filter((id): id is string => !!id));

      const existing = await tx
        .select({
          entityId: maintenancePlan.entityId,
          kind: maintenancePlan.kind,
          partKind: maintenancePlan.partKind,
        })
        .from(maintenancePlan)
        .where(
          and(eq(maintenancePlan.isActive, true), inArray(maintenancePlan.entityId, entityIds)),
        );
      const taken = new Set(existing.map((p) => normKey(p.entityId, p.kind, p.partKind)));

      const created: PlanRow[] = [];
      let skipped = 0;
      const seen = new Set<string>();
      for (const entityId of entityIds) {
        seen.add(entityId);
        for (const norm of normsFor(isCoffee.has(entityId))) {
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
            actorKind: "human",
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
      const coffee = [...seen].filter((id) => isCoffee.has(id)).length;
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
        actorKind: "human",
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
        actorKind: "human",
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
          createdBy: input.createdBy ?? "owner",
        })
        .returning();

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
