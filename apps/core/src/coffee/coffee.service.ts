import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  coffeeBunkerConfig,
  coffeeConsumable,
  coffeeContainerTare,
  coffeeIngredient,
  coffeeLocation,
  coffeeProduct,
  coffeeRefill,
  coffeeSale,
  coffeeWashLog,
} from "@mydon/db";
import {
  buildLocationSummary,
  consumedSince,
  consumptionReport,
  costOf,
  fillStatus,
  netWeight,
  reconcileConsumption,
  type LatestRefillRow,
  type ReconcileResult,
  type RecipeLine,
} from "@mydon/shared";
import { DB, type Db } from "../db/db.module";

/**
 * Кофе-бункеры: ручные кофемашины на точках владельца (Ourvend их не видит).
 * Модель и расчёт сверены с рабочим референс-приложением владельца
 * (vendhubunker) и портированы с трёх независимых доноров — см.
 * `packages/db/src/schema.ts` (раздел «Кофе-вендинг») и `coffee-calc.ts`.
 */

export interface LocationRow {
  id: string;
  name: string;
  isActive: boolean;
}

export interface BunkerIngredientRow {
  position: number;
  ingredientId: string;
  ingredientName: string;
  /** Закупочная цена за грамм, сум. null — не заведена, себестоимость расхода не считается. */
  purchasePrice: number | null;
  /** Эталонный чистый вес заливки, г. null — не задан, недолив не проверяется. */
  targetFillWeight: number | null;
}

export interface FillStatusRow {
  locationId: string;
  locationName: string;
  position: number;
  ingredientId: string | null;
  ingredientName: string | null;
  netFillWeight: number | null;
  targetFillWeight: number | null;
  status: "ok" | "underfill" | "unknown";
  fillRatio: number | null;
}

export interface SubmitRefillInput {
  locationId: string;
  position: number;
  containerNumber?: number;
  ingredientId?: string;
  filledWeight: number;
  measuredBefore?: number;
  packageCount?: number;
  enteredDate: string; // ISO date, «Дата» из формы
  createdBy?: string;
}

export interface RefillRow {
  id: string;
  locationId: string;
  locationName: string;
  position: number;
  containerNumber: number | null;
  ingredientId: string | null;
  filledWeight: number;
  measuredBefore: number | null;
  packageCount: number;
  enteredDate: string;
  createdBy: string | null;
  createdAt: string;
}

export interface ConsumableInput {
  locationId: string;
  loggedDate: string;
  water?: number;
  cups?: number;
  lids?: number;
  createdBy?: string;
}

export interface RecordWashInput {
  locationId: string;
  position?: number;
  kind?: "wash" | "clean" | "replace" | "service";
  note?: string;
  performedBy?: string;
}

export interface RecordSaleInput {
  locationId: string;
  productId: string;
  loggedDate: string;
  quantity: number;
  createdBy?: string;
}

@Injectable()
export class CoffeeService {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ── Точки ──────────────────────────────────────────────────────────────

  async locations(): Promise<LocationRow[]> {
    const rows = await this.db.select().from(coffeeLocation).orderBy(asc(coffeeLocation.sortOrder));
    return rows.map((r) => ({ id: r.id, name: r.name, isActive: r.isActive }));
  }

  // ── Настройки: ингредиенты по позициям бункера ────────────────────────

  /** Позиция 1–8 → допустимые ингредиенты (список тегов, не 1:1 — см. schema.ts). */
  async bunkerConfig(): Promise<BunkerIngredientRow[]> {
    const rows = await this.db
      .select({
        position: coffeeBunkerConfig.position,
        ingredientId: coffeeIngredient.id,
        ingredientName: coffeeIngredient.name,
        purchasePrice: coffeeIngredient.purchasePrice,
        targetFillWeight: coffeeBunkerConfig.targetFillWeight,
      })
      .from(coffeeBunkerConfig)
      .innerJoin(coffeeIngredient, eq(coffeeBunkerConfig.ingredientId, coffeeIngredient.id))
      .orderBy(asc(coffeeBunkerConfig.position));
    return rows.map((r) => ({ ...r, purchasePrice: r.purchasePrice != null ? Number(r.purchasePrice) : null }));
  }

