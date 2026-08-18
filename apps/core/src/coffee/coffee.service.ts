import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, gte, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  coffeeBunkerConfig,
  coffeeConsumable,
  coffeeConsumableLog,
  coffeeContainerReturn,
  coffeeContainerTare,
  auditLog,
  coffeeIngredient,
  machinePlacement,
  coffeeProduct,
  coffeeRefill,
  coffeeSale,
  coffeeStock,
  coffeeWashLog,
  coffeeWashSchedule,
  entity,
  machineCard,
  org,} from "@mydon/db";
import {
  buildLocationSummary,
  consumedSince,
  consumptionReport,
  costOf,
  fillStatus,
  matchReturnsToRefills,
  netWeight,
  reconcileConsumption,
  type ContainerConsumptionRow,
  type ContainerFillEvent,
  type ContainerReturnEvent,
  type LatestRefillRow,
  type ReconcileResult,
  type RecipeLine,
  isPlaceType,
  machineIsOperational,
  placeNameKeys,
} from "@mydon/shared";
import { DB, type Db } from "../db/db.module";

/**
 * Место в запросе — та же таблица `entity`, что и автомат.
 *
 * Миграция 0049 влила справочник точек в реестр, поэтому join идёт на `entity`
 * дважды: один раз за автоматом, другой за местом. Псевдоним обязателен —
 * иначе Postgres не различит их в одном запросе.
 */
const place = alias(entity, "place");

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
  /** Порядок в списке; хранится в attrs карточки. */
  sortOrder: number;
  /**
   * ПЕРВЫЙ аппарат на месте — для совместимости панели и бота, которые писались
   * во времена «одно место = один аппарат». Полный состав в `machines`.
   */
  entityId: string | null;
  machineName: string | null;
  machineRef: string | null;
  /** Все аппараты, стоящие на месте сейчас. Их может быть несколько. */
  machines: { entityId: string; name: string; ref: string | null }[];
}

/** Кто удаляет запись журнала и чьи записи ему можно трогать. */
export interface DeleteEntryOpts {
  /** Кто удалил — в audit_log (по умолчанию «panel»). */
  actor?: string;
  /** Задано — удалить можно только запись этого автора (сотрудник в боте). */
  onlyIfCreatedBy?: string;
}

/** Последняя запись автора (бот «ошибся — исправить»): что и когда внесено. */
export interface LastEntryRow {
  kind: "refill" | "container_return" | "consumable";
  id: string;
  /** ISO-время записи — по нему выбрана самая свежая из трёх журналов. */
  at: string;
  /** Готовая строка по-русски: сотрудник видит, что именно удаляет. */
  text: string;
}

/** Кандидат привязки: автомат из реестра с адресом точки из его карточки. */
export interface MachineCandidateRow {
  entityId: string;
  name: string;
  ref: string | null;
  point: string | null;
}

/** Сводка расхода по наборам одной точки за период. */
export interface ContainerConsumptionLocation {
  locationId: string;
  locationName: string;
  /** Сумма расхода по посчитанным парам, г. */
  grams: number;
  /** Себестоимость по ценам ингредиентов; null — цены не заведены. */
  cost: number | null;
  pairs: number;
  /** Пары, где расход посчитать нельзя (нет тары / возврат тяжелее заливки). */
  unknownPairs: number;
}

export interface ContainerConsumptionReport {
  from: string;
  to: string;
  rows: (ContainerConsumptionRow & { ingredient: string | null })[];
  locations: ContainerConsumptionLocation[];
  totalGrams: number;
  totalCost: number | null;
}

/** Период размещения аппарата на точке. endDate=null — стоит сейчас. */
export interface PlacementRow {
  id: string;
  locationId: string;
  locationName: string;
  entityId: string;
  machineName: string;
  machineRef: string | null;
  /** null — стоял «с неизвестной даты» (бэкфилл существовавших привязок). */
  startDate: string | null;
  endDate: string | null;
  note: string | null;
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
  packageCount: number | null;
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

