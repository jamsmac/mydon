import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  attachment,
  auditLog,
  coffeeContainerTare,
  coffeeRefill,
  entity,
  machineCard,
  machinePart,
  machinePlacement,
  maintenanceLog,
  partUnit,
} from "@mydon/db";
import {
  actorKindOf,
  DEFAULT_COFFEE_PARTS_TEMPLATE,
  formatInventoryNo,
  isValidInventoryNo,
  normalizeInventoryNo,
  parsePartsTemplate,
  partLabel,
  planMissingParts,
  suggestInventoryNo,
  type PartAttention,
  type PartKind,
  type PartsTemplateEntry,
} from "@mydon/shared";
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { settingValue } from "../system/settings";
import { todayInTz } from "./maintenance.service";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type PartUnitRow = typeof partUnit.$inferSelect;
type PeriodRow = typeof machinePart.$inferSelect;

/** Где узел сейчас — из открытого периода (R-PU-5). NULL — открытого периода нет. */
export interface PartWhereabouts {
  location: PeriodRow["location"];
  machineId: string | null;
  machineName: string | null;
  slot: number | null;
  since: string;
  periodId: string;
}

/** Карточка узла с вычисленным состоянием — то, что видят панель и бот. */
export interface PartUnitView extends PartUnitRow {
  where: PartWhereabouts | null;
  /** Что мешает узлу считаться учтённым (очередь «Наклеить номер», бейджи). */
  attention: PartAttention[];
  /** Подпись для списков: «Миксер M-017» / «Бункер H-27-3 (без номера)». */
  label: string;
  photoCount: number;
}

export interface ListPartsFilter {
  kind?: PartKind;
  location?: PeriodRow["location"] | "none";
  machineId?: string;
  /** Только узлы, требующие внимания (любая причина). */
  attention?: boolean;
  includeRetired?: boolean;
  q?: string;
  limit?: number;
}

export interface CreatePartUnitInput {
  partKind: PartKind;
  inventoryNo?: string;
  serialNumber?: string;
  model?: string;
  manufacturer?: string;
  setNumber?: number;
  hopperPosition?: number;
  tareWeight?: number;
  purchaseDate?: string;
  purchasePrice?: string;
  warrantyUntil?: string;
  note?: string;
  /** Где узел сейчас: открыть период. Без места — карточка без периода (местонахождение неизвестно). */
  location?: Exclude<PeriodRow["location"], "machine">;
  origin?: PartUnitRow["origin"];
  /** Номер присвоен системой — наклейка ещё не подтверждена. */
  labelPending?: boolean;
  createdBy?: string;
}

export interface UpdatePartUnitInput {
  serialNumber?: string | null;
  model?: string | null;
  manufacturer?: string | null;
  setNumber?: number | null;
  hopperPosition?: number | null;
  tareWeight?: number | null;
  purchaseDate?: string | null;
  purchasePrice?: string | null;
  warrantyUntil?: string | null;
  note?: string | null;
}

export interface AssignNumberInput {
  /** Новый номер с наклейки. Пусто — оставить текущий (только подтверждение). */
  inventoryNo?: string;
  /** Сотрудник подтверждает: наклейка на детали. */
  confirmLabel?: boolean;
  actorRef?: string;
}

export interface ProvisionInput {
  /** Только посчитать, ничего не писать. */
  dryRun?: boolean;
  /** Ограничить автоматами (иначе — все кофейные). */
  machineIds?: string[];
  actorRef?: string;
}

export interface ProvisionMachineReport {
  machineId: string;
  machineName: string;
  created: string[];
  /** Узлов уже стояло — пропущено. */
  existing: number;
  /** Бункеры, у которых набор найден по последней заливке. */
  hopperSetsFound: number;
}

export interface ProvisionReport {
  dryRun: boolean;
  template: PartsTemplateEntry[];
  machines: ProvisionMachineReport[];
  createdTotal: number;
}

/** Подпись узла: вид + номер, «без номера» — честно словами. */
export function partUnitLabel(u: Pick<PartUnitRow, "partKind" | "inventoryNo">): string {
  return `${partLabel(u.partKind)} ${u.inventoryNo ?? "(без номера)"}`;
}