  /** Проставить/поправить закупочную цену ингредиента (сум за грамм) — для себестоимости расхода. */
  async setIngredientPrice(ingredientId: string, purchasePrice: number): Promise<{ ok: true }> {
    await this.db.update(coffeeIngredient).set({ purchasePrice: purchasePrice.toString() }).where(eq(coffeeIngredient.id, ingredientId));
    return { ok: true };
  }

  /** Проставить/поправить эталонный чистый вес заливки (недолив-сигнал) для (позиция, ингредиент). */
  async setTargetFillWeight(position: number, ingredientId: string, targetFillWeight: number): Promise<{ ok: true }> {
    await this.db
      .update(coffeeBunkerConfig)
      .set({ targetFillWeight })
      .where(and(eq(coffeeBunkerConfig.position, position), eq(coffeeBunkerConfig.ingredientId, ingredientId)));
    return { ok: true };
  }

  /** Добавить ингредиент в позицию («+ Добавить» в Настройках). Заводит ингредиент, если его ещё нет. */
  async addBunkerIngredient(position: number, ingredientName: string): Promise<{ ingredientId: string }> {
    const name = ingredientName.trim();
    const existing = await this.db.select({ id: coffeeIngredient.id }).from(coffeeIngredient).where(eq(coffeeIngredient.name, name));
    let ingredientId = existing[0]?.id;
    if (!ingredientId) {
      const inserted = await this.db.insert(coffeeIngredient).values({ name }).returning({ id: coffeeIngredient.id });
      ingredientId = inserted[0]!.id;
    }
    await this.db
      .insert(coffeeBunkerConfig)
      .values({ position, ingredientId })
      .onConflictDoNothing({ target: [coffeeBunkerConfig.position, coffeeBunkerConfig.ingredientId] });
    return { ingredientId };
  }

  /**
   * Убрать ингредиент из позиции (крестик «×» в Настройках). Отдаёт `{ ok: true }`,
   * а не пустое тело — клиент панели (`send<T>()`) на успехе всегда парсит JSON,
   * пустой ответ уронил бы его исключением `Unexpected end of JSON input`.
   */
  async removeBunkerIngredient(position: number, ingredientId: string): Promise<{ ok: true }> {
    await this.db
      .delete(coffeeBunkerConfig)
      .where(and(eq(coffeeBunkerConfig.position, position), eq(coffeeBunkerConfig.ingredientId, ingredientId)));
    return { ok: true };
  }

  // ── Настройки: тара контейнеров (27 наборов × 8 позиций) ───────────────

  /** Полная матрица тары — «Веса бункеров» в Настройках. Пусто в ячейке — не откалибровано. */
  async tareGrid(): Promise<{ containerNumber: number; position: number; tareWeight: number | null }[]> {
    const rows = await this.db
      .select({
        containerNumber: coffeeContainerTare.containerNumber,
        position: coffeeContainerTare.position,
        tareWeight: coffeeContainerTare.tareWeight,
      })
      .from(coffeeContainerTare);
    return rows;
  }

  /** Проставить/поправить тару одной ячейки. */
  async setTare(containerNumber: number, position: number, tareWeight: number): Promise<{ ok: true }> {
    await this.db
      .insert(coffeeContainerTare)
      .values({ containerNumber, position, tareWeight })
      .onConflictDoUpdate({
        target: [coffeeContainerTare.containerNumber, coffeeContainerTare.position],
        set: { tareWeight },
      });
    return { ok: true };
  }

