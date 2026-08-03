import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import {
  coffeeBunkerConfig,
  coffeeConsumable,
  coffeeContainerReturn,
  coffeeContainerTare,
  coffeeIngredient,
  coffeeLocation,
  coffeeProduct,
  coffeeRefill,
  coffeeSale,
  coffeeStock,
  coffeeWashLog,
  coffeeWashSchedule,
  entity,
} from "@mydon/db";
import {
  buildLocationSummary,
  consumedSince,
  consumptionReport,
  costOf,
  fillStatus,
  netWeight,
  normalizeSourceKey,
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
  /** Карточка автомата в реестре (entity, type=machine). null — точка не привязана. */
  entityId: string | null;
  /** Имя и серийник привязанного автомата — для отображения; null без привязки. */
  machineName: string | null;
  machineRef: string | null;
}

/** Кандидат привязки: автомат из реестра с адресом точки из его карточки. */
export interface MachineCandidateRow {
  entityId: string;
  name: string;
  ref: string | null;
  point: string | null;
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

export interface ReconcileRow {
  ingredientId: string;
  ingredientName: string;
  actualGrams: number | null;
  expectedGrams: number | null;
  costActual: number | null;
  costExpected: number | null;
  reconcile: ReconcileResult;
}

export interface LocationReconcileGroup {
  locationId: string;
  locationName: string;
  rows: ReconcileRow[];
}

interface ReconcileRefillRow {
  position: number;
  containerNumber: number | null;
  filledWeight: number;
  measuredBefore: number | null;
  ingredientId: string | null;
  enteredDate: string;
  locationId: string;
}

interface ReconcileSaleRow {
  productId: string;
  quantity: number;
  loggedDate: string;
  locationId: string;
}

interface ReconcileIngredientRow {
  id: string;
  name: string;
  purchasePrice: string | null;
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

export interface IngestCoffeeStockItem {
  ingredientId: string;
  quantity: number;
}

export interface CoffeeStockAdjustment {
  ingredientId: string;
  ingredientName: string;
  before: number;
  after: number;
  delta: number;
  value: number;
  noPrice: boolean;
}

export interface CoffeeStockLevelRow {
  ingredientId: string;
  ingredientName: string;
  quantity: number;
  countedAt: string;
}

export interface RecordContainerReturnInput {
  position: number;
  containerNumber: number;
  /** Вес брутто при возврате (с тарой), г. */
  weight: number;
  returnedDate: string;
  locationNote?: string;
  createdBy?: string;
}

export interface ContainerReturnRow {
  id: string;
  position: number;
  containerNumber: number;
  weight: number;
  /** Чистый остаток: вес − тара(набор, позиция); null, если тара не заведена. */
  netWeight: number | null;
  returnedDate: string;
  locationNote: string | null;
  createdBy: string | null;
}

export interface RecordWashInput {
  locationId: string;
  position?: number;
  kind?: "wash" | "clean" | "replace" | "service";
  note?: string;
  performedBy?: string;
}

export interface SetWashScheduleInput {
  locationId: string;
  /** null/undefined — вся точка целиком. */
  position?: number | null;
  frequencyDays?: number | null;
  frequencyCups?: number | null;
  isActive?: boolean;
  notes?: string | null;
}

export interface WashScheduleRow {
  id: string;
  locationId: string;
  locationName: string;
  position: number | null;
  frequencyDays: number | null;
  frequencyCups: number | null;
  isActive: boolean;
  notes: string | null;
}

export interface WashScheduleStatusRow extends WashScheduleRow {
  lastWashAt: string | null;
  daysSinceWash: number | null;
  cupsSinceWash: number | null;
  /** Только для частоты по дням — проекция даты. По чашкам срок не календарный. */
  nextDueAt: string | null;
  status: "ok" | "overdue" | "unknown";
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
    // leftJoin, не innerJoin: непривязанные точки должны остаться в списке.
    const rows = await this.db
      .select({
        id: coffeeLocation.id,
        name: coffeeLocation.name,
        isActive: coffeeLocation.isActive,
        entityId: coffeeLocation.entityId,
        machineName: entity.name,
        machineRef: entity.externalRef,
      })
      .from(coffeeLocation)
      .leftJoin(entity, eq(coffeeLocation.entityId, entity.id))
      .orderBy(asc(coffeeLocation.sortOrder));
    return rows;
  }