/** Причины внимания по карточке и её состоянию (R-PU-4, R-PU-6, R-PU-9). */
export function attentionOf(
  u: PartUnitRow,
  where: PartWhereabouts | null,
  photoCount: number,
): PartAttention[] {
  if (u.retiredAt) return [];
  const out: PartAttention[] = [];
  if (!u.inventoryNo) out.push("no_number");
  else if (u.labelPending) out.push("label_pending");
  if (!where || where.location === "unknown") out.push("unknown_location");
  if (u.partKind === "hopper" && u.tareWeight === null) out.push("no_tare");
  if (photoCount === 0) out.push("no_photo");
  return out;
}

/**
 * Карточки физических узлов (спека 2026-09-04-vendhub-parts-inventory, У1).
 *
 * Периоды «где узел» по-прежнему ведёт MaintenanceService (swap/install/
 * remove) — здесь сама деталь: заведение, номера, паспорт, списание,
 * очередь внимания и история одного экземпляра.
 */
@Injectable()
export class PartsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Открытые периоды выбранных узлов + имена автоматов. */
  private async whereaboutsOf(tx: Tx | Db, ids: string[]): Promise<Map<string, PartWhereabouts>> {
    if (ids.length === 0) return new Map();
    const rows = await tx
      .select({
        partUnitId: machinePart.partUnitId,
        periodId: machinePart.id,
        location: machinePart.location,
        machineId: machinePart.machineId,
        slot: machinePart.slot,
        installedOn: machinePart.installedOn,
        machineName: entity.name,
      })
      .from(machinePart)
      .leftJoin(entity, eq(entity.id, machinePart.machineId))
      .where(and(inArray(machinePart.partUnitId, ids), isNull(machinePart.removedOn)));
    return new Map(
      rows.map((r) => [
        r.partUnitId,
        {
          location: r.location,
          machineId: r.machineId,
          machineName: r.machineName ?? null,
          slot: r.slot,
          since: r.installedOn,
          periodId: r.periodId,
        },
      ]),
    );
  }

  private async photoCounts(tx: Tx | Db, ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await tx
      .select({ ownerId: attachment.ownerId, n: sql<number>`count(*)::int` })
      .from(attachment)
      .where(and(eq(attachment.ownerType, "part_unit"), inArray(attachment.ownerId, ids)))
      .groupBy(attachment.ownerId);
    return new Map(rows.map((r) => [r.ownerId, Number(r.n)]));
  }

  private async toViews(tx: Tx | Db, units: PartUnitRow[]): Promise<PartUnitView[]> {
    const ids = units.map((u) => u.id);
    const [where, photos] = await Promise.all([this.whereaboutsOf(tx, ids), this.photoCounts(tx, ids)]);
    return units.map((u) => {
      const w = where.get(u.id) ?? null;
      const photoCount = photos.get(u.id) ?? 0;
      return { ...u, where: w, attention: attentionOf(u, w, photoCount), label: partUnitLabel(u), photoCount };
    });
  }

  /** Реестр узлов с фильтрами. Состояние считается на чтении. */
  async list(filter: ListPartsFilter = {}): Promise<PartUnitView[]> {
    const conditions: SQL[] = [];
    if (filter.kind) conditions.push(eq(partUnit.partKind, filter.kind));
    if (!filter.includeRetired) conditions.push(isNull(partUnit.retiredAt));
    if (filter.q) {
      const q = `%${filter.q.trim()}%`;
      conditions.push(
        sql`(${partUnit.inventoryNo} ilike ${q} or ${partUnit.serialNumber} ilike ${q} or ${partUnit.model} ilike ${q})`,
      );
    }
    const units = await this.db
      .select()
      .from(partUnit)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(partUnit.partKind), asc(partUnit.inventoryNo), desc(partUnit.createdAt))
      .limit(Math.min(filter.limit ?? 500, 2000));
    let views = await this.toViews(this.db, units);
    if (filter.machineId) views = views.filter((v) => v.where?.machineId === filter.machineId);
    if (filter.location === "none") views = views.filter((v) => v.where === null);
    else if (filter.location) views = views.filter((v) => v.where?.location === filter.location);
    if (filter.attention) views = views.filter((v) => v.attention.length > 0);
    return views;
  }

  /** Очередь «Наклеить номер» и прочее внимание — по одному, как квиз (R-PU-4). */
  async queue(): Promise<{ counts: Record<PartAttention, number>; items: PartUnitView[] }> {
    const items = await this.list({ attention: true, limit: 2000 });
    const counts: Record<PartAttention, number> = {
      no_number: 0,
      label_pending: 0,
      unknown_location: 0,
      no_tare: 0,
      no_photo: 0,
    };
    for (const it of items) for (const a of it.attention) counts[a] += 1;
    // Сначала то, что мешает работе больше: без номера → наклеить → неизвестно где → тара → фото.
    const rank = (v: PartUnitView) =>
      v.attention.includes("no_number")
        ? 0
        : v.attention.includes("label_pending")
          ? 1
          : v.attention.includes("unknown_location")
            ? 2
            : v.attention.includes("no_tare")
              ? 3
              : 4;
    items.sort((a, b) => rank(a) - rank(b) || (a.inventoryNo ?? "").localeCompare(b.inventoryNo ?? "", "ru"));
    return { counts, items };
  }

  async get(id: string): Promise<PartUnitView> {
    const [u] = await this.db.select().from(partUnit).where(eq(partUnit.id, id)).limit(1);
    if (!u) throw new NotFoundException("Узла с таким id нет");
    const [view] = await this.toViews(this.db, [u]);
    return view;
  }

  /** Все периоды узла — где стоял и где лежал, новые сверху. */
  async history(id: string): Promise<(PeriodRow & { machineName: string | null })[]> {
    const rows = await this.db
      .select({ period: machinePart, machineName: entity.name })
      .from(machinePart)
      .leftJoin(entity, eq(entity.id, machinePart.machineId))
      .where(eq(machinePart.partUnitId, id))
      .orderBy(desc(machinePart.installedOn), desc(machinePart.createdAt))
      .limit(200);
    return rows.map((r) => ({ ...r.period, machineName: r.machineName ?? null }));
  }

  /** Следующий свободный номер серии вида (R-PU-2): максимум занятых + 1. */
  async suggestNumber(kind: PartKind, tx: Tx | Db = this.db): Promise<string> {
    const taken = await tx
      .select({ no: partUnit.inventoryNo })
      .from(partUnit)
      .where(and(eq(partUnit.partKind, kind), sql`${partUnit.inventoryNo} is not null`));
    return suggestInventoryNo(kind, taken.map((t) => t.no!));
  }

  /** Номер занят другим узлом? Сравнение как в уникальном индексе. */
  private async takenBy(tx: Tx | Db, inventoryNo: string, exceptId?: string): Promise<PartUnitRow | null> {
    const norm = normalizeInventoryNo(inventoryNo)!;
    const rows = await tx
      .select()
      .from(partUnit)
      .where(sql`upper(regexp_replace(${partUnit.inventoryNo}, '\\s', '', 'g')) = ${norm}`)
      .limit(2);
    const other = rows.find((r) => r.id !== exceptId);
    return other ?? null;
  }

  /**
   * Завести узел. Номер — либо с наклейки (`inventoryNo`), либо система
   * присваивает следующий свободный и помечает «наклеить» (R-PU-2). Для
   * бункера с набором номер задаёт набор: `H-<набор>-<позиция>`.
   */
  async create(input: CreatePartUnitInput, outerTx?: Tx): Promise<PartUnitView> {
    const run = async (tx: Tx): Promise<PartUnitView> => {
      const hopper =
        input.partKind === "hopper" && input.setNumber !== undefined && input.hopperPosition !== undefined
          ? { setNumber: input.setNumber, position: input.hopperPosition }
          : undefined;
      let inventoryNo: string | null;
      let labelPending: boolean;
      if (input.inventoryNo !== undefined && normalizeInventoryNo(input.inventoryNo) !== null) {
        if (!isValidInventoryNo(input.inventoryNo)) {
          throw new BadRequestException("Номер: латиница, цифры и дефис, например M-017 или H-27-3");
        }
        inventoryNo = normalizeInventoryNo(input.inventoryNo);
        labelPending = input.labelPending ?? false;
      } else if (hopper) {
        inventoryNo = formatInventoryNo("hopper", 0, hopper);
        labelPending = input.labelPending ?? true;
      } else {
        inventoryNo = await this.suggestNumber(input.partKind, tx);
        labelPending = input.labelPending ?? true;
      }
      const busy = await this.takenBy(tx, inventoryNo!);
      if (busy) throw new ConflictException(`Номер ${inventoryNo} уже у узла «${partUnitLabel(busy)}»`);

      const [created] = await tx
        .insert(partUnit)
        .values({
          partKind: input.partKind,
          inventoryNo,
          labelPending,
          serialNumber: input.serialNumber?.trim() || null,
          model: input.model?.trim() || null,
          manufacturer: input.manufacturer?.trim() || null,
          setNumber: input.setNumber ?? null,
          hopperPosition: input.hopperPosition ?? null,
          tareWeight: input.tareWeight ?? null,
          purchaseDate: input.purchaseDate ?? null,
          purchasePrice: input.purchasePrice ?? null,
          warrantyUntil: input.warrantyUntil ?? null,
          origin: input.origin ?? "manual",
          note: input.note ?? null,
          createdBy: input.createdBy ?? "owner",
        })
        .returning();

      if (input.location) {
        await tx.insert(machinePart).values({
          partUnitId: created.id,
          machineId: null,
          location: input.location,
          partKind: input.partKind,
          slot: null,
          serialNumber: created.serialNumber,
          model: created.model,
          installedOn: todayInTz(),
          warrantyUntil: created.warrantyUntil,
          note: "период открыт при заведении карточки",
          createdBy: input.createdBy ?? "owner",
        });
      }

      await tx.insert(auditLog).values({
        actorKind: actorKindOf(input.createdBy ?? "owner"),
        actorRef: input.createdBy ?? "owner",
        action: "parts.unit_created",
        target: created.id,
        after: created,
      });
      const [view] = await this.toViews(tx, [created]);
      return view;
    };
    return outerTx ? run(outerTx) : this.db.transaction(run);
  }

  async update(id: string, patch: UpdatePartUnitInput, actorRef = "owner"): Promise<PartUnitView> {
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(partUnit).where(eq(partUnit.id, id)).limit(1);
      if (!before) throw new NotFoundException("Узла с таким id нет");
      const values: Partial<typeof partUnit.$inferInsert> = { updatedAt: new Date() };
      for (const key of [
        "serialNumber",
        "model",
        "manufacturer",
        "setNumber",
        "hopperPosition",
        "tareWeight",
        "purchaseDate",
        "purchasePrice",
        "warrantyUntil",
        "note",
      ] as const) {
        if (patch[key] !== undefined) (values as Record<string, unknown>)[key] = patch[key];
      }
      if ((values.setNumber !== undefined || values.hopperPosition !== undefined) && before.partKind !== "hopper") {
        throw new BadRequestException("Набор и позиция — только у бункера");
      }
      // Бункер получил набор и позицию, а номер ещё системный счётчик и наклейки
      // нет — переименовываем в H-<набор>-<позиция> (R-PU-2): наклейка будет одна.
      const setNumber = values.setNumber !== undefined ? values.setNumber : before.setNumber;
      const hopperPosition = values.hopperPosition !== undefined ? values.hopperPosition : before.hopperPosition;
      if (
        before.partKind === "hopper" &&
        setNumber &&
        hopperPosition &&
        before.labelPending &&
        before.inventoryNo !== null &&
        /^H-\d+$/.test(before.inventoryNo)
      ) {
        const wanted = formatInventoryNo("hopper", 0, { setNumber, position: hopperPosition });
        const busy = await this.takenBy(tx, wanted, id);
        if (!busy) values.inventoryNo = wanted;
      }
      const [after] = await tx.update(partUnit).set(values).where(eq(partUnit.id, id)).returning();
      await tx.insert(auditLog).values({
        actorKind: actorKindOf(actorRef),
        actorRef,
        action: "parts.unit_updated",
        target: id,
        before,
        after,
      });
      const [view] = await this.toViews(tx, [after]);
      return view;
    });
  }

  /**
   * Проставить / подтвердить / исправить номер (R-PU-2, R-PU-4).
   *
   * Подтверждение без нового номера снимает «наклеить»; новый номер с
   * наклейки — заменяет системный и тоже считается подтверждённым: сотрудник
   * видел деталь. Занятый номер — конфликт с именем узла, который его держит.
   */
  async assignNumber(id: string, input: AssignNumberInput): Promise<PartUnitView> {
    const actorRef = input.actorRef ?? "owner";
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(partUnit).where(eq(partUnit.id, id)).limit(1);
      if (!before) throw new NotFoundException("Узла с таким id нет");
      let inventoryNo = before.inventoryNo;
      if (input.inventoryNo !== undefined && normalizeInventoryNo(input.inventoryNo) !== null) {
        if (!isValidInventoryNo(input.inventoryNo)) {
          throw new BadRequestException("Номер: латиница, цифры и дефис, например M-017 или H-27-3");
        }
        inventoryNo = normalizeInventoryNo(input.inventoryNo);
        const busy = await this.takenBy(tx, inventoryNo!, id);
        if (busy) throw new ConflictException(`Номер ${inventoryNo} уже у узла «${partUnitLabel(busy)}»`);
      }
      if (!inventoryNo) {
        // Номера не было и не дали — присваиваем серию, наклейку ещё предстоит сделать.
        inventoryNo = await this.suggestNumber(before.partKind, tx);
      }
      const labelPending = input.confirmLabel || (input.inventoryNo !== undefined && normalizeInventoryNo(input.inventoryNo) !== null)
        ? false
        : before.inventoryNo === inventoryNo
          ? before.labelPending
          : true;
      const [after] = await tx
        .update(partUnit)
        .set({ inventoryNo, labelPending, updatedAt: new Date() })
        .where(eq(partUnit.id, id))
        .returning();
      await tx.insert(auditLog).values({
        actorKind: actorKindOf(actorRef),
        actorRef,
        action: "parts.number_assigned",
        target: id,
        before: { inventoryNo: before.inventoryNo, labelPending: before.labelPending },
        after: { inventoryNo: after.inventoryNo, labelPending: after.labelPending },
      });
      const [view] = await this.toViews(tx, [after]);
      return view;
    });
  }

  /** Списать узел: открытый период закрывается, карточка остаётся (R-PU-11). */
  async retire(id: string, reason: string, actorRef = "owner"): Promise<PartUnitView> {
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(partUnit).where(eq(partUnit.id, id)).limit(1);
      if (!before) throw new NotFoundException("Узла с таким id нет");
      if (before.retiredAt) throw new BadRequestException("Узел уже списан");
      const today = todayInTz();
      const [open] = await tx
        .select()
        .from(machinePart)
        .where(and(eq(machinePart.partUnitId, id), isNull(machinePart.removedOn)))
        .limit(1);
      if (open?.machineId) {
        throw new BadRequestException("Узел стоит на автомате — сначала снимите его");
      }
      if (open) {
        await tx.update(machinePart).set({ removedOn: today }).where(eq(machinePart.id, open.id));
      }
      const [after] = await tx
        .update(partUnit)
        .set({ retiredAt: today, retiredReason: reason.trim() || null, updatedAt: new Date() })
        .where(eq(partUnit.id, id))
        .returning();
      await tx.insert(auditLog).values({
        actorKind: actorKindOf(actorRef),
        actorRef,
        action: "parts.unit_retired",
        target: id,
        before,
        after,
      });
      const [view] = await this.toViews(tx, [after]);
      return view;
    });
  }

  /** Узлы, стоящие на автомате сейчас — для задач ТО и пикеров (У3). */
  async installedOn(machineId: string): Promise<PartUnitView[]> {
    const rows = await this.db
      .select({ unit: partUnit })
      .from(machinePart)
      .innerJoin(partUnit, eq(partUnit.id, machinePart.partUnitId))
      .where(and(eq(machinePart.machineId, machineId), isNull(machinePart.removedOn)))
      .orderBy(asc(partUnit.partKind), asc(machinePart.slot));
    return this.toViews(this.db, rows.map((r) => r.unit));
  }

  /** Запасные узлы вида: лежат на складе (или там, где сказано), не списаны. */
  async spares(kind: PartKind, location: PeriodRow["location"] = "warehouse"): Promise<PartUnitView[]> {
    const rows = await this.db
      .select({ unit: partUnit })
      .from(machinePart)
      .innerJoin(partUnit, eq(partUnit.id, machinePart.partUnitId))
      .where(
        and(
          eq(machinePart.partKind, kind),
          eq(machinePart.location, location),
          isNull(machinePart.removedOn),
          isNull(partUnit.retiredAt),
        ),
      )
      .orderBy(asc(partUnit.inventoryNo));
    return this.toViews(this.db, rows.map((r) => r.unit));
  }

  /** Шаблон состава кофейного автомата: настройка PARTS_TEMPLATE_COFFEE, иначе дефолт. */
  async coffeeTemplate(): Promise<PartsTemplateEntry[]> {
    const raw = await settingValue(this.db, "PARTS_TEMPLATE_COFFEE");
    return parsePartsTemplate(raw) ?? [...DEFAULT_COFFEE_PARTS_TEMPLATE];
  }

  /**
   * Какой набор бункеров стоит на автомате по позициям — из последней заливки
   * точки, где автомат стоит сейчас (набор записывается техником при заливке).
   * Пусто — набор неизвестен, бункеры заведутся без набора (номер-счётчик).
   */
  private async hopperSetsOf(tx: Tx | Db, machineId: string): Promise<Map<number, number>> {
    const [placement] = await tx
      .select({ locationId: machinePlacement.locationId })
      .from(machinePlacement)
      .where(and(eq(machinePlacement.entityId, machineId), isNull(machinePlacement.endDate)))
      .limit(1);
    if (!placement) return new Map();
    const rows = await tx
      .select({ position: coffeeRefill.position, containerNumber: coffeeRefill.containerNumber, enteredDate: coffeeRefill.enteredDate })
      .from(coffeeRefill)
      .where(and(eq(coffeeRefill.locationId, placement.locationId), sql`${coffeeRefill.containerNumber} is not null`))
      .orderBy(desc(coffeeRefill.enteredDate), desc(coffeeRefill.createdAt))
      .limit(200);
    const out = new Map<number, number>();
    for (const r of rows) if (!out.has(r.position) && r.containerNumber !== null) out.set(r.position, r.containerNumber);
    return out;
  }

  /**
   * Автозаведение узлов по составу (R-PU-3). Идемпотентно по (автомат, вид,
   * слот): повторный прогон ничего не дублирует. Номера присваивает система,
   * наклейка — за сотрудником (очередь «Наклеить номер»). Бункер с известным
   * набором получает номер H-<набор>-<позиция> и тару из матрицы; если такой
   * бункер уже заведён и свободен — ставится он, а не дубль.
   */
  async provision(input: ProvisionInput = {}): Promise<ProvisionReport> {
    const template = await this.coffeeTemplate();
    const actorRef = input.actorRef ?? "owner";
    const machines = await this.db
      .select({ id: entity.id, name: entity.name })
      .from(machineCard)
      .innerJoin(entity, eq(entity.id, machineCard.entityId))
      .where(
        and(
          eq(machineCard.kind, "coffee"),
          ...(input.machineIds && input.machineIds.length > 0 ? [inArray(entity.id, input.machineIds)] : []),
        ),
      )
      .orderBy(asc(entity.name));

    const report: ProvisionReport = { dryRun: input.dryRun === true, template, machines: [], createdTotal: 0 };
    for (const m of machines) {
      const line = await this.db.transaction(async (tx) => {
        const open = await tx
          .select({ kind: machinePart.partKind, slot: machinePart.slot })
          .from(machinePart)
          .where(and(eq(machinePart.machineId, m.id), isNull(machinePart.removedOn)));
        const missing = planMissingParts(template, open);
        const sets = missing.some((x) => x.kind === "hopper") ? await this.hopperSetsOf(tx, m.id) : new Map<number, number>();
        const created: string[] = [];
        for (const slotKey of missing) {
          const hopperSet = slotKey.kind === "hopper" && slotKey.slot !== null ? sets.get(slotKey.slot) : undefined;
          let unit: PartUnitRow | null = null;
          let closeOffMachine: string | null = null;
          let setTaken = false;
          if (hopperSet !== undefined) {
            // Бункер набора: уже заведён? Свободный (лежит на складе/мойке или
            // без периода) ставим его; стоящий на другом автомате — набор
            // занят, заводим бункер без набора, чтобы не выдумать дубль.
            const [existing] = await tx
              .select()
              .from(partUnit)
              .where(and(eq(partUnit.setNumber, hopperSet), eq(partUnit.hopperPosition, slotKey.slot!), isNull(partUnit.retiredAt)))
              .limit(1);
            if (existing) {
              const [open] = await tx
                .select({ id: machinePart.id, machineId: machinePart.machineId })
                .from(machinePart)
                .where(and(eq(machinePart.partUnitId, existing.id), isNull(machinePart.removedOn)))
                .limit(1);
              if (open?.machineId) setTaken = true;
              else {
                unit = existing;
                closeOffMachine = open?.id ?? null;
              }
            }
          }
          if (input.dryRun) {
            created.push(
              unit
                ? `${partUnitLabel(unit)} (уже заведён, свободен — будет поставлен)`
                : `${partLabel(slotKey.kind)}${slotKey.slot !== null ? ` №${slotKey.slot}` : ""}${hopperSet !== undefined ? ` · набор ${hopperSet}` : ""}`,
            );
            continue;
          }
          if (!unit) {
            let tare: number | null = null;
            if (hopperSet !== undefined && !setTaken) {
              const [t] = await tx
                .select({ tareWeight: coffeeContainerTare.tareWeight })
                .from(coffeeContainerTare)
                .where(and(eq(coffeeContainerTare.containerNumber, hopperSet), eq(coffeeContainerTare.position, slotKey.slot!)))
                .limit(1);
              tare = t?.tareWeight ?? null;
            }
            const view = await this.create(
              {
                partKind: slotKey.kind,
                ...(hopperSet !== undefined && !setTaken ? { setNumber: hopperSet, hopperPosition: slotKey.slot! } : {}),
                ...(tare !== null ? { tareWeight: tare } : {}),
                origin: "auto",
                labelPending: true,
                note: setTaken
                  ? `заведено автоматически по составу автомата; бункер набора ${hopperSet} стоит на другом автомате — набор не присвоен`
                  : "заведено автоматически по составу автомата",
                createdBy: actorRef,
              },
              tx,
            );
            unit = view;
          }
          if (closeOffMachine) {
            await tx
              .update(machinePart)
              .set({ removedOn: todayInTz(), note: "закрыт автозаведением: узел поставлен на автомат по составу" })
              .where(eq(machinePart.id, closeOffMachine));
          }
          await tx.insert(machinePart).values({
            partUnitId: unit.id,
            machineId: m.id,
            location: "machine",
            partKind: slotKey.kind,
            slot: slotKey.slot,
            serialNumber: unit.serialNumber,
            model: unit.model,
            installedOn: todayInTz(),
            warrantyUntil: unit.warrantyUntil,
            note: "период открыт автозаведением по составу автомата",
            createdBy: actorRef,
          });
          created.push(partUnitLabel(unit));
        }
        return {
          machineId: m.id,
          machineName: m.name,
          created,
          existing: open.length,
          hopperSetsFound: sets.size,
        } satisfies ProvisionMachineReport;
      });
      report.machines.push(line);
      report.createdTotal += line.created.length;
    }
    if (!input.dryRun && report.createdTotal > 0) {
      await this.db.insert(auditLog).values({
        actorKind: actorKindOf(actorRef),
        actorRef,
        action: "parts.provisioned",
        target: "machine_card:coffee",
        after: { createdTotal: report.createdTotal, machines: report.machines.length },
      });
    }
    return report;
  }

  /** Записи журнала по узлу — мойки, ремонты, снятия. */
  async logs(id: string): Promise<(typeof maintenanceLog.$inferSelect)[]> {
    return this.db
      .select()
      .from(maintenanceLog)
      .where(eq(maintenanceLog.partUnitId, id))
      .orderBy(desc(maintenanceLog.performedOn), desc(maintenanceLog.performedAt))
      .limit(100);
  }
}