  private async tareByKey(): Promise<Map<string, number>> {
    const rows = await this.tareGrid();
    const out = new Map<string, number>();
    for (const r of rows) if (r.tareWeight != null) out.set(`${r.containerNumber}:${r.position}`, r.tareWeight);
    return out;
  }

  // ── Ввод данных: ежедневная заливка ─────────────────────────────────────

  /** Занести заливку бункера («Сохранить» в «Ввод данных»). */
  async submitRefill(input: SubmitRefillInput): Promise<{ id: string }> {
    const [row] = await this.db
      .insert(coffeeRefill)
      .values({
        locationId: input.locationId,
        position: input.position,
        containerNumber: input.containerNumber ?? null,
        ingredientId: input.ingredientId ?? null,
        filledWeight: input.filledWeight,
        measuredBefore: input.measuredBefore ?? null,
        packageCount: input.packageCount ?? 1,
        enteredDate: input.enteredDate,
        createdBy: input.createdBy ?? null,
      })
      .returning({ id: coffeeRefill.id });
    return { id: row!.id };
  }

  /** Последние N заливок — «История ввода». */
  async recentRefills(limit = 20): Promise<RefillRow[]> {
    const rows = await this.db
      .select({
        id: coffeeRefill.id,
        locationId: coffeeRefill.locationId,
        locationName: coffeeLocation.name,
        position: coffeeRefill.position,
        containerNumber: coffeeRefill.containerNumber,
        ingredientId: coffeeRefill.ingredientId,
        filledWeight: coffeeRefill.filledWeight,
        measuredBefore: coffeeRefill.measuredBefore,
        packageCount: coffeeRefill.packageCount,
        enteredDate: coffeeRefill.enteredDate,
        createdBy: coffeeRefill.createdBy,
        createdAt: coffeeRefill.createdAt,
      })
      .from(coffeeRefill)
      .innerJoin(coffeeLocation, eq(coffeeRefill.locationId, coffeeLocation.id))
      .orderBy(desc(coffeeRefill.createdAt))
      .limit(Math.min(Math.max(limit, 1), 200));
    return rows.map((r) => ({ ...r, enteredDate: String(r.enteredDate), createdAt: r.createdAt.toISOString() }));
  }

  /**
   * Сводная таблица «Таблица»: последняя заливка на (точка, позиция) —
   * упаковки + вес. Каждая активная точка присутствует, даже без заливок.
   */
  async locationSummary() {
    const [locations, rows] = await Promise.all([
      this.locations(),
      this.db
        .select({
          locationName: coffeeLocation.name,
          position: coffeeRefill.position,
          packageCount: coffeeRefill.packageCount,
          filledWeight: coffeeRefill.filledWeight,
          enteredDate: coffeeRefill.enteredDate,
        })
        .from(coffeeRefill)
        .innerJoin(coffeeLocation, eq(coffeeRefill.locationId, coffeeLocation.id))
        .orderBy(asc(coffeeRefill.enteredDate)),
    ]);

    // Последняя заливка на (locationName, position) — берём по порядку возрастания
    // даты и перезаписываем: то же правило, что и в vending stockByProduct.
    const latestByKey = new Map<string, LatestRefillRow>();
    for (const r of rows) {
      latestByKey.set(`${r.locationName}:${r.position}`, {
        locationName: r.locationName,
        position: r.position,
        packageCount: r.packageCount,
        filledWeight: r.filledWeight,
      });
    }
    return buildLocationSummary(
      locations.map((l) => l.name),
      [...latestByKey.values()],
    );
  }

