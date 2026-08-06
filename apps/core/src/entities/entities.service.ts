import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  auditLog,
  entity,
  entityDraft,
  geoPoint,
  machineCard,
  maintenancePlan,
  org,
  task,
} from "@mydon/db";
import {
  actorKindOf,
  addressFromAttrs,
  firstDue,
  MACHINE_STATUSES,
  TZ,
  machineIsOperational,
  type MachineStatus,
  coordFromAttrs,
  isUnit,
  MACHINE_KINDS,
  parseRecipe,
  recipeCost,
  type Domain,
  type IngredientPrice,
  type MachineKind,
  type Unit,
} from "@mydon/shared";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { AuditService } from "../audit/audit.service";
import type { CreateEntityDto, FindEntitiesDto, UpdateEntityDto } from "./entity.dto";

type MachineCardRow = typeof machineCard.$inferSelect;

type EntityRow = typeof entity.$inferSelect;
/** Транзакция Drizzle — та же, что даёт `db.transaction(async (tx) => …)`. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Типизированная точка карточки — едет вместе с ней на чтении. */
export interface Geo {
  lat: number;
  lng: number;
  address: string | null;
}

/**
 * Держать geo_point в согласии с attrs карточки. Координаты вводятся в attrs
 * (широта/долгота), но хранятся ЧИСЛАМИ с проверкой диапазона здесь. Заявлены,
 * но вне диапазона — это ошибка ввода, её возвращаем, а не проглатываем нулём.
 * Убраны из attrs — убираем и точку. `tx` — та же транзакция, что и запись
 * карточки: точка и карточка меняются вместе или никак.
 */
async function syncGeoPoint(
  tx: Tx,
  entityId: string,
  attrs: Record<string, unknown> | null | undefined,
  strict = true,
): Promise<void> {
  const { present, coord } = coordFromAttrs(attrs);
  if (present && coord === null) {
    // Прямая правка владельцем — возвращаем ошибку. Массовое утверждение
    // предложенных значений (strict=false) не роняем из-за одной битой пары:
    // просто не трогаем точку.
    if (strict) {
      throw new BadRequestException(
        "Координаты вне диапазона: широта −90..90, долгота −180..180",
      );
    }
    return;
  }
  if (coord === null) {
    await tx.delete(geoPoint).where(eq(geoPoint.entityId, entityId));
    return;
  }
  await tx
    .insert(geoPoint)
    .values({
      entityId,
      lat: String(coord.lat),
      lng: String(coord.lng),
      address: addressFromAttrs(attrs),
    })
    .onConflictDoUpdate({
      target: geoPoint.entityId,
      set: {
        lat: String(coord.lat),
        lng: String(coord.lng),
        address: addressFromAttrs(attrs),
        updatedAt: new Date(),
      },
    });
}

/**
 * Дописать старую цену в поле-историю при её смене.
 *
 * Ничего не стирается: прежняя цена уходит в историю с датой, до которой она
 * действовала. Работает и для числа, и для числовой строки — источник и
 * владелец пишут по-разному, а история нужна одинаково.
 */
