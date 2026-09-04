import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { attachment, auditLog, machinePart, maintenanceLog, partCountLine, partCountSession, partUnit, person } from "@mydon/db";
import { actorKindOf, isValidInventoryNo, normalizeInventoryNo, partLabel, type PartKind } from "@mydon/shared";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { settingValue } from "../system/settings";
import { todayInTz } from "./maintenance.service";
import { PartsService, partUnitLabel, type PartUnitView } from "./parts.service";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type SessionRow = typeof partCountSession.$inferSelect;
type LineRow = typeof partCountLine.$inferSelect;
type PeriodRow = typeof machinePart.$inferSelect;
export type CountLocation = "warehouse" | "washing" | "drying" | "repair";

export const COUNT_LOCATIONS: readonly CountLocation[] = ["warehouse", "washing", "drying", "repair"];

export interface StartCountInput {
  location: CountLocation;
  warehouseId?: string;
  personId?: string;
  note?: string;
  actorRef?: string;
}

export interface AddCountLineInput {
  partKind: PartKind;
  inventoryNo?: string;
  serialNumber?: string;
  setNumber?: number;
  hopperPosition?: number;
  photoSkippedReason?: string;
  clientKey?: string;
  actorRef?: string;
}

/** Строка сессии с подписью узла — для панели и бота. */
export interface CountLineView extends LineRow {
  label: string;
  unit: PartUnitView | null;
  photoCount: number;
  /** Узел числился не здесь на момент ввода (панель предупреждает до применения). */
  registeredAt: string | null;
}

export interface CountSummary {
  session: SessionRow;
  lines: CountLineView[];
  /** Узлы, которые по открытым периодам должны быть в этом месте. */
  expected: PartUnitView[];
  found: number;
  fresh: number;
  moved: number;
  /** До применения — разность «ожидалось − найдено»; после — строки с result=missing. */
  missing: PartUnitView[];
  photoRequired: boolean;
}

export interface ApplyReport {
  sessionId: string;
  found: number;
  created: string[];
  moved: string[];
  missing: string[];
}

/**
 * Инвентаризация узлов (R-PU-7, У4): сессия по месту, строки по одному узлу,
 * применение одной транзакцией с разностью «найдено / новые / не найдены».
 *
 * Сначала запись, потом фото: строка ложится в базу до снимка, чтобы обрыв
 * связи на складе не терял сам факт «узел видел». Ничего не удаляется:
 * не найденный узел не исчезает, а переводится в «местонахождение
 * неизвестно»; откат применения — обратной сессией.
 */