  /**
   * Недолив по последней заливке на (точка, позиция): сравнивает чистый вес
   * (`netWeight()`) с эталоном для (позиция, ингредиент этой заливки) —
   * `coffee_bunker_config.targetFillWeight`. Нет эталона/тары/ингредиента у
   * заливки — `status: "unknown"`, а не молчаливый `ok` (см. `fillStatus()`).
   */
  async fillStatusByLocation(): Promise<FillStatusRow[]> {
    const [rows, tareByKey, config] = await Promise.all([
      this.db
        .select({
          locationId: coffeeRefill.locationId,
          locationName: coffeeLocation.name,
          position: coffeeRefill.position,
          ingredientId: coffeeRefill.ingredientId,
          containerNumber: coffeeRefill.containerNumber,
          filledWeight: coffeeRefill.filledWeight,
          enteredDate: coffeeRefill.enteredDate,
        })
        .from(coffeeRefill)
        .innerJoin(coffeeLocation, eq(coffeeRefill.locationId, coffeeLocation.id))
        .orderBy(asc(coffeeRefill.enteredDate)),
      this.tareByKey(),
      this.bunkerConfig(),
    ]);

    // Последняя заливка на (точка, позиция) — тот же приём, что в locationSummary().
    const latestByKey = new Map<string, (typeof rows)[number]>();
    for (const r of rows) latestByKey.set(`${r.locationId}:${r.position}`, r);

    const targetByKey = new Map(config.map((c) => [`${c.position}:${c.ingredientId}`, c.targetFillWeight]));
    const nameById = new Map(config.map((c) => [c.ingredientId, c.ingredientName]));

    return [...latestByKey.values()].map((r) => {
      const netFillWeight = netWeight(r.filledWeight, tareByKey.get(`${r.containerNumber}:${r.position}`) ?? null);
      const targetFillWeight = r.ingredientId ? (targetByKey.get(`${r.position}:${r.ingredientId}`) ?? null) : null;
      const fs = fillStatus(netFillWeight, targetFillWeight);
      return {
        locationId: r.locationId,
        locationName: r.locationName,
        position: r.position,
        ingredientId: r.ingredientId,
        ingredientName: r.ingredientId ? (nameById.get(r.ingredientId) ?? null) : null,
        netFillWeight,
        targetFillWeight,
        status: fs.status,
        fillRatio: fs.fillRatio,
      };
    });
  }

  // ── Расходники: вода/стаканчики/крышки ──────────────────────────────────

  /** Занести/поправить расход за день по точке (upsert по (точка, дата)). */
  async recordConsumable(input: ConsumableInput): Promise<{ ok: true }> {
    await this.db
      .insert(coffeeConsumable)
      .values({
        locationId: input.locationId,
        loggedDate: input.loggedDate,
        water: input.water ?? 0,
        cups: input.cups ?? 0,
        lids: input.lids ?? 0,
        createdBy: input.createdBy ?? null,
      })
      .onConflictDoUpdate({
        target: [coffeeConsumable.locationId, coffeeConsumable.loggedDate],
        set: { water: input.water ?? 0, cups: input.cups ?? 0, lids: input.lids ?? 0, updatedAt: new Date() },
      });
    return { ok: true };
  }

  /** Последний известный расходник по каждой точке — «Капсула и крышки». */
  async consumablesSummary(): Promise<{ location: string; water: number; cups: number; lids: number }[]> {
    const [locations, rows] = await Promise.all([
      this.locations(),
      this.db
        .select({
          locationName: coffeeLocation.name,
          water: coffeeConsumable.water,
          cups: coffeeConsumable.cups,
          lids: coffeeConsumable.lids,
          loggedDate: coffeeConsumable.loggedDate,
        })
        .from(coffeeConsumable)
        .innerJoin(coffeeLocation, eq(coffeeConsumable.locationId, coffeeLocation.id))
        .orderBy(asc(coffeeConsumable.loggedDate)),
    ]);
    const latest = new Map<string, { water: number; cups: number; lids: number }>();
    for (const r of rows) latest.set(r.locationName, { water: r.water, cups: r.cups, lids: r.lids });
    return locations.map((l) => ({ location: l.name, ...(latest.get(l.name) ?? { water: 0, cups: 0, lids: 0 }) }));
  }

  // ── Мойка/обслуживание ───────────────────────────────────────────────────

