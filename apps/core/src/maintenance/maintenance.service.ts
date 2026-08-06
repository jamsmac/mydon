import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { auditLog, collection, entity, machinePart, maintenanceLog } from "@mydon/db";
import { TZ } from "@mydon/shared";
import { and, desc, eq, gte, isNull, lte, sql, type SQL } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";

type LogRow = typeof maintenanceLog.$inferSelect;
type PartRow = typeof machinePart.$inferSelect;

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
