import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { auditLog, coffeeContainerReturn, coffeeContainerTare, coffeeIngredient, coffeeRefill, entity, partUnit } from "@mydon/db";
import { and, desc, eq, isNull, lte, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { StockService } from "../stock/stock.service";
import { settingValue } from "../system/settings";

/**
 * Кофе ↔ складской леджер (спека vendhub-parts, R-PU-9, У5).
 *
 * Возврат бункера — это приход: нетто = брутто − тара узла; движение `return`
 * партией «возврат из бункера H-27-1», открытой сегодня. Заливка — это
 * расход: списывается только то, что известно точно (пачки × вес пачки или
 * «после − до»); без данных заливка помечается, а не «примерно списывается».
 * Отдельный сервис, а не метод CoffeeService: у того нет зависимости от
 * склада, и его тесты строятся без неё.
 */

export interface RecordReturnInput {
  position: number;
  containerNumber: number;
  weight: number;
  returnedDate: string;
  locationNote?: string;
  createdBy?: string;
}

export type ReturnPostingReason =
  | "нет тары"
  | "брутто меньше тары"
  | "остаток нулевой"
  | "ингредиент неизвестен"
  | "у ингредиента нет карточки склада"
  | "склад приёма не выбран";

export interface ContainerReturnResult {
  id: string;
  replay: boolean;
  partUnitId: string | null;
  unitLabel: string | null;
  tare: number | null;
  netWeight: number | null;
  ingredientId: string | null;
  ingredientName: string | null;
  /** Приход проведён — id движения `return`. */
  stockMovementId: string | null;
  /** Почему приход не проведён (NULL — проведён). */
  reason: ReturnPostingReason | null;
}

export interface RefillConsumptionResult {
  refillId: string;
  consumed: boolean;
  qty: number | null;
  /** Как посчитано: пачки × вес пачки или «после − до». */
  how: "packages" | "weights" | null;
  stockMovementId: string | null;
  reason: string | null;
}

@Injectable()
export class CoffeeLedgerService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly stock: StockService,
  ) {}

  /** Узел-бункер по (набор, позиция) — карточка с тарой. */
  private async hopperUnit(containerNumber: number, position: number) {
    const [unit] = await this.db
      .select()
      .from(partUnit)
      .where(and(eq(partUnit.partKind, "hopper"), eq(partUnit.setNumber, containerNumber), eq(partUnit.hopperPosition, position), isNull(partUnit.retiredAt)))
      .limit(1);
    return unit ?? null;
  }

  /** Тара: с карточки узла; нет — из матрицы 27×8, и тогда переносится на карточку (матрица — источник до У5). */
  private async tareOf(unit: typeof partUnit.$inferSelect | null, containerNumber: number, position: number): Promise<number | null> {
    if (unit?.tareWeight != null) return unit.tareWeight;
    const [cell] = await this.db
      .select({ tareWeight: coffeeContainerTare.tareWeight })
      .from(coffeeContainerTare)
      .where(and(eq(coffeeContainerTare.containerNumber, containerNumber), eq(coffeeContainerTare.position, position)))
      .limit(1);
    const tare = cell?.tareWeight ?? null;
    if (tare != null && unit) {
      await this.db.update(partUnit).set({ tareWeight: tare, updatedAt: new Date() }).where(and(eq(partUnit.id, unit.id), isNull(partUnit.tareWeight)));
    }
    return tare;
  }

  /** Что было в бункере: последняя заливка этого набора на этой позиции не позже даты возврата. */
  private async pairedIngredient(containerNumber: number, position: number, returnedDate: string) {
    const [refill] = await this.db
      .select({ ingredientId: coffeeRefill.ingredientId })
      .from(coffeeRefill)
      .where(and(eq(coffeeRefill.containerNumber, containerNumber), eq(coffeeRefill.position, position), lte(coffeeRefill.enteredDate, returnedDate)))
      .orderBy(desc(coffeeRefill.enteredDate), desc(coffeeRefill.createdAt))
      .limit(1);
    if (!refill?.ingredientId) return null;
    const [ing] = await this.db
      .select({ id: coffeeIngredient.id, name: coffeeIngredient.name, entityId: coffeeIngredient.entityId, packageWeight: coffeeIngredient.packageWeight })
      .from(coffeeIngredient)
      .where(eq(coffeeIngredient.id, refill.ingredientId))
      .limit(1);
    return ing ?? null;
  }

  private unitLabelOf(unit: typeof partUnit.$inferSelect | null, containerNumber: number, position: number): string {
    return unit?.inventoryNo ?? `H-${containerNumber}-${position}`;
  }

  /**
   * Возврат набора с приходом на склад. Дедуп по содержимому (та же четвёрка
   * за тот же день — та же строка): у сообщений из группы нет clientKey.
   */
  async recordContainerReturn(input: RecordReturnInput): Promise<ContainerReturnResult> {
    const [dup] = await this.db
      .select()
      .from(coffeeContainerReturn)
      .where(
        and(
          eq(coffeeContainerReturn.position, input.position),
          eq(coffeeContainerReturn.containerNumber, input.containerNumber),
          eq(coffeeContainerReturn.weight, input.weight),
          eq(coffeeContainerReturn.returnedDate, input.returnedDate),
        ),
      )
      .limit(1);
    const unit = await this.hopperUnit(input.containerNumber, input.position);
    const unitLabel = this.unitLabelOf(unit, input.containerNumber, input.position);
    if (dup) {
      return {
        id: dup.id,
        replay: true,
        partUnitId: dup.partUnitId,
        unitLabel,
        tare: dup.netWeight != null ? dup.weight - dup.netWeight : null,
        netWeight: dup.netWeight,
        ingredientId: dup.ingredientId,
        ingredientName: null,
        stockMovementId: dup.stockMovementId,
        reason: dup.stockMovementId ? null : dup.netWeight == null ? "нет тары" : "ингредиент неизвестен",
      };
    }

    const tare = await this.tareOf(unit, input.containerNumber, input.position);
    const ingredient = await this.pairedIngredient(input.containerNumber, input.position, input.returnedDate);
    let netWeight: number | null = null;
    let reason: ReturnPostingReason | null = null;
    if (tare == null) reason = "нет тары";
    else if (input.weight < tare) reason = "брутто меньше тары";
    else {
      netWeight = input.weight - tare;
      if (netWeight === 0) reason = "остаток нулевой";
      else if (!ingredient) reason = "ингредиент неизвестен";
      else if (!ingredient.entityId) reason = "у ингредиента нет карточки склада";
    }

    let stockMovementId: string | null = null;
    if (reason === null && netWeight != null && ingredient?.entityId) {
      const warehouseId = await this.stock.defaultWarehouseId();
      if (!warehouseId) reason = "склад приёма не выбран";
      else {
        const posted = await this.stock.returnToStock({
          ingredientId: ingredient.entityId,
          warehouseId,
          qty: netWeight,
          unit: "г",
          dt: input.returnedDate,
          batchCode: `возврат из бункера ${unitLabel}`,
          note: `возврат бункера ${unitLabel} ${input.returnedDate}: брутто ${input.weight} − тара ${tare}`,
          clientKey: `coffee-return:${input.containerNumber}:${input.position}:${input.returnedDate}:${input.weight}`,
          createdBy: input.createdBy ?? "owner",
        });
        stockMovementId = posted.movement.id;
      }
    }

    const [row] = await this.db
      .insert(coffeeContainerReturn)
      .values({
        position: input.position,
        containerNumber: input.containerNumber,
        weight: input.weight,
        returnedDate: input.returnedDate,
        locationNote: input.locationNote ?? null,
        partUnitId: unit?.id ?? null,
        ingredientId: ingredient?.id ?? null,
        netWeight,
        stockMovementId,
        createdBy: input.createdBy ?? null,
      })
      .returning({ id: coffeeContainerReturn.id });
    return {
      id: row!.id,
      replay: false,
      partUnitId: unit?.id ?? null,
      unitLabel,
      tare,
      netWeight,
      ingredientId: ingredient?.id ?? null,
      ingredientName: ingredient?.name ?? null,
      stockMovementId,
      reason,
    };
  }

  /** Удалить ошибочный возврат вместе с его приходом (строка целиком уходит в audit_log). */
  async deleteContainerReturn(id: string, opts: { actor?: string; onlyIfCreatedBy?: string } = {}): Promise<{ ok: true }> {
    const [row] = await this.db.select().from(coffeeContainerReturn).where(eq(coffeeContainerReturn.id, id));
    if (!row) throw new NotFoundException(`Возврат ${id} не найден`);
    if (opts.onlyIfCreatedBy !== undefined && row.createdBy !== opts.onlyIfCreatedBy) {
      throw new BadRequestException("Это не твоя запись — её может удалить только автор или владелец в панели");
    }
    await this.db.delete(coffeeContainerReturn).where(eq(coffeeContainerReturn.id, id));
    if (row.stockMovementId) await this.stock.removeReturn(row.stockMovementId);
    await this.db.insert(auditLog).values({
      actorKind: "human",
      actorRef: opts.actor ?? "owner",
      action: "coffee.container_return_deleted",
      target: id,
      before: row,
    });
    return { ok: true };
  }

  /** Возвраты без прихода — «без тары» и прочие причины, чтобы владелец их закрыл. */
  async unpostedReturns(limit = 100): Promise<
    { id: string; position: number; containerNumber: number; weight: number; returnedDate: string; partUnitId: string | null; unitLabel: string; reason: ReturnPostingReason | "не проведён (до среза)" }[]
  > {
    const rows = await this.db
      .select({ r: coffeeContainerReturn, inventoryNo: partUnit.inventoryNo, tare: partUnit.tareWeight })
      .from(coffeeContainerReturn)
      .leftJoin(partUnit, eq(partUnit.id, coffeeContainerReturn.partUnitId))
      .where(isNull(coffeeContainerReturn.stockMovementId))
      .orderBy(desc(coffeeContainerReturn.returnedDate), desc(coffeeContainerReturn.createdAt))
      .limit(Math.min(Math.max(limit, 1), 500));
    return rows.map(({ r, inventoryNo, tare }) => ({
      id: r.id,
      position: r.position,
      containerNumber: r.containerNumber,
      weight: r.weight,
      returnedDate: r.returnedDate,
      partUnitId: r.partUnitId,
      unitLabel: inventoryNo ?? `H-${r.containerNumber}-${r.position}`,
      reason:
        r.partUnitId === null && r.netWeight === null && r.ingredientId === null
          ? "не проведён (до среза)"
          : r.netWeight === null
            ? tare == null
              ? "нет тары"
              : "брутто меньше тары"
            : r.netWeight === 0
              ? "остаток нулевой"
              : r.ingredientId === null
                ? "ингредиент неизвестен"
                : "у ингредиента нет карточки склада",
    }));
  }

  /**
   * Списание заливки со склада (тумблер COFFEE_REFILL_CONSUMES). Считаем
   * только то, что известно точно: пачки × вес пачки, иначе «после − до».
   * Ни того ни другого — помечаем, не списываем: примерный расход хуже
   * отсутствующего, он выглядит как факт.
   */
  async consumeRefill(refillId: string, actorRef = "owner"): Promise<RefillConsumptionResult> {
    const off = (await settingValue(this.db, "COFFEE_REFILL_CONSUMES")).trim() === "0";
    const [refill] = await this.db.select().from(coffeeRefill).where(eq(coffeeRefill.id, refillId)).limit(1);
    if (!refill) throw new NotFoundException(`Заливка ${refillId} не найдена`);
    const done = (patch: Partial<RefillConsumptionResult>): RefillConsumptionResult => ({
      refillId,
      consumed: false,
      qty: null,
      how: null,
      stockMovementId: refill.stockMovementId,
      reason: null,
      ...patch,
    });
    if (refill.stockMovementId) return done({ consumed: true, stockMovementId: refill.stockMovementId });
    // Узел-бункер привязываем всегда, даже без списания: история узла — по заливкам.
    const unit = refill.containerNumber ? await this.hopperUnit(refill.containerNumber, refill.position) : null;
    if (unit && !refill.partUnitId) await this.db.update(coffeeRefill).set({ partUnitId: unit.id }).where(eq(coffeeRefill.id, refillId));
    if (off) return done({ reason: "списание заливкой выключено (COFFEE_REFILL_CONSUMES=0)" });
    if (!refill.ingredientId) return done({ reason: "ингредиент не указан" });
    const [ing] = await this.db
      .select({ name: coffeeIngredient.name, entityId: coffeeIngredient.entityId, packageWeight: coffeeIngredient.packageWeight })
      .from(coffeeIngredient)
      .where(eq(coffeeIngredient.id, refill.ingredientId))
      .limit(1);
    if (!ing) return done({ reason: "ингредиент не найден" });

    let qty: number | null = null;
    let how: "packages" | "weights" | null = null;
    if (refill.packageCount != null && refill.packageCount > 0 && ing.packageWeight != null && ing.packageWeight > 0) {
      qty = refill.packageCount * ing.packageWeight;
      how = "packages";
    } else if (refill.measuredBefore != null && refill.filledWeight > refill.measuredBefore) {
      qty = refill.filledWeight - refill.measuredBefore;
      how = "weights";
    }
    if (qty == null) return done({ reason: "нет точных данных: ни числа пачек с весом пачки, ни весов «до/после»" });
    if (!ing.entityId) return done({ qty, how, reason: "у ингредиента нет карточки склада" });
    const warehouseId = await this.stock.defaultWarehouseId();
    if (!warehouseId) return done({ qty, how, reason: "склад приёма не выбран" });

    const movement = await this.stock.createMovement({
      kind: "consumption",
      ingredientId: ing.entityId,
      warehouseId,
      dt: refill.enteredDate,
      qty,
      unit: "г",
      note: `заливка бункера ${refill.position}${refill.containerNumber ? ` · набор ${refill.containerNumber}` : ""} (${how === "packages" ? `${refill.packageCount} уп. × ${ing.packageWeight} г` : `${refill.filledWeight} − ${refill.measuredBefore}`})`,
      clientKey: `coffee-refill:${refillId}`,
      createdBy: actorRef,
    });
    await this.db.update(coffeeRefill).set({ stockMovementId: movement.id }).where(eq(coffeeRefill.id, refillId));
    return done({ consumed: true, qty, how, stockMovementId: movement.id });
  }

  /** Заливки без списания за период — для сверки «что не ушло со склада». */
  async unconsumedRefills(days = 30): Promise<{ id: string; enteredDate: string; position: number; containerNumber: number | null; filledWeight: number; measuredBefore: number | null; packageCount: number | null; locationName: string | null }[]> {
    const rows = await this.db
      .select({
        id: coffeeRefill.id,
        enteredDate: coffeeRefill.enteredDate,
        position: coffeeRefill.position,
        containerNumber: coffeeRefill.containerNumber,
        filledWeight: coffeeRefill.filledWeight,
        measuredBefore: coffeeRefill.measuredBefore,
        packageCount: coffeeRefill.packageCount,
        locationName: entity.name,
      })
      .from(coffeeRefill)
      .leftJoin(entity, eq(entity.id, coffeeRefill.locationId))
      .where(and(isNull(coffeeRefill.stockMovementId), sql`${coffeeRefill.enteredDate} >= (current_date - ${days}::int)`))
      .orderBy(desc(coffeeRefill.enteredDate))
      .limit(500);
    return rows;
  }
}