  // ── Привязка точек к автоматам реестра ──────────────────────────────────
  // Кофе-точка — тот же физический автомат, что и карточка реестра (у неё
  // серийник, координаты, адрес «точка»). Постоянная связь — по id карточки;
  // имена участвуют только в автоподборе.

  /** Автоматы реестра — кандидаты привязки (id, имя, серийник, адрес точки). */
  async machineCandidates(): Promise<MachineCandidateRow[]> {
    const rows = await this.db
      .select({ id: entity.id, name: entity.name, ref: entity.externalRef, attrs: entity.attrs })
      .from(entity)
      .where(eq(entity.type, "machine"));
    return rows
      .map((m) => {
        const point = (m.attrs as Record<string, unknown>)["точка"];
        return {
          entityId: m.id,
          name: m.name,
          ref: m.ref,
          point: typeof point === "string" && point.trim().length > 0 ? point.trim() : null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, "ru"));
  }

  /** Привязать/отвязать точку от карточки автомата. entityId=null — снять связь. */
  async linkLocation(locationId: string, entityId: string | null): Promise<{ ok: true }> {
    const [loc] = await this.db.select({ id: coffeeLocation.id }).from(coffeeLocation).where(eq(coffeeLocation.id, locationId));
    if (!loc) throw new NotFoundException(`Точка ${locationId} не найдена`);
    if (entityId !== null) {
      const [card] = await this.db
        .select({ id: entity.id, type: entity.type })
        .from(entity)
        .where(eq(entity.id, entityId));
      if (!card) throw new NotFoundException(`Карточка ${entityId} не найдена`);
      if (card.type !== "machine") throw new BadRequestException("Привязать можно только карточку автомата (type=machine)");
    }
    await this.db.update(coffeeLocation).set({ entityId }).where(eq(coffeeLocation.id, locationId));
    return { ok: true };
  }

  /**
   * Автопривязка по названию: нормализованное имя точки сверяется с адресом
   * («точка» в карточке) и именем автомата. Привязывает ТОЛЬКО однозначные
   * совпадения — ноль или несколько кандидатов оставляются владельцу
   * (неоднозначность не угадывается). Уже привязанные точки не трогаются.
   */
  async autoLinkLocations(): Promise<{ linked: number; ambiguous: string[]; unmatched: string[] }> {
    const [locations, machines] = await Promise.all([this.locations(), this.machineCandidates()]);

    const candidatesByKey = new Map<string, string[]>();
    const add = (key: string, entityId: string) => {
      const list = candidatesByKey.get(key) ?? [];
      if (!list.includes(entityId)) list.push(entityId);
      candidatesByKey.set(key, list);
    };
    for (const m of machines) {
      if (m.point) add(normalizeSourceKey(m.point), m.entityId);
      add(normalizeSourceKey(m.name), m.entityId);
    }

    let linked = 0;
    const ambiguous: string[] = [];
    const unmatched: string[] = [];
    for (const loc of locations) {
      if (loc.entityId !== null) continue; // ручную привязку не перетираем
      const found = candidatesByKey.get(normalizeSourceKey(loc.name)) ?? [];
      if (found.length === 1) {
        await this.linkLocation(loc.id, found[0]!);
        linked += 1;
      } else if (found.length > 1) {
        ambiguous.push(loc.name);
      } else {
        unmatched.push(loc.name);
      }
    }
    return { linked, ambiguous, unmatched };
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

  // ── Возвраты наборов: остаток в снятом контейнере ────────────────────────
  // Формат из рабочей группы: «позиция. набор. вес» (брутто). Чистый остаток
  // считается на чтении через матрицу тары — не хардкодим на записи, тару
  // могут уточнить позже.

  async recordContainerReturn(input: RecordContainerReturnInput): Promise<{ id: string }> {
    const [row] = await this.db
      .insert(coffeeContainerReturn)
      .values({
        position: input.position,
        containerNumber: input.containerNumber,
        weight: input.weight,
        returnedDate: input.returnedDate,
        locationNote: input.locationNote ?? null,
        createdBy: input.createdBy ?? null,
      })
      .returning({ id: coffeeContainerReturn.id });
    return { id: row!.id };
  }

  async containerReturns(limit = 100): Promise<ContainerReturnRow[]> {
    const [rows, tareByKey] = await Promise.all([
      this.db
        .select()
        .from(coffeeContainerReturn)
        .orderBy(desc(coffeeContainerReturn.returnedDate), desc(coffeeContainerReturn.createdAt))
        .limit(Math.min(Math.max(limit, 1), 500)),
      this.tareByKey(),
    ]);
    return rows.map((r) => ({
      id: r.id,
      position: r.position,
      containerNumber: r.containerNumber,
      weight: r.weight,
      netWeight: netWeight(r.weight, tareByKey.get(`${r.containerNumber}:${r.position}`) ?? null),
      returnedDate: r.returnedDate,
      locationNote: r.locationNote,
      createdBy: r.createdBy,
    }));
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

  // ── Расписание мойки (план обслуживания, порт WashingSchedule донора) ──

  /** Последняя фактическая мойка на (точка, бункер|целиком) — из журнала coffeeWashLog. */
  private async lastWashByKey(): Promise<Map<string, Date>> {
    const rows = await this.db
      .select({ locationId: coffeeWashLog.locationId, position: coffeeWashLog.position, performedAt: coffeeWashLog.performedAt })
      .from(coffeeWashLog)
      .orderBy(asc(coffeeWashLog.performedAt));
    const out = new Map<string, Date>();
    for (const r of rows) out.set(`${r.locationId}:${r.position ?? "all"}`, r.performedAt);
    return out;
  }

  /** Планы обслуживания со статусом «пора/не пора» — Настройки и брифинг читают отсюда. */
  async washScheduleStatus(): Promise<WashScheduleStatusRow[]> {
    const [schedules, lastWashByKey, sales, locations] = await Promise.all([
      this.db.select().from(coffeeWashSchedule).where(eq(coffeeWashSchedule.isActive, true)),
      this.lastWashByKey(),
      this.db.select({ locationId: coffeeSale.locationId, loggedDate: coffeeSale.loggedDate, quantity: coffeeSale.quantity }).from(coffeeSale),
      this.locations(),
    ]);
    const nameByLocation = new Map(locations.map((l) => [l.id, l.name]));
    const now = Date.now();

    return schedules.map((s) => {
      const key = `${s.locationId}:${s.position ?? "all"}`;
      const lastWashAt = lastWashByKey.get(key) ?? null;
      const daysSinceWash = lastWashAt ? Math.floor((now - lastWashAt.getTime()) / 86_400_000) : null;

      // Чашки считаются по всей точке (не по конкретному бункеру — рецепты
      // используют несколько бункеров сразу, точной атрибуции нет), строго
      // после дня последней мойки. Не мыли ни разу → считаем весь период.
      let cupsSinceWash: number | null = null;
      if (s.frequencyCups != null) {
        const sinceDate = lastWashAt ? lastWashAt.toISOString().slice(0, 10) : null;
        cupsSinceWash = sales
          .filter((r) => r.locationId === s.locationId && (sinceDate === null || r.loggedDate > sinceDate))
          .reduce((sum, r) => sum + r.quantity, 0);
      }

      const dueByDays = s.frequencyDays != null && (lastWashAt === null || (daysSinceWash ?? 0) >= s.frequencyDays);
      const dueByCups = s.frequencyCups != null && cupsSinceWash != null && cupsSinceWash >= s.frequencyCups;
      const status: WashScheduleStatusRow["status"] =
        s.frequencyDays == null && s.frequencyCups == null ? "unknown" : dueByDays || dueByCups ? "overdue" : "ok";
      const nextDueAt =
        s.frequencyDays != null && lastWashAt != null
          ? new Date(lastWashAt.getTime() + s.frequencyDays * 86_400_000).toISOString()
          : null;

      return {
        id: s.id,
        locationId: s.locationId,
        locationName: nameByLocation.get(s.locationId) ?? s.locationId,
        position: s.position,
        frequencyDays: s.frequencyDays,
        frequencyCups: s.frequencyCups,
        isActive: s.isActive,
        notes: s.notes,
        lastWashAt: lastWashAt ? lastWashAt.toISOString() : null,
        daysSinceWash,
        cupsSinceWash,
        nextDueAt,
        status,
      };
    });
  }

  /** Список планов (все, включая выключенные) — для управления в Настройках. */
  async washSchedules(): Promise<WashScheduleRow[]> {
    const rows = await this.db
      .select({
        id: coffeeWashSchedule.id,
        locationId: coffeeWashSchedule.locationId,
        locationName: coffeeLocation.name,
        position: coffeeWashSchedule.position,
        frequencyDays: coffeeWashSchedule.frequencyDays,
        frequencyCups: coffeeWashSchedule.frequencyCups,
        isActive: coffeeWashSchedule.isActive,
        notes: coffeeWashSchedule.notes,
      })
      .from(coffeeWashSchedule)
      .innerJoin(coffeeLocation, eq(coffeeWashSchedule.locationId, coffeeLocation.id))
      .orderBy(asc(coffeeLocation.name), asc(coffeeWashSchedule.position));
    return rows;
  }

  /** Завести/поправить план (точка × бункер|целиком) — upsert по частичным уникальным индексам схемы. */
  async setWashSchedule(input: SetWashScheduleInput): Promise<WashScheduleRow> {
    if (input.frequencyDays == null && input.frequencyCups == null) {
      throw new BadRequestException("Нужна хотя бы одна частота — по дням или по проданным чашкам");
    }
    const position = input.position ?? null;
    const cond = and(
      eq(coffeeWashSchedule.locationId, input.locationId),
      position === null ? isNull(coffeeWashSchedule.position) : eq(coffeeWashSchedule.position, position),
    );
    const existing = await this.db.select({ id: coffeeWashSchedule.id }).from(coffeeWashSchedule).where(cond);
    const values = {
      locationId: input.locationId,
      position,
      frequencyDays: input.frequencyDays ?? null,
      frequencyCups: input.frequencyCups ?? null,
      isActive: input.isActive ?? true,
      notes: input.notes ?? null,
    };

    const id = existing[0]
      ? (await (async () => {
          await this.db.update(coffeeWashSchedule).set(values).where(eq(coffeeWashSchedule.id, existing[0]!.id));
          return existing[0]!.id;
        })())
      : (await this.db.insert(coffeeWashSchedule).values(values).returning({ id: coffeeWashSchedule.id }))[0]!.id;

    const [loc] = await this.db.select({ name: coffeeLocation.name }).from(coffeeLocation).where(eq(coffeeLocation.id, input.locationId));
    return { id, locationName: loc?.name ?? input.locationId, ...values };
  }

  /** Удалить план обслуживания. */
  async removeWashSchedule(id: string): Promise<{ ok: true }> {
    const existing = await this.db.select({ id: coffeeWashSchedule.id }).from(coffeeWashSchedule).where(eq(coffeeWashSchedule.id, id));
    if (existing.length === 0) throw new NotFoundException(`План обслуживания ${id} не найден`);
    await this.db.delete(coffeeWashSchedule).where(eq(coffeeWashSchedule.id, id));
    return { ok: true };
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
  async reconcileLocation(locationId: string, fromDate: string, toDate: string): Promise<ReconcileRow[]> {
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
    return this.reconcileRows(refills, salesRows, products, ingredients, tareByKey, fromDate, toDate);
  }

  /**
   * То же, что `reconcileLocation()`, но по ВСЕМ точкам сразу — порт
   * `ReconcileView` донора mydon-command-center как алерт-сводка, без
   * N запросов к API на точку. Точки без заливок/продаж в периоде не
   * попадают в ответ — сверять там нечего.
   */
  async reconcileAllLocations(fromDate: string, toDate: string): Promise<LocationReconcileGroup[]> {
    const [refills, sales, products, ingredients, tareByKey, locations] = await Promise.all([
      this.db
        .select()
        .from(coffeeRefill)
        .orderBy(asc(coffeeRefill.position), asc(coffeeRefill.enteredDate), asc(coffeeRefill.createdAt)),
      this.db.select().from(coffeeSale),
      this.products(),
      this.db.select().from(coffeeIngredient),
      this.tareByKey(),
      this.locations(),
    ]);
    const nameByLocation = new Map(locations.map((l) => [l.id, l.name]));

    const refillsByLocation = new Map<string, typeof refills>();
    for (const r of refills) refillsByLocation.set(r.locationId, [...(refillsByLocation.get(r.locationId) ?? []), r]);
    const salesByLocation = new Map<string, typeof sales>();
    for (const s of sales) salesByLocation.set(s.locationId, [...(salesByLocation.get(s.locationId) ?? []), s]);

    const locationIds = new Set([...refillsByLocation.keys(), ...salesByLocation.keys()]);
    const groups: LocationReconcileGroup[] = [];
    for (const locationId of locationIds) {
      const rows = this.reconcileRows(
        refillsByLocation.get(locationId) ?? [],
        salesByLocation.get(locationId) ?? [],
        products,
        ingredients,
        tareByKey,
        fromDate,
        toDate,
      );
      if (rows.length > 0) groups.push({ locationId, locationName: nameByLocation.get(locationId) ?? locationId, rows });
    }
    return groups;
  }

  /** Общая логика факт/ожидание для одной точки — используется и по одной, и по всем сразу. */
  private reconcileRows(
    refills: ReconcileRefillRow[],
    salesRows: ReconcileSaleRow[],
    products: Awaited<ReturnType<CoffeeService["products"]>>,
    ingredients: ReconcileIngredientRow[],
    tareByKey: Map<string, number>,
    fromDate: string,
    toDate: string,
  ): ReconcileRow[] {
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

  // ── Склад: центральный остаток ингредиентов (грамм) ──────────────────────
  // Тот же приём, что и у `vending_stock`: одна строка на ингредиент —
  // текущий баланс, вводится инвентаризацией (перезапись, а не леджер).
  // Заливки бункеров его не списывают автоматически — умышленно: пересчёт
  // следует за реальностью на складе, а не наоборот (симулировать расход по
  // заливкам означало бы дублировать факт вторым, неточным источником).

  /**
   * Занести пересчёт склада. Идентично `vending.service.ingestStock()`:
   * опоздавший пересчёт (`countedAt` старше уже сохранённого) игнорируется
   * целиком — иначе задержавшееся сообщение откатывает актуальный остаток
   * назад. Расхождение с прошлым остатком оценивается в сумах, если у
   * ингредиента есть цена (`purchasePrice`) — иначе `noPrice: true`, деньгам
   * доверять нельзя.
   */
  async ingestCoffeeStock(items: IngestCoffeeStockItem[], countedAt?: string): Promise<{ items: number; adjustments: CoffeeStockAdjustment[] }> {
    const counted = countedAt ? new Date(countedAt) : new Date();
    const adjustments: CoffeeStockAdjustment[] = [];

    await this.db.transaction(async (tx) => {
      const [existingRows, ingredients] = await Promise.all([
        tx.select().from(coffeeStock),
        tx.select().from(coffeeIngredient),
      ]);
      const beforeById = new Map(existingRows.map((r) => [r.ingredientId, { quantity: r.quantity, countedAt: r.countedAt }]));
      const nameById = new Map(ingredients.map((i) => [i.id, i.name]));
      const priceById = new Map(ingredients.map((i) => [i.id, i.purchasePrice != null ? Number(i.purchasePrice) : null]));

      for (const item of items) {
        const prior = beforeById.get(item.ingredientId);
        if (prior && prior.countedAt.getTime() > counted.getTime()) continue;

        if (prior && prior.quantity !== item.quantity) {
          const delta = item.quantity - prior.quantity;
          const price = priceById.get(item.ingredientId) ?? null;
          adjustments.push({
            ingredientId: item.ingredientId,
            ingredientName: nameById.get(item.ingredientId) ?? item.ingredientId,
            before: prior.quantity,
            after: item.quantity,
            delta,
            value: price != null ? Math.round(Math.abs(delta) * price * 100) / 100 : 0,
            noPrice: price == null,
          });
        }

        await tx
          .insert(coffeeStock)
          .values({ ingredientId: item.ingredientId, quantity: item.quantity, countedAt: counted })
          .onConflictDoUpdate({
            target: coffeeStock.ingredientId,
            set: { quantity: item.quantity, countedAt: counted, updatedAt: new Date() },
            // Дата интерполируется в сырой sql-фрагмент как строка ISO — drizzle
            // не знает целевой тип колонки внутри `where:` и без этого
            // сериализует Date через toString(), что ловит Postgres как
            // невалидный часовой пояс (найдено при живом e2e-тесте, не в стабах).
            where: sql`${coffeeStock.countedAt} <= ${counted.toISOString()}`,
          });
      }
    });

    return { items: items.length, adjustments };
  }

  /** Текущий остаток склада по ингредиентам. */
  async coffeeStockLevels(): Promise<CoffeeStockLevelRow[]> {
    const [rows, ingredients] = await Promise.all([this.db.select().from(coffeeStock), this.db.select().from(coffeeIngredient)]);
    const nameById = new Map(ingredients.map((i) => [i.id, i.name]));
    return rows
      .map((r) => ({
        ingredientId: r.ingredientId,
        ingredientName: nameById.get(r.ingredientId) ?? r.ingredientId,
        quantity: r.quantity,
        countedAt: r.countedAt.toISOString(),
      }))
      .sort((a, b) => a.ingredientName.localeCompare(b.ingredientName, "ru"));
  }
}