@Injectable()
export class PartCountService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly parts: PartsService,
  ) {}

  async photoRequired(): Promise<boolean> {
    return (await settingValue(this.db, "PARTS_COUNT_PHOTO_REQUIRED")).trim() !== "0";
  }

  /** Открытая сессия этого места — продолжаем её, а не плодим вторую. */
  private async openAt(tx: Tx | Db, location: CountLocation): Promise<SessionRow | null> {
    const [row] = await tx
      .select()
      .from(partCountSession)
      .where(and(eq(partCountSession.location, location), isNull(partCountSession.appliedAt), isNull(partCountSession.reversesId)))
      .orderBy(desc(partCountSession.startedAt))
      .limit(1);
    return row ?? null;
  }

  async start(input: StartCountInput): Promise<{ session: SessionRow; resumed: boolean; photoRequired: boolean; expected: number }> {
    if (!COUNT_LOCATIONS.includes(input.location)) throw new BadRequestException("Считать можно склад, мойку, сушку или ремонт");
    const photoRequired = await this.photoRequired();
    const existing = await this.openAt(this.db, input.location);
    const expected = (await this.parts.atLocation(input.location)).length;
    if (existing) return { session: existing, resumed: true, photoRequired, expected };
    const actorRef = input.actorRef ?? "owner";
    const [session] = await this.db
      .insert(partCountSession)
      .values({
        location: input.location,
        warehouseId: input.warehouseId ?? null,
        personId: input.personId ?? null,
        note: input.note ?? null,
        createdBy: actorRef,
      })
      .returning();
    await this.db.insert(auditLog).values({
      actorKind: actorKindOf(actorRef),
      actorRef,
      action: "parts.count_started",
      target: session.id,
      after: { location: input.location },
    });
    return { session, resumed: false, photoRequired, expected };
  }

  private async session(tx: Tx | Db, id: string): Promise<SessionRow & { location: CountLocation }> {
    const [row] = await tx.select().from(partCountSession).where(eq(partCountSession.id, id)).limit(1);
    if (!row) throw new NotFoundException("Сессии инвентаризации с таким id нет");
    // check-constraint схемы не пускает "machine"; типу об этом надо сказать явно.
    return row as SessionRow & { location: CountLocation };
  }

  /**
   * Опознать узел по введённому: номер с наклейки → серийник → набор/позиция
   * бункера. Не опознан — строка без узла, карточка заведётся при применении.
   */
  private async resolveUnit(
    tx: Tx | Db,
    input: AddCountLineInput,
  ): Promise<{ unit: (typeof partUnit.$inferSelect) | null; how: "number" | "serial" | "hopper" | null }> {
    if (input.inventoryNo && normalizeInventoryNo(input.inventoryNo) !== null) {
      if (!isValidInventoryNo(input.inventoryNo)) {
        throw new BadRequestException("Номер: латиница, цифры и дефис, например M-017 или H-27-3");
      }
      const byNo = await this.parts.findByInventoryNo(input.inventoryNo, tx as Tx);
      if (byNo) {
        if (byNo.partKind !== input.partKind) {
          throw new BadRequestException(
            `Номер ${byNo.inventoryNo} принадлежит узлу «${partUnitLabel(byNo)}» — это ${partLabel(byNo.partKind).toLowerCase()}, не ${partLabel(input.partKind).toLowerCase()}`,
          );
        }
        return { unit: byNo, how: "number" };
      }
      return { unit: null, how: null };
    }
    const serial = input.serialNumber?.trim();
    if (serial) {
      const [bySerial] = await tx
        .select()
        .from(partUnit)
        .where(and(eq(partUnit.partKind, input.partKind), sql`upper(${partUnit.serialNumber}) = upper(${serial})`, isNull(partUnit.retiredAt)))
        .limit(1);
      if (bySerial) return { unit: bySerial, how: "serial" };
    }
    if (input.partKind === "hopper" && input.setNumber !== undefined && input.hopperPosition !== undefined) {
      const [byHopper] = await tx
        .select()
        .from(partUnit)
        .where(and(eq(partUnit.partKind, "hopper"), eq(partUnit.setNumber, input.setNumber), eq(partUnit.hopperPosition, input.hopperPosition), isNull(partUnit.retiredAt)))
        .limit(1);
      if (byHopper) return { unit: byHopper, how: "hopper" };
    }
    return { unit: null, how: null };
  }

  private async lineViews(tx: Tx | Db, lines: LineRow[]): Promise<CountLineView[]> {
    const unitIds = [...new Set(lines.map((l) => l.partUnitId).filter((x): x is string => !!x))];
    const units = unitIds.length ? await tx.select().from(partUnit).where(inArray(partUnit.id, unitIds)) : [];
    const views = new Map((await this.parts.views(units, tx as Tx)).map((v) => [v.id, v]));
    const lineIds = lines.map((l) => l.id);
    const photos = lineIds.length
      ? await tx
          .select({ ownerId: attachment.ownerId, n: sql<number>`count(*)::int` })
          .from(attachment)
          .where(and(eq(attachment.ownerType, "part_count_line"), inArray(attachment.ownerId, lineIds)))
          .groupBy(attachment.ownerId)
      : [];
    const photoOf = new Map(photos.map((p) => [p.ownerId, Number(p.n)]));
    return lines.map((l) => {
      const unit = l.partUnitId ? (views.get(l.partUnitId) ?? null) : null;
      const label = unit
        ? unit.label
        : `${partLabel(l.partKind)} ${l.inventoryNoEntered ?? (l.serialEntered ? `S/N ${l.serialEntered}` : "(новый, без номера)")}`;
      const registeredAt = unit?.where
        ? unit.where.machineName
          ? `${unit.where.machineName}${unit.where.slot ? ` · слот ${unit.where.slot}` : ""}`
          : unit.where.location
        : unit
          ? "unknown"
          : null;
      // Фото найденного узла после применения переезжают на карточку — считаем оба владельца.
      const photoCount = (photoOf.get(l.id) ?? 0) + (l.result && unit ? unit.photoCount : 0);
      return { ...l, label, unit, photoCount, registeredAt };
    });
  }

  async addLine(sessionId: string, input: AddCountLineInput): Promise<{ line: CountLineView; status: "found" | "new"; how: string | null }> {
    const actorRef = input.actorRef ?? "owner";
    return this.db.transaction(async (tx) => {
      const session = await this.session(tx, sessionId);
      if (session.appliedAt) throw new BadRequestException("Сессия уже применена — начни новую");
      if (input.clientKey) {
        const [dup] = await tx.select().from(partCountLine).where(eq(partCountLine.clientKey, input.clientKey)).limit(1);
        if (dup) {
          const [view] = await this.lineViews(tx, [dup]);
          return { line: view, status: dup.partUnitId ? "found" : "new", how: null };
        }
      }
      const { unit, how } = await this.resolveUnit(tx, input);
      if (unit?.retiredAt) throw new BadRequestException(`«${partUnitLabel(unit)}» списан ${unit.retiredAt} — если он нашёлся, восстанови карточку в панели`);
      if (unit) {
        const [already] = await tx
          .select({ id: partCountLine.id })
          .from(partCountLine)
          .where(and(eq(partCountLine.sessionId, sessionId), eq(partCountLine.partUnitId, unit.id)))
          .limit(1);
        if (already) throw new ConflictException(`«${partUnitLabel(unit)}» в этой сессии уже посчитан`);
      }
      const [line] = await tx
        .insert(partCountLine)
        .values({
          sessionId,
          partUnitId: unit?.id ?? null,
          partKind: input.partKind,
          inventoryNoEntered: input.inventoryNo?.trim() ? normalizeInventoryNo(input.inventoryNo) : null,
          serialEntered: input.serialNumber?.trim() || null,
          setNumberEntered: input.setNumber ?? null,
          hopperPositionEntered: input.hopperPosition ?? null,
          photoSkippedReason: input.photoSkippedReason?.trim() || null,
          clientKey: input.clientKey ?? null,
          createdBy: actorRef,
        })
        .returning();
      // Ввод строк «расфинишивает» сессию: сотрудник вернулся досчитать.
      if (session.finishedAt) await tx.update(partCountSession).set({ finishedAt: null }).where(eq(partCountSession.id, sessionId));
      const [view] = await this.lineViews(tx, [line]);
      return { line: view, status: unit ? "found" : "new", how };
    });
  }

  /** Фото не снято — причина (или снята потом: причина стирается пустой строкой). */
  async skipPhoto(lineId: string, reason: string): Promise<LineRow> {
    const [line] = await this.db
      .update(partCountLine)
      .set({ photoSkippedReason: reason.trim() || null })
      .where(eq(partCountLine.id, lineId))
      .returning();
    if (!line) throw new NotFoundException("Строки с таким id нет");
    return line;
  }

  /** Убрать строку черновика (ошибся). После применения строки неприкосновенны. */
  async removeLine(lineId: string, actorRef = "owner"): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [line] = await tx.select().from(partCountLine).where(eq(partCountLine.id, lineId)).limit(1);
      if (!line) throw new NotFoundException("Строки с таким id нет");
      const session = await this.session(tx, line.sessionId);
      if (session.appliedAt) throw new BadRequestException("Сессия применена — строки не убираются, только обратная сессия");
      await tx.delete(attachment).where(and(eq(attachment.ownerType, "part_count_line"), eq(attachment.ownerId, lineId)));
      await tx.delete(partCountLine).where(eq(partCountLine.id, lineId));
      await tx.insert(auditLog).values({
        actorKind: actorKindOf(actorRef),
        actorRef,
        action: "parts.count_line_removed",
        target: lineId,
        before: line,
      });
    });
  }

  async finish(sessionId: string, actorRef = "owner"): Promise<CountSummary> {
    const session = await this.session(this.db, sessionId);
    if (!session.appliedAt && !session.finishedAt) {
      await this.db.update(partCountSession).set({ finishedAt: new Date() }).where(eq(partCountSession.id, sessionId));
      await this.db.insert(auditLog).values({ actorKind: actorKindOf(actorRef), actorRef, action: "parts.count_finished", target: sessionId });
    }
    return this.summary(sessionId);
  }

  async summary(sessionId: string, tx: Tx | Db = this.db): Promise<CountSummary> {
    const session = await this.session(tx, sessionId);
    const rows = await tx.select().from(partCountLine).where(eq(partCountLine.sessionId, sessionId)).orderBy(asc(partCountLine.createdAt));
    const lines = await this.lineViews(tx, rows);
    const photoRequired = await this.photoRequired();
    if (session.appliedAt) {
      const missingIds = rows.filter((l) => l.result === "missing").map((l) => l.partUnitId).filter((x): x is string => !!x);
      const missingUnits = missingIds.length ? await tx.select().from(partUnit).where(inArray(partUnit.id, missingIds)) : [];
      return {
        session,
        lines,
        expected: [],
        found: rows.filter((l) => l.result === "found").length,
        fresh: rows.filter((l) => l.result === "new").length,
        moved: rows.filter((l) => l.result === "found" && l.prevLocation !== null).length,
        missing: await this.parts.views(missingUnits, tx as Tx),
        photoRequired,
      };
    }
    const expected = session.reversesId ? [] : await this.parts.atLocation(session.location);
    const counted = new Set(rows.map((l) => l.partUnitId).filter((x): x is string => !!x));
    const expectedIds = new Set(expected.map((u) => u.id));
    return {
      session,
      lines,
      expected,
      found: [...counted].filter((id) => expectedIds.has(id)).length,
      fresh: rows.filter((l) => !l.partUnitId).length,
      moved: [...counted].filter((id) => !expectedIds.has(id)).length,
      missing: expected.filter((u) => !counted.has(u.id)),
      photoRequired,
    };
  }

  async list(limit = 50): Promise<(SessionRow & { lines: number; personName: string | null })[]> {
    const rows = await this.db
      .select({
        session: partCountSession,
        // Явные имена таблиц: drizzle в одиночном select не квалифицирует колонки,
        // и `session_id = id` внутри подзапроса сравнивал бы строку саму с собой.
        lines: sql<number>`(select count(*)::int from part_count_line l where l.session_id = part_count_session.id)`,
      })
      .from(partCountSession)
      .orderBy(desc(partCountSession.startedAt))
      .limit(Math.min(limit, 200));
    const personIds = [...new Set(rows.map((r) => r.session.personId).filter((x): x is string => !!x))];
    const people = personIds.length ? await this.db.select({ id: person.id, name: person.name }).from(person).where(inArray(person.id, personIds)) : [];
    const nameOf = new Map(people.map((p) => [p.id, p.name]));
    return rows.map((r) => ({ ...r.session, lines: Number(r.lines), personName: r.session.personId ? (nameOf.get(r.session.personId) ?? null) : null }));
  }

  /** Автомат, с которого узел снят последним, — объект записи журнала (у склада своего нет). */
  private async lastMachineOf(tx: Tx, unitId: string): Promise<string | null> {
    const [row] = await tx
      .select({ machineId: machinePart.machineId })
      .from(machinePart)
      .where(and(eq(machinePart.partUnitId, unitId), sql`${machinePart.machineId} is not null`))
      .orderBy(desc(machinePart.installedOn))
      .limit(1);
    return row?.machineId ?? null;
  }

  /** Закрыть открытый период узла и открыть новый в месте/на автомате. Возвращает открытый до этого период. */
  private async relocate(
    tx: Tx,
    unit: typeof partUnit.$inferSelect,
    to: { location: PeriodRow["location"]; machineId: string | null; slot: number | null },
    note: string,
    actorRef: string,
    logKind: "inspection" | "other",
    logNote: string,
    personId: string | null,
  ): Promise<PeriodRow | null> {
    const today = todayInTz();
    const [open] = await tx
      .select()
      .from(machinePart)
      .where(and(eq(machinePart.partUnitId, unit.id), isNull(machinePart.removedOn)))
      .limit(1);
    const machineForLog = open?.machineId ?? (await this.lastMachineOf(tx, unit.id));
    let logId: string | null = null;
    if (machineForLog) {
      const [log] = await tx
        .insert(maintenanceLog)
        .values({
          entityId: machineForLog,
          kind: logKind,
          partKind: unit.partKind,
          partUnitId: unit.id,
          personId,
          performedOn: today,
          outcome: "done",
          note: logNote,
          createdBy: actorRef,
        })
        .returning();
      logId = log.id;
    }
    if (open) {
      await tx
        .update(machinePart)
        .set({ removedOn: today, ...(logId ? { removeLogId: logId } : {}) })
        .where(eq(machinePart.id, open.id));
    }
    await tx.insert(machinePart).values({
      partUnitId: unit.id,
      machineId: to.machineId,
      location: to.location,
      partKind: unit.partKind,
      slot: to.slot,
      serialNumber: unit.serialNumber,
      model: unit.model,
      installedOn: today,
      ...(logId ? { installLogId: logId } : {}),
      warrantyUntil: unit.warrantyUntil,
      note,
      createdBy: actorRef,
    });
    return open ?? null;
  }

  /**
   * Применить сессию (R-PU-7) одной транзакцией:
   * найденные — подтверждены (числившиеся не здесь — переведены сюда),
   * новые — заведены с номером от системы, не найденные — в «неизвестно где».
   */
  async apply(sessionId: string, input: { actorRef?: string; personId?: string } = {}): Promise<ApplyReport> {
    const actorRef = input.actorRef ?? "owner";
    const today = todayInTz();
    return this.db.transaction(async (tx) => {
      const [locked] = await tx.select({ id: partCountSession.id }).from(partCountSession).where(eq(partCountSession.id, sessionId)).for("update").limit(1);
      if (!locked) throw new NotFoundException("Сессии инвентаризации с таким id нет");
      const session = await this.session(tx, sessionId);
      if (session.appliedAt) throw new BadRequestException("Сессия уже применена");
      if (session.reversesId) throw new BadRequestException("Обратная сессия применяется при создании");
      const personId = input.personId ?? session.personId ?? null;
      const lines = await tx.select().from(partCountLine).where(eq(partCountLine.sessionId, sessionId)).orderBy(asc(partCountLine.createdAt));
      const report: ApplyReport = { sessionId, found: 0, created: [], moved: [], missing: [] };
      const counted = new Set<string>();

      for (const line of lines) {
        if (line.result) continue; // защита от двойного применения строк
        let unit: typeof partUnit.$inferSelect;
        if (line.partUnitId) {
          const [row] = await tx.select().from(partUnit).where(eq(partUnit.id, line.partUnitId)).limit(1);
          if (!row) continue;
          unit = row;
          const [open] = await tx
            .select()
            .from(machinePart)
            .where(and(eq(machinePart.partUnitId, unit.id), isNull(machinePart.removedOn)))
            .limit(1);
          const here = open && !open.machineId && open.location === session.location;
          if (here) {
            await tx.update(partCountLine).set({ result: "found" }).where(eq(partCountLine.id, line.id));
          } else {
            const prev = await this.relocate(
              tx,
              unit,
              { location: session.location, machineId: null, slot: null },
              `найден при инвентаризации ${today}`,
              actorRef,
              "other",
              open?.machineId
                ? `снят по инвентаризации ${today}: узел найден в месте «${session.location}», а числился на автомате`
                : `найден при инвентаризации ${today} в месте «${session.location}»`,
              personId,
            );
            await tx
              .update(partCountLine)
              .set({
                result: "found",
                prevLocation: prev?.location ?? "unknown",
                prevMachineId: prev?.machineId ?? null,
                prevSlot: prev?.slot ?? null,
              })
              .where(eq(partCountLine.id, line.id));
            report.moved.push(partUnitLabel(unit));
          }
          // Серийник, переписанный при инвентаризации, — на карточку, если там пусто.
          if (line.serialEntered && !unit.serialNumber) {
            await tx.update(partUnit).set({ serialNumber: line.serialEntered, updatedAt: new Date() }).where(eq(partUnit.id, unit.id));
          }
          report.found += 1;
        } else {
          const created = await this.parts.create(
            {
              partKind: line.partKind,
              ...(line.inventoryNoEntered ? { inventoryNo: line.inventoryNoEntered, labelPending: false } : {}),
              ...(line.serialEntered ? { serialNumber: line.serialEntered } : {}),
              ...(line.setNumberEntered !== null ? { setNumber: line.setNumberEntered } : {}),
              ...(line.hopperPositionEntered !== null ? { hopperPosition: line.hopperPositionEntered } : {}),
              location: session.location,
              origin: "count",
              note: `заведён при инвентаризации ${today}`,
              createdBy: actorRef,
            },
            tx,
          );
          unit = created;
          await tx.update(partCountLine).set({ result: "new", partUnitId: created.id }).where(eq(partCountLine.id, line.id));
          report.created.push(created.label);
        }
        counted.add(unit.id);
        // Фото строки становятся фото узла: очередь «без фото» гаснет тем же снимком.
        await tx
          .update(attachment)
          .set({ ownerType: "part_unit", ownerId: unit.id, stage: "count" })
          .where(and(eq(attachment.ownerType, "part_count_line"), eq(attachment.ownerId, line.id)));
      }

      // Не найденные: ожидались здесь по открытым периодам, но в строках их нет.
      const expected = await tx
        .select({ unit: partUnit })
        .from(machinePart)
        .innerJoin(partUnit, eq(partUnit.id, machinePart.partUnitId))
        .where(and(eq(machinePart.location, session.location), isNull(machinePart.machineId), isNull(machinePart.removedOn), isNull(partUnit.retiredAt)));
      for (const { unit } of expected) {
        if (counted.has(unit.id)) continue;
        const prev = await this.relocate(
          tx,
          unit,
          { location: "unknown", machineId: null, slot: null },
          `не найден при инвентаризации ${today}`,
          actorRef,
          "inspection",
          `не найден при инвентаризации ${today} (место «${session.location}»)`,
          personId,
        );
        await tx.insert(partCountLine).values({
          sessionId,
          partUnitId: unit.id,
          partKind: unit.partKind,
          result: "missing",
          prevLocation: prev?.location ?? session.location,
          prevMachineId: null,
          prevSlot: null,
          createdBy: actorRef,
        });
        report.missing.push(partUnitLabel(unit));
      }

      const now = new Date();
      await tx
        .update(partCountSession)
        .set({ appliedAt: now, appliedBy: actorRef, finishedAt: session.finishedAt ?? now })
        .where(eq(partCountSession.id, sessionId));
      await tx.insert(auditLog).values({
        actorKind: actorKindOf(actorRef),
        actorRef,
        action: "parts.count_applied",
        target: sessionId,
        after: { found: report.found, created: report.created.length, moved: report.moved.length, missing: report.missing.length },
      });
      return report;
    });
  }

  /**
   * Обратная сессия: вернуть не найденных из «неизвестно где» на место и
   * перемещённых — туда, где числились. Заведённые узлы остаются: они
   * существуют физически, карточка не вредит.
   */
  async reverse(sessionId: string, actorRef = "owner"): Promise<{ session: SessionRow; restored: string[]; skipped: string[] }> {
    const today = todayInTz();
    return this.db.transaction(async (tx) => {
      const original = await this.session(tx, sessionId);
      if (!original.appliedAt) throw new BadRequestException("Откатывать можно только применённую сессию");
      const [already] = await tx.select({ id: partCountSession.id }).from(partCountSession).where(eq(partCountSession.reversesId, sessionId)).limit(1);
      if (already) throw new ConflictException("Эта сессия уже откачена");
      const now = new Date();
      const [rev] = await tx
        .insert(partCountSession)
        .values({
          location: original.location,
          warehouseId: original.warehouseId,
          personId: original.personId,
          reversesId: sessionId,
          note: `откат инвентаризации ${original.startedAt.toISOString().slice(0, 10)}`,
          finishedAt: now,
          appliedAt: now,
          appliedBy: actorRef,
          createdBy: actorRef,
        })
        .returning();
      const lines = await tx.select().from(partCountLine).where(eq(partCountLine.sessionId, sessionId));
      const restored: string[] = [];
      const skipped: string[] = [];
      for (const line of lines) {
        if (!line.partUnitId) continue;
        const [unit] = await tx.select().from(partUnit).where(eq(partUnit.id, line.partUnitId)).limit(1);
        if (!unit) continue;
        const wantsBack = line.result === "missing" || (line.result === "found" && line.prevLocation !== null);
        if (!wantsBack) continue;
        const target =
          line.result === "missing"
            ? { location: original.location, machineId: null, slot: null }
            : { location: line.prevLocation!, machineId: line.prevMachineId, slot: line.prevSlot };
        if (target.machineId) {
          // Место на автомате могло занять другое — тогда честно пропускаем.
          const [busy] = await tx
            .select({ id: machinePart.id })
            .from(machinePart)
            .where(
              and(
                eq(machinePart.machineId, target.machineId),
                eq(machinePart.partKind, unit.partKind),
                target.slot === null ? isNull(machinePart.slot) : eq(machinePart.slot, target.slot),
                isNull(machinePart.removedOn),
              ),
            )
            .limit(1);
          if (busy) {
            skipped.push(`${partUnitLabel(unit)}: место на автомате занято`);
            continue;
          }
        }
        if (target.location === "unknown") {
          skipped.push(`${partUnitLabel(unit)}: до инвентаризации место было неизвестно`);
          continue;
        }
        await this.relocate(tx, unit, target, `откат инвентаризации ${today}`, actorRef, "other", `откат инвентаризации ${today}`, original.personId);
        await tx.insert(partCountLine).values({
          sessionId: rev.id,
          partUnitId: unit.id,
          partKind: unit.partKind,
          result: "reversed",
          prevLocation: line.result === "missing" ? "unknown" : original.location,
          createdBy: actorRef,
        });
        restored.push(partUnitLabel(unit));
      }
      await tx.insert(auditLog).values({
        actorKind: actorKindOf(actorRef),
        actorRef,
        action: "parts.count_reversed",
        target: sessionId,
        after: { reverseSessionId: rev.id, restored: restored.length, skipped },
      });
      return { session: rev, restored, skipped };
    });
  }
}

/** Подпись места для сообщений: «склад», «мойка»… */
export function countLocationLabel(location: PeriodRow["location"]): string {
  const map: Record<PeriodRow["location"], string> = {
    machine: "автомат",
    warehouse: "склад",
    washing: "мойка",
    drying: "сушка",
    repair: "ремонт",
    unknown: "неизвестно где",
  };
  return map[location] ?? location;
}