  async recordWash(input: RecordWashInput): Promise<{ id: string }> {
    const [row] = await this.db
      .insert(coffeeWashLog)
      .values({
        locationId: input.locationId,
        position: input.position ?? null,
        kind: input.kind ?? "wash",
        note: input.note ?? null,
        performedBy: input.performedBy ?? null,
      })
      .returning({ id: coffeeWashLog.id });
    return { id: row!.id };
  }

  async washHistory(locationId?: string, limit = 50) {
    const rows = await this.db
      .select({
        id: coffeeWashLog.id,
        locationId: coffeeWashLog.locationId,
        locationName: coffeeLocation.name,
        position: coffeeWashLog.position,
        kind: coffeeWashLog.kind,
        note: coffeeWashLog.note,
        performedBy: coffeeWashLog.performedBy,
        performedAt: coffeeWashLog.performedAt,
      })
      .from(coffeeWashLog)
      .innerJoin(coffeeLocation, eq(coffeeWashLog.locationId, coffeeLocation.id))
      .where(locationId ? eq(coffeeWashLog.locationId, locationId) : undefined)
      .orderBy(desc(coffeeWashLog.performedAt))
      .limit(Math.min(Math.max(limit, 1), 200));
    return rows.map((r) => ({ ...r, performedAt: r.performedAt.toISOString() }));
  }

  // ── Товары/рецепты и продажи (для сверки факт/ожидание) ─────────────────

  async products(): Promise<{ id: string; name: string; recipe: RecipeLine[] }[]> {
    const rows = await this.db.select().from(coffeeProduct).where(eq(coffeeProduct.isActive, true));
    return rows.map((r) => ({ id: r.id, name: r.name, recipe: (r.recipe as RecipeLine[]) ?? [] }));
  }

  async upsertProduct(name: string, recipe: RecipeLine[]): Promise<{ id: string }> {
    const existing = await this.db.select({ id: coffeeProduct.id }).from(coffeeProduct).where(eq(coffeeProduct.name, name));
    if (existing[0]) {
      await this.db.update(coffeeProduct).set({ recipe }).where(eq(coffeeProduct.id, existing[0].id));
      return { id: existing[0].id };
    }
    const [row] = await this.db.insert(coffeeProduct).values({ name, recipe }).returning({ id: coffeeProduct.id });
    return { id: row!.id };
  }

  /** Занести проданные чашки за день (upsert по точка/товар/дата) — ручной ввод, POS нет. */
  async recordSale(input: RecordSaleInput): Promise<void> {
    await this.db
      .insert(coffeeSale)
      .values({
        locationId: input.locationId,
        productId: input.productId,
        loggedDate: input.loggedDate,
        quantity: input.quantity,
        createdBy: input.createdBy ?? null,
      })
      .onConflictDoUpdate({
        target: [coffeeSale.locationId, coffeeSale.productId, coffeeSale.loggedDate],
        set: { quantity: input.quantity, updatedAt: new Date() },
      });
  }

