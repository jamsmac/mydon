import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { auditLog, entity, org } from "@mydon/db";
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
    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(entity)
        .values({
          orgId,
          type: dto.type,
          name: dto.name,
          externalRef: dto.externalRef ?? null,
          attrs: dto.attrs ?? {},
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

  async find(filter: FindEntitiesDto): Promise<EntityRow[]> {
    const conditions: SQL[] = [];
    // Фильтр по id раньше объявлялся, но не применялся: клиент получал весь
    // реестр и мог принять чужую карточку за найденную.
    if (filter.id) conditions.push(eq(entity.id, filter.id));
    if (filter.domain) conditions.push(eq(entity.orgId, await this.orgIdByDomain(filter.domain)));
    if (filter.type) conditions.push(eq(entity.type, filter.type));
    if (filter.q) conditions.push(nameMatches(filter.q));

    return this.db
      .select()
      .from(entity)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(entity.createdAt))
      .limit(500);
  }

  async byId(id: string): Promise<EntityRow> {
    const [row] = await this.db.select().from(entity).where(eq(entity.id, id));
    if (!row) throw new NotFoundException(`Сущность ${id} не найдена`);
    return row;
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
