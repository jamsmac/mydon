import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { auditLog, entity, entityDraft, org } from "@mydon/db";
import type { Domain } from "@mydon/shared";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { AuditService } from "../audit/audit.service";
import type { CreateEntityDto, FindEntitiesDto, UpdateEntityDto } from "./entity.dto";

type EntityRow = typeof entity.$inferSelect;

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

  async find(filter: FindEntitiesDto): Promise<(EntityRow & { domain: string | null })[]> {
    const conditions: SQL[] = [];
    // Фильтр по id раньше объявлялся, но не применялся: клиент получал весь
    // реестр и мог принять чужую карточку за найденную.
    if (filter.id) conditions.push(eq(entity.id, filter.id));
    if (filter.domain) conditions.push(eq(entity.orgId, await this.orgIdByDomain(filter.domain)));
    if (filter.type) conditions.push(eq(entity.type, filter.type));
    if (filter.q) conditions.push(nameMatches(filter.q));

    // Домен добавляется к каждой строке: реестр показывается по направлениям,
    // и без этого поля клиенту пришлось бы угадывать, чьё это.
    return this.db
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
  }

  async byId(id: string): Promise<EntityRow & { domain: string | null }> {
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
    return row as EntityRow & { domain: string | null };
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

      // История цен (слово владельца): смена цены не стирает старую, а
      // дописывает её в поле «история цен» — видно прямо в карточке товара.
      if (dto.attrs) {
        const oldAttrs = (before.attrs ?? {}) as Record<string, unknown>;
        const oldPrice = oldAttrs["цена"];
        const newPrice = dto.attrs["цена"];
        if (
          typeof oldPrice === "number" &&
          typeof newPrice === "number" &&
          oldPrice !== newPrice
        ) {
          const d = new Date();
          const stamp = `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
          const prev =
            typeof oldAttrs["история цен"] === "string" && oldAttrs["история цен"].length > 0
              ? `${oldAttrs["история цен"]}; `
              : "";
          dto.attrs["история цен"] = `${prev}${oldPrice.toLocaleString("ru-RU")} сум (до ${stamp})`;
        }
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
}