  /**
   * Сверка факта (вес бункеров) и ожидания (продажи × рецепт) по ингредиентам
   * точки за период. Возвращает только то, что реально удалось посчитать —
   * без пары «продажи+рецепт» и «две заливки подряд одного ингредиента» по
   * позиции сверка для неё не строится (status: "unknown"), а не подделывается.
   *
   * Себестоимость (`costActual`/`costExpected`) — грамм × `coffee_ingredient.
   * purchasePrice` (сум за грамм). Цена не заведена — `null`, а не 0: непосчитанную
   * себестоимость нельзя выдавать за нулевую (тот же принцип, что у `recipeCost()`).
   */
  async reconcileLocation(
    locationId: string,
    fromDate: string,
    toDate: string,
  ): Promise<
    {
      ingredientId: string;
      ingredientName: string;
      actualGrams: number | null;
      expectedGrams: number | null;
      costActual: number | null;
      costExpected: number | null;
      reconcile: ReconcileResult;
    }[]
  > {
    const [refills, salesRows, products, ingredients, tareByKey] = await Promise.all([
      this.db
        .select()
        .from(coffeeRefill)
        .where(eq(coffeeRefill.locationId, locationId))
        .orderBy(asc(coffeeRefill.position), asc(coffeeRefill.enteredDate), asc(coffeeRefill.createdAt)),
      this.db.select().from(coffeeSale).where(eq(coffeeSale.locationId, locationId)),
      this.products(),
      this.db.select().from(coffeeIngredient),
      this.tareByKey(),
    ]);
    const salesInRange = salesRows.filter((s) => s.loggedDate >= fromDate && s.loggedDate <= toDate);

    // Фактический расход по ингредиенту: идём по каждой позиции, сравниваем
    // последовательные заливки ОДНОГО и того же ингредиента (см. docstring).
    const actualByIngredient = new Map<string, number>();
    const byPosition = new Map<number, typeof refills>();
    for (const r of refills) byPosition.set(r.position, [...(byPosition.get(r.position) ?? []), r]);
    for (const [, list] of byPosition) {
      for (let i = 1; i < list.length; i++) {
        const prev = list[i - 1]!;
        const curr = list[i]!;
        if (curr.enteredDate < fromDate || curr.enteredDate > toDate) continue;
        if (!curr.ingredientId || curr.ingredientId !== prev.ingredientId) continue;
        if (curr.measuredBefore == null) continue;
        const prevNet = netWeight(prev.filledWeight, tareByKey.get(`${prev.containerNumber}:${prev.position}`) ?? null);
        const currNet = netWeight(curr.measuredBefore, tareByKey.get(`${curr.containerNumber}:${curr.position}`) ?? null);
        const consumed = consumedSince(prevNet, currNet);
        if (consumed == null) continue;
        actualByIngredient.set(curr.ingredientId, (actualByIngredient.get(curr.ingredientId) ?? 0) + consumed);
      }
    }

    // Цена за грамм — по canonical-ингредиенту; нет цены → null (не 0).
    const priceByIngredient = new Map(
      ingredients.map((i) => [i.id, i.purchasePrice != null ? Number(i.purchasePrice) : null]),
    );

    // Ожидаемый расход: продажи периода × состав товара. priceOf отдаёт ту же
    // цену за грамм — consumptionReport() сам считает себестоимость строки.
    const sold = salesInRange.map((s) => ({ productId: s.productId, qty: s.quantity }));
    const recipeById = new Map(products.map((p) => [p.id, p.recipe]));
    const report = consumptionReport(
      sold,
      (productId) => recipeById.get(productId) ?? [],
      (ingredientId) => ({ price: priceByIngredient.get(ingredientId) ?? null, unit: "г" }),
    );
    const expectedByIngredient = new Map(report.ingredients.map((i) => [i.ingredientId, i.consumed]));
    const expectedCostByIngredient = new Map(report.ingredients.map((i) => [i.ingredientId, i.cost]));

    const ingredientIds = new Set([...actualByIngredient.keys(), ...expectedByIngredient.keys()]);
    const nameById = new Map(ingredients.map((i) => [i.id, i.name]));
    return [...ingredientIds].map((ingredientId) => {
      const actualGrams = actualByIngredient.get(ingredientId) ?? null;
      const expectedGrams = expectedByIngredient.get(ingredientId) ?? null;
      return {
        ingredientId,
        ingredientName: nameById.get(ingredientId) ?? ingredientId,
        actualGrams,
        expectedGrams,
        costActual: costOf(actualGrams, priceByIngredient.get(ingredientId) ?? null),
        costExpected: expectedCostByIngredient.get(ingredientId) ?? null,
        reconcile: reconcileConsumption(actualGrams, expectedGrams),
      };
    });
  }
}