  /**
   * Точки со СПИСКОМ стоящих на них аппаратов.
   *
   * Раньше место знало один «текущий аппарат» колонкой `entity_id`, и список
   * отдавал одно имя. Владелец 07.08.2026 разрешил ставить на место несколько
   * аппаратов — колонка стала невыразимой, и текущий состав считается из
   * открытых размещений (`end_date is null`), где он и был.
   *
   * `isActive` и порядок живут в `attrs` карточки — так в этом реестре хранятся
   * свойства, у которых нет отдельной колонки (роли контрагента, срок договора).
   */
  async locations(): Promise<LocationRow[]> {
    const places = await this.db
      .select({ id: entity.id, name: entity.name, attrs: entity.attrs })
      .from(entity)
      .where(eq(entity.type, "location"));

    const открытые = await this.db
      .select({
        locationId: machinePlacement.locationId,
        entityId: machinePlacement.entityId,
        machineName: entity.name,
        machineRef: entity.externalRef,
      })
      .from(machinePlacement)
      .innerJoin(entity, eq(machinePlacement.entityId, entity.id))
      .where(isNull(machinePlacement.endDate));

    const поМесту = new Map<string, typeof открытые>();
    for (const r of открытые) {
      const list = поМесту.get(r.locationId) ?? [];
      list.push(r);
      поМесту.set(r.locationId, list);
    }

    return places
      .map((p) => {
        const attrs = (p.attrs ?? {}) as Record<string, unknown>;
        const машины = поМесту.get(p.id) ?? [];
        const первая = машины[0];
        return {
          id: p.id,
          name: p.name,
          isActive: attrs["выключена"] !== true,
          sortOrder: typeof attrs["порядок"] === "number" ? (attrs["порядок"] as number) : 0,
          // Поля в единственном числе оставлены ради совместимости панели и
          // бота: они читают «аппарат на точке». Полный состав — в `machines`.
          entityId: первая?.entityId ?? null,
          machineName: первая?.machineName ?? null,
          machineRef: первая?.machineRef ?? null,
          machines: машины.map((m) => ({ entityId: m.entityId, name: m.machineName, ref: m.machineRef })),
        };
      })
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ru"));
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

  /**
   * Поставить аппарат на место или снять его оттуда.
   *
   * Операция над ПАРОЙ «место + аппарат», а не над местом. Раньше она была над
   * местом: привязка закрывала все открытые размещения точки, «какой бы аппарат
   * там ни стоял». Пока на месте мог стоять один аппарат, разницы не было; с
   * решением владельца 07.08.2026 («на точке может стоять несколько, в том
   * числе одинаковых») старое поведение стало опасным — второй сломанный
   * автомат, приехавший в мастерскую, МОЛЧА выселил бы оттуда первого, оставив
   * аккуратно закрытый период в истории.
   *
   * Что осталось прежним: аппарат не может стоять в двух местах сразу, поэтому
   * его собственное открытое размещение закрывается. Это физика железа, и
   * частичный уникальный индекс `machine_placement_entity_open_key` её держит.
   *
   * `entityId = null` больше не означает «отвязать место»: у места может быть
   * несколько аппаратов, и какой из них снимать — вопрос, на который null не
   * отвечает. Снятие выражается вызовом `unlinkMachine`.
   */
  async linkLocation(locationId: string, entityId: string | null): Promise<{ ok: true }> {
    if (entityId === null) {
      throw new BadRequestException(
        "На месте может стоять несколько аппаратов — укажите, какой снять (unlinkMachine)",
      );
    }
    const [loc] = await this.db
      .select({ id: entity.id, type: entity.type })
      .from(entity)
      .where(eq(entity.id, locationId));
    if (!loc) throw new NotFoundException(`Место ${locationId} не найдено`);
    if (!isPlaceType(loc.type)) {
      throw new BadRequestException(`Поставить аппарат можно только на место, а это «${loc.type}»`);
    }

    const [card] = await this.db
      .select({ id: entity.id, type: entity.type })
      .from(entity)
      .where(eq(entity.id, entityId));
    if (!card) throw new NotFoundException(`Карточка ${entityId} не найдена`);
    if (card.type !== "machine") {
      throw new BadRequestException("Привязать можно только карточку автомата (type=machine)");
    }

    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" });
    await this.db.transaction(async (tx) => {
      // Уже стоит здесь — период-дубль не плодим.
      const [уже] = await tx
        .select({ id: machinePlacement.id })
        .from(machinePlacement)
        .where(
          and(
            eq(machinePlacement.locationId, locationId),
            eq(machinePlacement.entityId, entityId),
            isNull(machinePlacement.endDate),
          ),
        );
      if (уже) return;

      // Закрываем открытое размещение САМОГО АППАРАТА — он уезжает сюда
      // откуда-то ещё. Соседей по новому месту не трогаем.
      await tx
        .update(machinePlacement)
        .set({ endDate: today })
        .where(and(eq(machinePlacement.entityId, entityId), isNull(machinePlacement.endDate)));
      await tx.insert(machinePlacement).values({ locationId, entityId, startDate: today });
    });
    return { ok: true };
  }

  /**
   * Снять аппарат с места, где он стоит.
   *
   * Отдельная операция, потому что «отвязать место» перестало быть однозначным:
   * аппаратов на нём может быть несколько. Закрываем открытое размещение
   * именно этого аппарата — остальные остаются на месте.
   */
  async unlinkMachine(entityId: string): Promise<{ ok: true; snятo: number }> {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" });
    const closed = await this.db
      .update(machinePlacement)
      .set({ endDate: today })
      .where(and(eq(machinePlacement.entityId, entityId), isNull(machinePlacement.endDate)))
      .returning({ id: machinePlacement.id });
    return { ok: true, snятo: closed.length };
  }

  /** История размещений: какой аппарат когда на какой точке стоял. */
  async placements(locationId?: string): Promise<PlacementRow[]> {
    const rows = await this.db
      .select({
        id: machinePlacement.id,
        locationId: machinePlacement.locationId,
        locationName: place.name,
        entityId: machinePlacement.entityId,
        machineName: entity.name,
        machineRef: entity.externalRef,
        startDate: machinePlacement.startDate,
        endDate: machinePlacement.endDate,
        note: machinePlacement.note,
      })
      .from(machinePlacement)
      .innerJoin(place, eq(machinePlacement.locationId, place.id))
      .innerJoin(entity, eq(machinePlacement.entityId, entity.id))
      .where(locationId ? eq(machinePlacement.locationId, locationId) : undefined)
      .orderBy(desc(sql`${machinePlacement.endDate} is null`), desc(machinePlacement.startDate));
    return rows;
  }

  /**
   * Автопривязка по названию: нормализованное имя точки сверяется с адресом
   * («точка» в карточке) и именем автомата. Привязывает ТОЛЬКО однозначные
   * совпадения — ноль или несколько кандидатов оставляются владельцу
   * (неоднозначность не угадывается). Уже привязанные точки не трогаются.
   */
  async autoLinkLocations(): Promise<{ linked: number; ambiguous: string[]; unmatched: string[] }> {
    const [places, machines] = await Promise.all([this.locations(), this.machineCandidates()]);

    // Обход идёт от АППАРАТОВ, а не от мест.
    //
    // Раньше перебирались места, а занятые пропускались. Пока на точке стоял
    // один аппарат, это защищало ручную расстановку; после решения владельца
    // («в одной точке может стоять несколько, в том числе одинаковых») то же
    // условие НАВСЕГДА запрещало добавить второй — а снек-автоматы стоят ровно
    // там же, где кофейные, и потому не привязывались никогда.
    //
    // Аппарат без открытого размещения — это честное «где стоит, неизвестно».
    // Поставить его туда, что написано в его имени, ничего не перетирает.
    const местаПоКлючу = new Map<string, string[]>();
    for (const p of places) {
      for (const ключ of placeNameKeys(p.name)) {
        const list = местаПоКлючу.get(ключ) ?? [];
        if (!list.includes(p.id)) list.push(p.id);
        местаПоКлючу.set(ключ, list);
      }
    }

    const ужеСтоят = new Set(places.flatMap((p) => p.machines.map((m) => m.entityId)));
    // Состояние аппарата решает, можно ли его вообще ставить на точку продаж.
    // Автомат в ремонте или на складе туда не встаёт — иначе автопривязка
    // «вернула» бы его в эксплуатацию за спиной у владельца.
    const состояния = new Map(
      (
        await this.db
          .select({ entityId: machineCard.entityId, status: machineCard.status })
          .from(machineCard)
      ).map((r) => [r.entityId, r.status]),
    );

    let linked = 0;
    const ambiguous: string[] = [];
    const unmatched: string[] = [];
    for (const m of machines) {
      if (ужеСтоят.has(m.entityId)) continue;
      if (!machineIsOperational(состояния.get(m.entityId) ?? null)) continue;

      // Ключи по убыванию точности: сперва «точка» из карточки, потом имя
      // целиком, потом имя без уточнителя. Первый сработавший и берём.
      const ключи = [...placeNameKeys(m.point), ...placeNameKeys(m.name)];
      let найдено: string[] = [];
      for (const ключ of ключи) {
        const кандидаты = местаПоКлючу.get(ключ) ?? [];
        if (кандидаты.length > 0) {
          найдено = кандидаты;
          break;
        }
      }

      if (найдено.length === 1) {
        await this.linkLocation(найдено[0]!, m.entityId);
        linked += 1;
      } else if (найдено.length > 1) {
        ambiguous.push(m.name);
      } else {
        unmatched.push(m.name);
      }
    }
    return { linked, ambiguous, unmatched };
  }


  // ── Точки: правка из панели (слово владельца: всё редактируется легко) ──

  /**
   * Завести точку вручную.
   *
   * Точка — карточка реестра типа `location` (миграция 0049). Заводится
   * утверждённой: её создаёт владелец через панель, а не источник данных.
   */
  async createLocation(name: string): Promise<{ id: string }> {
    const clean = name.trim();
    if (clean.length < 2 || clean.length > 128) throw new BadRequestException("Имя точки — от 2 до 128 символов");
    const [vendhub] = await this.db
      .select({ id: org.id })
      .from(org)
      .where(eq(org.code, "vendhub"))
      .limit(1);
    const [row] = await this.db
      .insert(entity)
      .values({
        ...(vendhub ? { orgId: vendhub.id } : {}),
        type: "location",
        name: clean,
        approvedAt: new Date(),
        approvedBy: "owner",
      })
      .returning({ id: entity.id });
    await this.db.insert(auditLog).values({
      actorKind: "human",
      actorRef: "panel",
      action: "coffee.location.create",
      target: row.id,
      after: { name: clean },
    });
    return { id: row.id };
  }

  /** Переименовать / включить-выключить точку. */
  async updateLocation(id: string, patch: { name?: string; isActive?: boolean }): Promise<{ ok: true }> {
    const [loc] = await this.db.select().from(entity).where(eq(entity.id, id));
    if (!loc) throw new NotFoundException(`Точка ${id} не найдена`);
    const attrs = { ...((loc.attrs ?? {}) as Record<string, unknown>) };
    const set: { name?: string; attrs?: Record<string, unknown> } = {};
    if (patch.name !== undefined) {
      const clean = patch.name.trim();
      if (clean.length < 2 || clean.length > 128) throw new BadRequestException("Имя точки — от 2 до 128 символов");
      set.name = clean;
    }
    // «Выключена», а не «активна»: в attrs пишем только отклонение от нормы,
    // иначе у каждой карточки завёлся бы флаг со значением по умолчанию.
    if (patch.isActive !== undefined) {
      if (patch.isActive) delete attrs["выключена"];
      else attrs["выключена"] = true;
      set.attrs = attrs;
    }
    if (Object.keys(set).length === 0) return { ok: true };
    await this.db.update(entity).set(set).where(eq(entity.id, id));
    await this.db.insert(auditLog).values({
      actorKind: "human",
      actorRef: "panel",
      action: "coffee.location.update",
      target: id,
      before: { name: loc.name, attrs: loc.attrs },
      after: set,
    });
    return { ok: true };
  }

  /**
   * Удалить ошибочную запись журнала. Правка истории — честная: строка
   * целиком уходит в audit_log (кто, что, когда стояло), а не исчезает молча.
   * `onlyIfCreatedBy` — страховка для бота: сотрудник удаляет только своё,
   * владелец из панели (без ограничения) — что угодно.
   */
  async deleteRefill(id: string, opts: DeleteEntryOpts = {}): Promise<{ ok: true }> {
    const [row] = await this.db.select().from(coffeeRefill).where(eq(coffeeRefill.id, id));
    if (!row) throw new NotFoundException(`Заливка ${id} не найдена`);
    if (opts.onlyIfCreatedBy !== undefined && row.createdBy !== opts.onlyIfCreatedBy) {
      throw new BadRequestException("Это не твоя запись — её может удалить только автор или владелец в панели");
    }
    await this.db.delete(coffeeRefill).where(eq(coffeeRefill.id, id));
    await this.db.insert(auditLog).values({
      actorKind: "human",
      actorRef: opts.actor ?? "panel",
      action: "coffee.refill.delete",
      target: id,
      before: row,
    });
    return { ok: true };
  }

  async deleteContainerReturn(id: string, opts: DeleteEntryOpts = {}): Promise<{ ok: true }> {
    const [row] = await this.db.select().from(coffeeContainerReturn).where(eq(coffeeContainerReturn.id, id));
    if (!row) throw new NotFoundException(`Возврат ${id} не найден`);
    if (opts.onlyIfCreatedBy !== undefined && row.createdBy !== opts.onlyIfCreatedBy) {
      throw new BadRequestException("Это не твоя запись — её может удалить только автор или владелец в панели");
    }
    await this.db.delete(coffeeContainerReturn).where(eq(coffeeContainerReturn.id, id));
    await this.db.insert(auditLog).values({
      actorKind: "human",
      actorRef: opts.actor ?? "panel",
      action: "coffee.return.delete",
      target: id,
      before: row,
    });
    return { ok: true };
  }

  /** Удалить строку расходников (вода/стаканы/крышки) за день — с тем же аудитом. */
  async deleteConsumable(id: string, opts: DeleteEntryOpts = {}): Promise<{ ok: true }> {
    const [row] = await this.db.select().from(coffeeConsumable).where(eq(coffeeConsumable.id, id));
    if (!row) throw new NotFoundException(`Запись расходников ${id} не найдена`);
    if (opts.onlyIfCreatedBy !== undefined && row.createdBy !== opts.onlyIfCreatedBy) {
      throw new BadRequestException("Это не твоя запись — её может удалить только автор или владелец в панели");
    }
    await this.db.delete(coffeeConsumable).where(eq(coffeeConsumable.id, id));
    await this.db.insert(auditLog).values({
      actorKind: "human",
      actorRef: opts.actor ?? "panel",
      action: "coffee.consumable.delete",
      target: id,
      before: row,
    });
    return { ok: true };
  }

  /**
   * Последняя запись автора среди заливок, возвратов и расходников — для
   * «ошибся — исправить» в боте: сотрудник видит, что именно удаляет,
   * прежде чем подтвердить.
   */
  async lastEntry(createdBy: string): Promise<{ entry: LastEntryRow | null }> {
    const [refills, returns, consumables] = await Promise.all([
      this.db
        .select({
          id: coffeeRefill.id,
          at: coffeeRefill.createdAt,
          locationName: place.name,
          position: coffeeRefill.position,
          containerNumber: coffeeRefill.containerNumber,
          filledWeight: coffeeRefill.filledWeight,
          packageCount: coffeeRefill.packageCount,
          enteredDate: coffeeRefill.enteredDate,
        })
        .from(coffeeRefill)
        .innerJoin(place, eq(coffeeRefill.locationId, place.id))
        .where(eq(coffeeRefill.createdBy, createdBy))
        .orderBy(desc(coffeeRefill.createdAt))
        .limit(1),
      this.db
        .select({
          id: coffeeContainerReturn.id,
          at: coffeeContainerReturn.createdAt,
          position: coffeeContainerReturn.position,
          containerNumber: coffeeContainerReturn.containerNumber,
          weight: coffeeContainerReturn.weight,
          returnedDate: coffeeContainerReturn.returnedDate,
        })
        .from(coffeeContainerReturn)
        .where(eq(coffeeContainerReturn.createdBy, createdBy))
        .orderBy(desc(coffeeContainerReturn.createdAt))
        .limit(1),
      this.db
        .select({
          id: coffeeConsumable.id,
          at: coffeeConsumable.updatedAt,
          locationName: place.name,
          loggedDate: coffeeConsumable.loggedDate,
          water: coffeeConsumable.water,
          cups: coffeeConsumable.cups,
          lids: coffeeConsumable.lids,
        })
        .from(coffeeConsumable)
        .innerJoin(place, eq(coffeeConsumable.locationId, place.id))
        .where(eq(coffeeConsumable.createdBy, createdBy))
        .orderBy(desc(coffeeConsumable.updatedAt))
        .limit(1),
    ]);

    const pad3 = (n: number) => String(n).padStart(3, "0");
    const candidates: LastEntryRow[] = [];
    for (const r of refills) {
      const container = r.containerNumber != null ? ` · набор ${pad3(r.containerNumber)}` : "";
      candidates.push({
        kind: "refill",
        id: r.id,
        at: new Date(r.at).toISOString(),
        text: `заливка ${r.enteredDate} · ${r.locationName} · бункер ${r.position}${container} · ${r.filledWeight}г${r.packageCount == null ? "" : ` · ${r.packageCount} уп.`}`,
      });
    }
    for (const r of returns) {
      candidates.push({
        kind: "container_return",
        id: r.id,
        at: new Date(r.at).toISOString(),
        text: `возврат ${r.returnedDate} · набор ${pad3(r.containerNumber)} · поз. ${r.position} · ${r.weight}г`,
      });
    }
    for (const r of consumables) {
      candidates.push({
        kind: "consumable",
        id: r.id,
        at: new Date(r.at).toISOString(),
        text: `расходники ${r.loggedDate} · ${r.locationName} · вода ${r.water} · стаканы ${r.cups} · крышки ${r.lids}`,
      });
    }
    if (candidates.length === 0) return { entry: null };
    // Сортировка в JS, не в SQL: три источника сравниваются между собой здесь.
    candidates.sort((a, b) => b.at.localeCompare(a.at));
    return { entry: candidates[0] };
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
        packageWeight: coffeeIngredient.packageWeight,
        packageLabel: coffeeIngredient.packageLabel,
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
    // Ингредиент, не названный клиентом, выводим из конфига бункеров ЗДЕСЬ,
    // а не в каждом клиенте: бот вывод уже делает, а панель не делала — и её
    // заливки выпадали из сверки «ожидали против налили» (reconcile пропускает
    // строки без ingredientId). Только ОДНОЗНАЧНЫЙ: у позиции с двумя
    // ингредиентами угаданное списание хуже отсутствующего.
    let ingredientId = input.ingredientId ?? null;
    if (ingredientId === null) {
      const config = await this.bunkerConfig();
      const ids = [...new Set(config.filter((c) => c.position === input.position).map((c) => c.ingredientId))];
      if (ids.length === 1) ingredientId = ids[0]!;
    }
    const [row] = await this.db
      .insert(coffeeRefill)
      .values({
        locationId: input.locationId,
        position: input.position,
        containerNumber: input.containerNumber ?? null,
        ingredientId,
        filledWeight: input.filledWeight,
        measuredBefore: input.measuredBefore ?? null,
        packageCount: input.packageCount ?? null,
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
        locationName: place.name,
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
      .innerJoin(place, eq(coffeeRefill.locationId, place.id))
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
          locationName: place.name,
          position: coffeeRefill.position,
          packageCount: coffeeRefill.packageCount,
          filledWeight: coffeeRefill.filledWeight,
          enteredDate: coffeeRefill.enteredDate,
        })
        .from(coffeeRefill)
        .innerJoin(place, eq(coffeeRefill.locationId, place.id))
        // Вторичный ключ createdAt: enteredDate — дата без времени, и при двух
        // заливках одной позиции за день (легальный случай: «Вторая заливка —
        // записать») порядок строк внутри даты Postgres не гарантирует.
        // «Последней» обязана быть действительно последняя, а не случайная.
        .orderBy(asc(coffeeRefill.enteredDate), asc(coffeeRefill.createdAt)),
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
          locationName: place.name,
          position: coffeeRefill.position,
          ingredientId: coffeeRefill.ingredientId,
          containerNumber: coffeeRefill.containerNumber,
          filledWeight: coffeeRefill.filledWeight,
          enteredDate: coffeeRefill.enteredDate,
        })
        .from(coffeeRefill)
        .innerJoin(place, eq(coffeeRefill.locationId, place.id))
        // Вторичный ключ createdAt: enteredDate — дата без времени, и при двух
        // заливках одной позиции за день (легальный случай: «Вторая заливка —
        // записать») порядок строк внутри даты Postgres не гарантирует.
        // «Последней» обязана быть действительно последняя, а не случайная.
        .orderBy(asc(coffeeRefill.enteredDate), asc(coffeeRefill.createdAt)),
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
    await this.db.transaction(async (tx) => {
      await tx
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
          // createdBy обновляется, только когда новый ввод НАЗВАЛ автора:
          // авторство принадлежит последнему представившемуся, но правка
          // из панели без createdBy не затирает автора-сотрудника в NULL.
          set: {
            water: input.water ?? 0,
            cups: input.cups ?? 0,
            lids: input.lids ?? 0,
            ...(input.createdBy ? { createdBy: input.createdBy } : {}),
            updatedAt: new Date(),
          },
        });
      // Событие ввода — в append-only журнал: строка выше — состояние дня,
      // историю и «итоги вчера» по ней не воспроизвести (правка сдвигала
      // прошлое ленты действий). Честный ретрай того же ввода (те же числа,
      // тот же автор, та же последняя строка) события не дублирует.
      const [last] = await tx
        .select()
        .from(coffeeConsumableLog)
        .where(
          and(
            eq(coffeeConsumableLog.locationId, input.locationId),
            eq(coffeeConsumableLog.loggedDate, input.loggedDate),
          ),
        )
        .orderBy(desc(coffeeConsumableLog.createdAt))
        .limit(1);
      const sameAsLast =
        last !== undefined &&
        last.water === (input.water ?? 0) &&
        last.cups === (input.cups ?? 0) &&
        last.lids === (input.lids ?? 0) &&
        last.createdBy === (input.createdBy ?? null);
      if (!sameAsLast) {
        await tx.insert(coffeeConsumableLog).values({
          locationId: input.locationId,
          loggedDate: input.loggedDate,
          water: input.water ?? 0,
          cups: input.cups ?? 0,
          lids: input.lids ?? 0,
          createdBy: input.createdBy ?? null,
        });
      }
    });
    return { ok: true };
  }

  /** Последний известный расходник по каждой точке — «Капсула и крышки». */
  async consumablesSummary(): Promise<{ location: string; water: number; cups: number; lids: number }[]> {
    const [locations, rows] = await Promise.all([
      this.locations(),
      this.db
        .select({
          locationName: place.name,
          water: coffeeConsumable.water,
          cups: coffeeConsumable.cups,
          lids: coffeeConsumable.lids,
          loggedDate: coffeeConsumable.loggedDate,
        })
        .from(coffeeConsumable)
        .innerJoin(place, eq(coffeeConsumable.locationId, place.id))
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
    // Дедуп по содержимому: у возвратов нет clientKey — сообщение набирают
    // руками и после сбоя пересылают ЦЕЛИКОМ, дублируя уже записанные строки.
    // Та же четвёрка за тот же день — это та же строка, а не второй возврат:
    // после возврата набор уходит с точки, и второй раз в тот же день с тем
    // же весом он не возвращается. (У заливок аналог — findTwin в боте.)
    const [dup] = await this.db
      .select({ id: coffeeContainerReturn.id })
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
    if (dup) return { id: dup.id };

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

  /**
   * Фактический расход по наборам за период: возврат закрывает предыдущую
   * заливку того же (набор, позиция), расход = нетто заливки − нетто возврата
   * (обе стороны через одну тару). Это то, что референс-приложение владельца
   * считало руками в «Потраченных ингредиентах», — теперь считается само,
   * включая импортированную историю. Себестоимость — по цене ингредиента
   * позиции; у позиции с двумя ингредиентами цена неоднозначна → null.
   */
  async containerConsumption(from: string, to: string): Promise<ContainerConsumptionReport> {
    const [fills, returns, tareByKey, config] = await Promise.all([
      this.db
        .select({
          date: coffeeRefill.enteredDate,
          position: coffeeRefill.position,
          containerNumber: coffeeRefill.containerNumber,
          filledWeight: coffeeRefill.filledWeight,
          locationId: coffeeRefill.locationId,
          locationName: place.name,
        })
        .from(coffeeRefill)
        .innerJoin(place, eq(coffeeRefill.locationId, place.id))
        .where(
          and(isNotNull(coffeeRefill.containerNumber), gte(coffeeRefill.enteredDate, from), lte(coffeeRefill.enteredDate, to)),
        ),
      this.db
        .select()
        .from(coffeeContainerReturn)
        .where(and(gte(coffeeContainerReturn.returnedDate, from), lte(coffeeContainerReturn.returnedDate, to))),
      this.tareByKey(),
      this.bunkerConfig(),
    ]);

    const fillEvents: ContainerFillEvent[] = fills.map((f) => ({
      date: f.date,
      position: f.position,
      containerNumber: f.containerNumber!,
      netWeight: netWeight(f.filledWeight, tareByKey.get(`${f.containerNumber}:${f.position}`) ?? null),
      locationId: f.locationId,
      locationName: f.locationName,
    }));
    const returnEvents: ContainerReturnEvent[] = returns.map((r) => ({
      date: r.returnedDate,
      position: r.position,
      containerNumber: r.containerNumber,
      netWeight: netWeight(r.weight, tareByKey.get(`${r.containerNumber}:${r.position}`) ?? null),
    }));

    const rows = matchReturnsToRefills(fillEvents, returnEvents);

    // Цена позиции: единственный ингредиент с заведённой ценой, иначе null.
    const priceByPosition = new Map<number, number | null>();
    for (let pos = 1; pos <= 8; pos++) {
      const items = config.filter((c) => c.position === pos);
      priceByPosition.set(pos, items.length === 1 ? (items[0]!.purchasePrice ?? null) : null);
    }
    const ingredientByPosition = new Map<number, string>();
    for (const c of config) {
      const prev = ingredientByPosition.get(c.position);
      ingredientByPosition.set(c.position, prev ? `${prev}/${c.ingredientName}` : c.ingredientName);
    }

    const acc = new Map<
      string,
      { locationId: string; locationName: string; grams: number; cost: number; costKnown: boolean; pairs: number; unknownPairs: number }
    >();
    for (const r of rows) {
      const g =
        acc.get(r.locationId) ??
        { locationId: r.locationId, locationName: r.locationName, grams: 0, cost: 0, costKnown: false, pairs: 0, unknownPairs: 0 };
      g.pairs += 1;
      if (r.consumedGrams === null) {
        g.unknownPairs += 1;
      } else {
        g.grams += r.consumedGrams;
        const cost = costOf(r.consumedGrams, priceByPosition.get(r.position) ?? null);
        if (cost !== null) {
          g.cost += cost;
          g.costKnown = true;
        }
      }
      acc.set(r.locationId, g);
    }
    // Цены нет ни у одной пары точки — стоимость null, а не «0 сум».
    const locations = [...acc.values()]
      .map(({ costKnown, cost, ...rest }) => ({ ...rest, cost: costKnown ? cost : null }))
      .sort((a, b) => b.grams - a.grams);

    return {
      from,
      to,
      rows: rows.map((r) => ({ ...r, ingredient: ingredientByPosition.get(r.position) ?? null })),
      locations,
      totalGrams: locations.reduce((s, l) => s + l.grams, 0),
      totalCost: locations.some((l) => l.cost !== null) ? locations.reduce((s, l) => s + (l.cost ?? 0), 0) : null,
    };
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
        locationName: place.name,
        position: coffeeWashLog.position,
        kind: coffeeWashLog.kind,
        note: coffeeWashLog.note,
        performedBy: coffeeWashLog.performedBy,
        performedAt: coffeeWashLog.performedAt,
      })
      .from(coffeeWashLog)
      .innerJoin(place, eq(coffeeWashLog.locationId, place.id))
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
        locationName: place.name,
        position: coffeeWashSchedule.position,
        frequencyDays: coffeeWashSchedule.frequencyDays,
        frequencyCups: coffeeWashSchedule.frequencyCups,
        isActive: coffeeWashSchedule.isActive,
        notes: coffeeWashSchedule.notes,
      })
      .from(coffeeWashSchedule)
      .innerJoin(place, eq(coffeeWashSchedule.locationId, place.id))
      .orderBy(asc(place.name), asc(coffeeWashSchedule.position));
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

    // Псевдоним нужен только там, где место и автомат в ОДНОМ запросе.
    // Здесь таблица одна — берём entity напрямую.
    const [loc] = await this.db
      .select({ name: entity.name })
      .from(entity)
      .where(eq(entity.id, input.locationId));
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
    const [refills, salesRows, products, ingredients, tareByKey, containerActuals] = await Promise.all([
      this.db
        .select()
        .from(coffeeRefill)
        .where(eq(coffeeRefill.locationId, locationId))
        .orderBy(asc(coffeeRefill.position), asc(coffeeRefill.enteredDate), asc(coffeeRefill.createdAt)),
      this.db.select().from(coffeeSale).where(eq(coffeeSale.locationId, locationId)),
      this.products(),
      this.db.select().from(coffeeIngredient),
      this.tareByKey(),
      this.containerActualsByLocation(fromDate, toDate),
    ]);
    return this.reconcileRows(refills, salesRows, products, ingredients, tareByKey, fromDate, toDate, containerActuals.get(locationId));
  }

  /**
   * Фактический расход по (точка, ингредиент) из возвратов наборов: пары
   * «заливка → возврат» (matchReturnsToRefills, та же математика, что в
   * containerConsumption), расход относится к дате возврата. Ингредиент — по
   * позиции бункера; позиция с двумя ингредиентами пропускается (какой именно
   * расходовался — неизвестно, не угадываем). Сопоставление глобальное:
   * набор мог переехать между точками, пары рвать нельзя.
   */
  private async containerActualsByLocation(fromDate: string, toDate: string): Promise<Map<string, Map<string, number>>> {
    const [fills, returns, tareByKey, config] = await Promise.all([
      this.db
        .select({
          date: coffeeRefill.enteredDate,
          position: coffeeRefill.position,
          containerNumber: coffeeRefill.containerNumber,
          filledWeight: coffeeRefill.filledWeight,
          locationId: coffeeRefill.locationId,
          locationName: place.name,
        })
        .from(coffeeRefill)
        .innerJoin(place, eq(coffeeRefill.locationId, place.id))
        .where(isNotNull(coffeeRefill.containerNumber)),
      this.db.select().from(coffeeContainerReturn),
      this.tareByKey(),
      this.bunkerConfig(),
    ]);

    const countByPosition = new Map<number, number>();
    for (const c of config) countByPosition.set(c.position, (countByPosition.get(c.position) ?? 0) + 1);
    const ingredientByPosition = new Map<number, string>();
    for (const c of config) if (countByPosition.get(c.position) === 1) ingredientByPosition.set(c.position, c.ingredientId);

    const rows = matchReturnsToRefills(
      fills
        // Без даты или номера набора пара не сопоставима — такие строки вне игры.
        .filter((f) => f.containerNumber !== null && typeof f.date === "string")
        .map((f) => ({
          date: f.date,
          position: f.position,
          containerNumber: f.containerNumber!,
          netWeight: netWeight(f.filledWeight, tareByKey.get(`${f.containerNumber}:${f.position}`) ?? null),
          locationId: f.locationId,
          locationName: f.locationName,
        })),
      returns.map((r) => ({
        date: r.returnedDate,
        position: r.position,
        containerNumber: r.containerNumber,
        netWeight: netWeight(r.weight, tareByKey.get(`${r.containerNumber}:${r.position}`) ?? null),
      })),
    );

    const out = new Map<string, Map<string, number>>();
    for (const r of rows) {
      if (r.consumedGrams === null) continue;
      if (r.returnDate < fromDate || r.returnDate > toDate) continue;
      const ingredientId = ingredientByPosition.get(r.position);
      if (!ingredientId) continue;
      const m = out.get(r.locationId) ?? new Map<string, number>();
      m.set(ingredientId, (m.get(ingredientId) ?? 0) + r.consumedGrams);
      out.set(r.locationId, m);
    }
    return out;
  }

  /**
   * То же, что `reconcileLocation()`, но по ВСЕМ точкам сразу — порт
   * `ReconcileView` донора mydon-command-center как алерт-сводка, без
   * N запросов к API на точку. Точки без заливок/продаж в периоде не
   * попадают в ответ — сверять там нечего.
   */
  async reconcileAllLocations(fromDate: string, toDate: string): Promise<LocationReconcileGroup[]> {
    const [refills, sales, products, ingredients, tareByKey, locations, containerActuals] = await Promise.all([
      this.db
        .select()
        .from(coffeeRefill)
        .orderBy(asc(coffeeRefill.position), asc(coffeeRefill.enteredDate), asc(coffeeRefill.createdAt)),
      this.db.select().from(coffeeSale),
      this.products(),
      this.db.select().from(coffeeIngredient),
      this.tareByKey(),
      this.locations(),
      this.containerActualsByLocation(fromDate, toDate),
    ]);
    const nameByLocation = new Map(locations.map((l) => [l.id, l.name]));

    const refillsByLocation = new Map<string, typeof refills>();
    for (const r of refills) refillsByLocation.set(r.locationId, [...(refillsByLocation.get(r.locationId) ?? []), r]);
    const salesByLocation = new Map<string, typeof sales>();
    for (const s of sales) salesByLocation.set(s.locationId, [...(salesByLocation.get(s.locationId) ?? []), s]);

    // Точка с одними лишь контейнерными парами (история без замеров) — тоже сверяется.
    const locationIds = new Set([...refillsByLocation.keys(), ...salesByLocation.keys(), ...containerActuals.keys()]);
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
        containerActuals.get(locationId),
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
    /** Факт из возвратов наборов (containerActualsByLocation) — приоритетный. */
    containerActual?: Map<string, number>,
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

    // Возвраты наборов — более надёжный факт, чем редкие «замеры до»: там,
    // где он есть, он ЗАМЕНЯЕТ measuredBefore-оценку ингредиента (не
    // суммируется — оба меряют один и тот же расход, сумма задвоила бы).
    for (const [ingredientId, grams] of containerActual ?? []) {
      actualByIngredient.set(ingredientId, grams);
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