function appendPriceHistory(
  oldAttrs: Record<string, unknown>,
  newAttrs: Record<string, unknown>,
  priceKey: string,
  historyKey: string,
): void {
  const toNum = (v: unknown): number | null => {
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "string") {
      const n = Number(v.replace(/[\s\u00A0\u202F]/g, "").replace(",", "."));
      return Number.isFinite(n) && v.trim().length > 0 ? n : null;
    }
    return null;
  };
  if (!(priceKey in newAttrs)) return;
  const oldPrice = toNum(oldAttrs[priceKey]);
  const newPrice = toNum(newAttrs[priceKey]);
  if (oldPrice === null || newPrice === null || oldPrice === newPrice) return;
  const d = new Date();
  const stamp = `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
  const cur = oldAttrs[historyKey];
  const prev = typeof cur === "string" && cur.length > 0 ? `${cur}; ` : "";
  newAttrs[historyKey] = `${prev}${oldPrice.toLocaleString("ru-RU")} сум (до ${stamp})`;
}

/** Сегодняшний календарный день по Ташкенту (YYYY-MM-DD). */
function todayTashkent(now = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: TZ });
}

/**
 * Поиск по имени.
 *
 * Два подвоха, оба обнаружены проверкой:
 * 1) `%` и `_` — это подстановочные знаки LIKE. Без экранирования запрос
 *    «АР-100%» возвращал весь реестр вместо одной карточки.
 * 2) ILIKE не сворачивает регистр кириллицы, если база создана с локалью C:
 *    «ооо глоберент» строчными не находило карточку. Явная коллация ICU
 *    решает это независимо от настроек инстанса.
 */
export function nameMatches(query: string): SQL {
  const escaped = query.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  const pattern = `%${escaped}%`;
  return sql`${entity.name} ILIKE ${pattern} ESCAPE '\\' COLLATE "und-x-icu"`;
}

/**
 * Единый реестр сущностей (ТЗ FR-5): контрагенты, договоры, автоматы, техника, объекты.
 * Одна карточка на сущность вместо дублей в пяти местах.
 */
@Injectable()
export class EntitiesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /**
   * Утвердить карточку: слово владельца делает её фактом.
   *
   * Вместе с карточкой утверждаются и все предложенные ей значения, если
   * владелец этого попросил: разбирать четырнадцать позиций по одному полю —
   * та же лишняя работа, от которой мы уходили.
   */
  async approve(id: string, actorRef = "owner", withDrafts = true): Promise<EntityRow> {
    const [card] = await this.db.select().from(entity).where(eq(entity.id, id));
    if (!card) throw new NotFoundException("Карточки нет");
    return this.db.transaction(async (tx) => {
      const attrs = { ...((card.attrs ?? {}) as Record<string, unknown>) };
      let name = card.name;
      if (withDrafts) {
        const drafts = await tx.select().from(entityDraft).where(eq(entityDraft.entityId, id));
        for (const d of drafts) {
          if (d.field === "название") name = d.value;
          else attrs[d.field] = d.value;
        }
        await tx.delete(entityDraft).where(eq(entityDraft.entityId, id));
      }
      const [updated] = await tx
        .update(entity)
        .set({ name, attrs, approvedAt: new Date(), approvedBy: actorRef, updatedAt: new Date() })
        .where(eq(entity.id, id))
        .returning();
      // Утверждённые координаты — в типизированную точку; битую пару из
      // источника не роняем (strict=false), а честно оставляем как есть.
      await syncGeoPoint(tx, id, attrs, false);
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "entity.approve",
        target: id,
        before: card,
        after: updated,
      });
      return updated;
    });
  }

  /**
   * Утвердить пачку карточек разом — очередь даёт «утвердить все новые».
   *
   * Каждая карточка утверждается СВОЕЙ транзакцией (как одиночная), вместе со
   * всем предложенным ей. Одна пропавшая или уже утверждённая не роняет
   * остальные: её пропускаем и считаем отдельно — владелец увидит, сколько
   * прошло, а сколько нет.
   */
  async approveMany(
    ids: string[],
    actorRef = "owner",
  ): Promise<{ approved: number; skipped: number }> {
    let approved = 0;
    let skipped = 0;
    for (const id of [...new Set(ids)]) {
      const [card] = await this.db
        .select({ approvedAt: entity.approvedAt })
        .from(entity)
        .where(eq(entity.id, id));
      // Уже утверждённую повторно не трогаем — «утвердить» дважды бессмысленно.
      if (!card || card.approvedAt !== null) {
        skipped += 1;
        continue;
      }
      try {
        await this.approve(id, actorRef, true);
        approved += 1;
      } catch {
        skipped += 1;
      }
    }
    return { approved, skipped };
  }

  /**
   * Предложить значение поля карточки.
   *
   * Значение НЕ попадает в карточку: пока оно здесь, оно не факт, и всё, что
   * считается поверх реестра — фискальная готовность, журнал, сверки, — его не
   * видит. Промежуточного состояния «вроде записано, но не совсем» быть не
   * должно.
   */
  async propose(input: {
    entityId: string;
    field: string;
    value: string;
    origin: string;
    setBy?: string;
    note?: string;
  }): Promise<{ ok: true }> {
    const [card] = await this.db.select().from(entity).where(eq(entity.id, input.entityId));
    if (!card) throw new NotFoundException("Карточки нет");
    const attrs = (card.attrs ?? {}) as Record<string, unknown>;
    const current =
      input.field === "название" ? card.name : (attrs[input.field] as string | undefined);
    // Предлагать то, что уже стоит, незачем — это шум, а не решение.
    if (String(current ?? "") === input.value) return { ok: true };
    const values = {
      entityId: input.entityId,
      field: input.field,
      value: input.value,
      current: current === undefined ? null : String(current),
      origin: input.origin,
      setBy: input.setBy ?? "system",
      note: input.note ?? null,
      updatedAt: new Date(),
    };
    await this.db
      .insert(entityDraft)
      .values(values)
      .onConflictDoUpdate({ target: [entityDraft.entityId, entityDraft.field], set: values });
    return { ok: true };
  }

  /** Утвердить одно предложенное значение. */
  async approveField(entityId: string, field: string, actorRef = "owner"): Promise<EntityRow> {
    const [draft] = await this.db
      .select()
      .from(entityDraft)
      .where(and(eq(entityDraft.entityId, entityId), eq(entityDraft.field, field)));
    if (!draft) throw new NotFoundException("Такого предложения нет");
    const [card] = await this.db.select().from(entity).where(eq(entity.id, entityId));
    if (!card) throw new NotFoundException("Карточки нет");
    return this.db.transaction(async (tx) => {
      const attrs = { ...((card.attrs ?? {}) as Record<string, unknown>) };
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (field === "название") patch.name = draft.value;
      else {
        attrs[field] = draft.value;
        patch.attrs = attrs;
      }
      const [updated] = await tx.update(entity).set(patch).where(eq(entity.id, entityId)).returning();
      await tx.delete(entityDraft).where(eq(entityDraft.id, draft.id));
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "entity.field.approve",
        target: entityId,
        before: card,
        after: updated,
      });
      return updated;
    });
  }

  /**
   * Отклонить предложенное значение.
   *
   * Уходит без следа в карточке: «отклонено» — это решение, а не запись данных.
   * След остаётся в журнале действий, где ему и место.
   */
  async rejectField(entityId: string, field: string, actorRef = "owner"): Promise<{ ok: true }> {
    const [draft] = await this.db
      .select()
      .from(entityDraft)
      .where(and(eq(entityDraft.entityId, entityId), eq(entityDraft.field, field)));
    if (!draft) return { ok: true };
    await this.db.delete(entityDraft).where(eq(entityDraft.id, draft.id));
    await this.audit.record({
      actorKind: "human",
      actorRef,
      action: "entity.field.reject",
      target: entityId,
      before: draft,
    });
    return { ok: true };
  }

  /** Предложенные значения карточки. Пусто — предлагать нечего. */
  async drafts(entityId: string) {
    return this.db
      .select()
      .from(entityDraft)
      .where(eq(entityDraft.entityId, entityId))
      .orderBy(entityDraft.field);
  }

  /** Всё, что ждёт слова владельца: карточки и предложенные значения. */
  async pending(): Promise<{
    cards: EntityRow[];
    fields: (typeof entityDraft.$inferSelect & { entityName: string; entityType: string })[];
  }> {
    const cards = await this.db
      .select()
      .from(entity)
      .where(sql`${entity.approvedAt} is null`)
      .orderBy(desc(entity.createdAt));
    const fields = await this.db
      .select({
        id: entityDraft.id,
        entityId: entityDraft.entityId,
        field: entityDraft.field,
        value: entityDraft.value,
        current: entityDraft.current,
        origin: entityDraft.origin,
        setBy: entityDraft.setBy,
        note: entityDraft.note,
        createdAt: entityDraft.createdAt,
        updatedAt: entityDraft.updatedAt,
        entityName: entity.name,
        entityType: entity.type,
      })
      .from(entityDraft)
      .innerJoin(entity, eq(entity.id, entityDraft.entityId))
      .orderBy(entity.name);
    return { cards, fields };
  }

  /** id направления по коду; направления заводятся структурным сидом. */
  private async orgIdByDomain(domain: Domain): Promise<string> {
    const [row] = await this.db.select({ id: org.id }).from(org).where(eq(org.code, domain));
    if (!row) {
      throw new NotFoundException(
        `Направление "${domain}" не заведено в таблице org. Выполните структурный сид (pnpm db:seed).`,
      );
    }
    return row.id;
  }

  /** Создание и запись в журнал — одной транзакцией (данные без следа недопустимы). */
  async create(dto: CreateEntityDto, actorRef = "system"): Promise<EntityRow> {
    const orgId = await this.orgIdByDomain(dto.domain);
    // ИНН контрагента уникален (правило PROMACH): при дубле отвечаем адресом
    // существующей карточки — панель предложит «открыть существующего», а не
    // молча заведёт двойника. Гонку добивает частичный индекс ux_entity_contractor_inn.
    await this.rejectDuplicateInn(dto.type, dto.externalRef ?? null, null);
    // Слово владельца — единственное, что делает запись реестра фактом. Всё,
    // что завёл не он (выгрузка источника, код, агент), ждёт утверждения:
    // карточка видна, но фактом не считается и помечена отдельно.
    const fromSource = (dto.createdFrom ?? "").trim();
    const byOwner = fromSource.length === 0;
    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(entity)
        .values({
          orgId,
          type: dto.type,
          name: dto.name,
          externalRef: dto.externalRef ?? null,
          attrs: dto.attrs ?? {},
          createdFrom: byOwner ? null : fromSource,
          approvedAt: byOwner ? new Date() : null,
          approvedBy: byOwner ? actorRef : null,
        })
        .returning();

      // Координаты — числами с проверкой диапазона, в той же транзакции.
      await syncGeoPoint(tx, created.id, (dto.attrs ?? {}) as Record<string, unknown>);

      await tx.insert(auditLog).values({
        actorKind: "system",
        actorRef,
        action: "entity.create",
        target: created.id,
        after: created,
      });
      return created;
    });
  }

  async find(
    filter: FindEntitiesDto,
  ): Promise<(EntityRow & { domain: string | null; geo: Geo | null })[]> {
    const conditions: SQL[] = [];
    // Фильтр по id раньше объявлялся, но не применялся: клиент получал весь
    // реестр и мог принять чужую карточку за найденную.
    if (filter.id) conditions.push(eq(entity.id, filter.id));
    if (filter.domain) conditions.push(eq(entity.orgId, await this.orgIdByDomain(filter.domain)));
    if (filter.type) conditions.push(eq(entity.type, filter.type));
    if (filter.q) conditions.push(nameMatches(filter.q));

    // Домен добавляется к каждой строке: реестр показывается по направлениям,
    // и без этого поля клиенту пришлось бы угадывать, чьё это.
    const rows = await this.db
      .select({
        id: entity.id,
        orgId: entity.orgId,
        type: entity.type,
        name: entity.name,
        externalRef: entity.externalRef,
        attrs: entity.attrs,
        // Состояние утверждения едет вместе с карточкой: экран обязан отличать
        // то, что владелец подтвердил, от того, что вписали за него.
        approvedAt: entity.approvedAt,
        approvedBy: entity.approvedBy,
        createdFrom: entity.createdFrom,
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
        domain: org.code,
      })
      .from(entity)
      .leftJoin(org, eq(org.id, entity.orgId))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(entity.createdAt))
      .limit(500);
    const geos = await this.geoFor(rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, geo: geos.get(r.id) ?? null }));
  }

  /** Типизированные точки по набору карточек — для чтения вместе с ними. */
  private async geoFor(ids: string[]): Promise<Map<string, Geo>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.select().from(geoPoint).where(inArray(geoPoint.entityId, ids));
    return new Map(
      rows.map((g) => [g.entityId, { lat: Number(g.lat), lng: Number(g.lng), address: g.address }]),
    );
  }

  async byId(id: string): Promise<EntityRow & { domain: string | null; geo: Geo | null }> {
    const [row] = await this.db
      .select({
        id: entity.id,
        orgId: entity.orgId,
        type: entity.type,
        name: entity.name,
        externalRef: entity.externalRef,
        attrs: entity.attrs,
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
        domain: org.code,
      })
      .from(entity)
      .leftJoin(org, eq(org.id, entity.orgId))
      .where(eq(entity.id, id));
    if (!row) throw new NotFoundException(`Сущность ${id} не найдена`);
    const geos = await this.geoFor([id]);
    return { ...(row as EntityRow & { domain: string | null }), geo: geos.get(id) ?? null };
  }

  /**
   * Удаление записи — руками владельца, с полным следом в журнале.
   *
   * Запись стирается, но её содержимое остаётся в журнале (before):
   * «что это было и когда убрали» можно посмотреть всегда.
   */
  async remove(id: string, actorRef = "owner"): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(entity).where(eq(entity.id, id)).for("update");
      if (!before) throw new NotFoundException(`Сущность ${id} не найдена`);
      await tx.delete(entity).where(eq(entity.id, id));
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "entity.delete",
        target: id,
        before,
      });
    });
  }

  /**
   * Правка карточки.
   *
   * Строка блокируется на время транзакции (FOR UPDATE). Без блокировки две
   * одновременные правки одной карточки давали обе HTTP 200, но в базе
   * оставалась только одна — вторая исчезала молча, а журнал приписывал
   * изменения не тому автору.
   */
  async update(id: string, dto: UpdateEntityDto, actorRef = "system"): Promise<EntityRow> {
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(entity).where(eq(entity.id, id)).for("update");
      if (!before) throw new NotFoundException(`Сущность ${id} не найдена`);
      if (dto.externalRef !== undefined) {
        await this.rejectDuplicateInn(before.type, dto.externalRef ?? null, id);
      }

      // История цен (слово владельца): смена цены не стирает старую, а
      // дописывает её в поле-историю — видно прямо в карточке товара. Так ведём
      // и цену продажи, и цену ПОКУПКИ (для перепродажи это себестоимость): у
      // каждой своя история, путать их нельзя.
      if (dto.attrs) {
        const oldAttrs = (before.attrs ?? {}) as Record<string, unknown>;
        appendPriceHistory(oldAttrs, dto.attrs, "цена", "история цен");
        appendPriceHistory(oldAttrs, dto.attrs, "цена покупки", "история цены покупки");
      }

      const [updated] = await tx
        .update(entity)
        .set({
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.externalRef !== undefined ? { externalRef: dto.externalRef } : {}),
          ...(dto.attrs !== undefined ? { attrs: dto.attrs } : {}),
          updatedAt: new Date(),
        })
        .where(eq(entity.id, id))
        .returning();

      // Координаты правятся через attrs — держим типизированную точку в согласии.
      // Только когда attrs пришли: частичное обновление их не трогает.
      if (dto.attrs !== undefined) {
        await syncGeoPoint(tx, id, updated.attrs as Record<string, unknown>);
      }

      await tx.insert(auditLog).values({
        actorKind: "system",
        actorRef,
        action: "entity.update",
        target: id,
        before,
        after: updated,
      });
      return updated;
    });
  }

  /**
   * Поиск дублей контрагента по externalRef (обычно ИНН).
   * Ф3 показал: один контрагент заведён в 4 схемах с разными ключами —
   * это вход для сведения единого справочника.
   */
  async duplicatesByExternalRef(externalRef: string): Promise<EntityRow[]> {
    return this.db.select().from(entity).where(eq(entity.externalRef, externalRef));
  }

  /**
   * Дубль ИНН контрагента: структурный 409 с адресом существующей карточки
   * (UX донора PROMACH — «Открыть существующего клиента»). excludeId — сама
   * карточка при обновлении.
   */
  private async rejectDuplicateInn(
    type: string,
    externalRef: string | null,
    excludeId: string | null,
  ): Promise<void> {
    if (type !== "contractor") return;
    const inn = (externalRef ?? "").trim();
    if (inn === "") return;
    const [existing] = await this.db
      .select({ id: entity.id, name: entity.name })
      .from(entity)
      .where(and(eq(entity.type, "contractor"), eq(entity.externalRef, inn)))
      .limit(2);
    if (existing && existing.id !== excludeId) {
      throw new ConflictException({
        error: "duplicate_inn",
        message: `Контрагент с ИНН ${inn} уже заведён: ${existing.name}`,
        existingId: existing.id,
        existingName: existing.name,
      });
    }
  }

  /**
   * Рецепт товара: состав с именами ингредиентов и себестоимостью.
   *
   * Себестоимость считается ТУТ, на чтении, из текущих цен ингредиентов — не
   * хранится полем: так она не разойдётся с ценами (у донора кэш `totalCost`
   * расходился). Ингредиент без цены не обнуляется молча — строка помечена
   * непосчитанной, и итог честно неполон.
   */
  async recipeOf(productId: string): Promise<{
    productId: string;
    lines: {
      ingredientId: string;
      ingredientName: string | null;
      approved: boolean;
      quantity: number;
      unit: string;
      price: number | null;
      priceUnit: string | null;
      cost: number | null;
      why: string | null;
    }[];
    total: number;
    unresolved: number;
  }> {
    const [card] = await this.db.select().from(entity).where(eq(entity.id, productId));
    if (!card) throw new NotFoundException("Карточки нет");
    const lines = parseRecipe(card.attrs as Record<string, unknown>);

    const ids = [...new Set(lines.map((l) => l.ingredientId))];
    const ings =
      ids.length === 0
        ? []
        : await this.db.select().from(entity).where(inArray(entity.id, ids));
    const byId = new Map(ings.map((i) => [i.id, i]));

    const priceOf = (id: string): IngredientPrice => {
      const ing = byId.get(id);
      const a = (ing?.attrs ?? {}) as Record<string, unknown>;
      const raw = a["цена покупки"];
      const price =
        typeof raw === "number" && Number.isFinite(raw) && raw > 0
          ? raw
          : typeof raw === "string" && raw.trim().length > 0 && Number.isFinite(Number(raw))
            ? Number(raw)
            : null;
      const unit = isUnit(a["единица"]) ? (a["единица"] as Unit) : null;
      return { price, unit };
    };

    const costed = recipeCost(lines, priceOf);
    return {
      productId,
      total: costed.total,
      unresolved: costed.unresolved,
      lines: costed.lines.map((lc) => {
        const ing = byId.get(lc.line.ingredientId);
        const p = priceOf(lc.line.ingredientId);
        return {
          ingredientId: lc.line.ingredientId,
          ingredientName: ing?.name ?? null,
          approved: ing ? ing.approvedAt !== null : false,
          quantity: lc.line.quantity,
          unit: lc.line.unit,
          price: p.price,
          priceUnit: p.unit,
          cost: lc.cost,
          why: lc.why,
        };
      }),
    };
  }

  // ── Карточка автомата: вид (WAREHOUSE_SPEC §4.0) ───────────────────────────

  /** Карточки автоматов: entityId → вид. Без фильтра — все заведённые. */
  async machineCards(entityIds?: string[]): Promise<MachineCardRow[]> {
    if (entityIds && entityIds.length === 0) return [];
    return this.db
      .select()
      .from(machineCard)
      .where(entityIds ? inArray(machineCard.entityId, entityIds) : undefined)
      .limit(1000);
  }

  /**
   * Задать состояние автомата: в эксплуатации / на складе / в ремонте.
   *
   * Отдельный метод, а не поле в `setMachineKind`: вид и состояние меняются
   * по разным поводам и разными людьми. Вид называют один раз при заведении,
   * состояние — каждый раз, когда автомат уезжает в ремонт и возвращается.
   * Слив их в одну операцию заставил бы при отправке в ремонт заново называть
   * вид, а значит рано или поздно назвать его неверно.
   *
   * `statusChangedAt` двигается только при РЕАЛЬНОЙ смене состояния: правка
   * примечания не должна выглядеть как «уехал в ремонт заново», иначе
   * «в ремонте с …» врёт при каждом уточнении текста.
   *
   * Карточки вида может ещё не быть — тогда заводим её с `kind: "other"`
   * («не размечен»). Это не догадка о виде, а честная констатация: вид никто
   * не называл. Требовать сначала задать вид значило бы запретить отметить
   * поломку нового автомата.
   */
  async setMachineStatus(
    entityId: string,
    status: MachineStatus,
    actorRef = "owner",
    note?: string,
  ): Promise<MachineCardRow> {
    if (!(MACHINE_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException(`Неизвестное состояние автомата: ${status}`);
    }
    return this.db.transaction(async (tx) => {
      const [card] = await tx.select().from(entity).where(eq(entity.id, entityId)).limit(1);
      if (!card) throw new NotFoundException("Карточки нет");
      if (card.type !== "machine") {
        throw new BadRequestException(`Состояние задаётся только автоматам, а это «${card.type}»`);
      }

      const [before] = await tx
        .select()
        .from(machineCard)
        .where(eq(machineCard.entityId, entityId))
        .limit(1);

      const changed = before?.status !== status;
      const changedAt = changed ? new Date() : (before?.statusChangedAt ?? null);

      const [after] = await tx
        .insert(machineCard)
        .values({
          entityId,
          kind: "other",
          status,
          statusNote: note ?? null,
          statusChangedAt: changedAt,
          createdBy: actorRef,
          updatedBy: actorRef,
        })
        .onConflictDoUpdate({
          target: [machineCard.entityId],
          set: {
            status,
            ...(note !== undefined ? { statusNote: note } : {}),
            statusChangedAt: changedAt,
            updatedBy: actorRef,
            updatedAt: new Date(),
          },
        })
        .returning();

      // Побочные действия — только при РЕАЛЬНОЙ смене состояния и в той же
      // транзакции: состояние и график меняются вместе или никак.
      let anchorsReset = 0;
      let tasksCancelled = 0;
      if (changed && machineIsOperational(status)) {
        // Вернулся из ремонта. Пока автомат стоял, срок капал впустую, и без
        // пересчёта он придёт красным на весь простой — с задачей, датированной
        // прошлым, и без единого уведомления (ступени просрочки [1,3,7] на
        // 70-й день не срабатывают). Считаем от сегодня, как при снятии
        // норматива с паузы.
        const plans = await tx
          .select()
          .from(maintenancePlan)
          .where(and(eq(maintenancePlan.entityId, entityId), eq(maintenancePlan.isActive, true)));
        for (const plan of plans) {
          const next = firstDue(todayTashkent(), {
            everyDays: plan.everyDays,
            everyMonths: plan.everyMonths,
          });
          if (next === plan.dueOn) continue;
          await tx
            .update(maintenancePlan)
            .set({ dueOn: next, updatedAt: new Date() })
            .where(eq(maintenancePlan.id, plan.id));
          anchorsReset += 1;
        }
      } else if (changed && !machineIsOperational(status)) {
        // Уехал из эксплуатации. Открытые задачи по его обслуживанию выполнить
        // некому: автомата нет на месте. Оставить их нельзя — закрыть их тоже
        // некому (бот умеет только «сделал», отмена есть лишь в панели по
        // одной), и они будут вечно висеть в просрочке владельца.
        const cancelled = await tx
          .update(task)
          .set({ status: "cancelled" })
          .where(
            and(
              eq(task.entityId, entityId),
              sql`${task.source} like 'maint:%'`,
              sql`${task.status} not in ('done', 'cancelled')`,
            ),
          )
          .returning({ id: task.id });
        tasksCancelled = cancelled.length;
      }

      await tx.insert(auditLog).values({
        actorKind: actorKindOf(actorRef),
        actorRef,
        // Возврат в строй — отдельное событие: по нему считается, сколько
        // автомат простоял, и его ищут в журнале иначе, чем отправку в ремонт.
        action:
          changed && status === "in_service" ? "machine.status_restored" : "machine.status_changed",
        target: entityId,
        before: before ?? null,
        after: { ...after, anchorsReset, tasksCancelled },
      });
      return after;
    });
  }

  /**
   * Задать вид автомата.
   *
   * Проверяем, что карточка вообще автомат: вид у договора или контрагента
   * бессмыслен, а молча записанная строка потом всплывёт в отчёте как
   * «неразмеченный автомат», которого не существует.
   *
   * Пишем в аудит с переданным актором. Для трёх автоматов, которые владелец
   * размечает руками, это единственный способ потом отличить его решение от
   * результата массового backfill — а отличать придётся: догадка и решение
   * имеют разный вес.
   */
  async setMachineKind(
    entityId: string,
    kind: MachineKind,
    actorRef = "owner",
    note?: string,
  ): Promise<MachineCardRow> {
    if (!(MACHINE_KINDS as readonly string[]).includes(kind)) {
      throw new BadRequestException(`Неизвестный вид автомата: ${kind}`);
    }
    return this.db.transaction(async (tx) => {
      const [card] = await tx.select().from(entity).where(eq(entity.id, entityId)).limit(1);
      if (!card) throw new NotFoundException("Карточки нет");
      if (card.type !== "machine") {
        throw new BadRequestException(`Вид задаётся только автоматам, а это «${card.type}»`);
      }

      const [before] = await tx
        .select()
        .from(machineCard)
        .where(eq(machineCard.entityId, entityId))
        .limit(1);

      const [after] = await tx
        .insert(machineCard)
        .values({ entityId, kind, note: note ?? null, createdBy: actorRef, updatedBy: actorRef })
        .onConflictDoUpdate({
          target: [machineCard.entityId],
          // updatedBy обновляем, createdBy — нет: карточку завёл кто завёл, а
          // вид ставил тот, кто ставил последним. Без этой строки любая
          // карточка вечно выглядела бы размеченной массовым прогоном, даже
          // там, где вид назвал владелец.
          set: { kind, ...(note !== undefined ? { note } : {}), updatedBy: actorRef, updatedAt: new Date() },
        })
        .returning();

      await tx.insert(auditLog).values({
        actorKind: actorKindOf(actorRef),
        actorRef,
        action: before ? "machine.kind_changed" : "machine.kind_set",
        target: entityId,
        before: before ?? null,
        after,
      });
      return after;
    });
  }
}
