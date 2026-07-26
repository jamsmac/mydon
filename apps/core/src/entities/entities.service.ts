import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { entity, org } from "@mydon/db";
import type { Domain } from "@mydon/shared";
import { and, desc, eq, ilike, type SQL } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { AuditService } from "../audit/audit.service";
import type { CreateEntityDto, FindEntitiesDto, UpdateEntityDto } from "./entity.dto";

type EntityRow = typeof entity.$inferSelect;

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

  async create(dto: CreateEntityDto, actorRef = "system"): Promise<EntityRow> {
    const orgId = await this.orgIdByDomain(dto.domain);
    const [created] = await this.db
      .insert(entity)
      .values({
        orgId,
        type: dto.type,
        name: dto.name,
        externalRef: dto.externalRef ?? null,
        attrs: dto.attrs ?? {},
      })
      .returning();

    await this.audit.record({
      actorKind: "system",
      actorRef,
      action: "entity.create",
      target: created.id,
      after: created,
    });
    return created;
  }

  async find(filter: FindEntitiesDto): Promise<EntityRow[]> {
    const conditions: SQL[] = [];
    if (filter.domain) conditions.push(eq(entity.orgId, await this.orgIdByDomain(filter.domain)));
    if (filter.type) conditions.push(eq(entity.type, filter.type));
    if (filter.q) conditions.push(ilike(entity.name, `%${filter.q}%`));

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

  async update(id: string, dto: UpdateEntityDto, actorRef = "system"): Promise<EntityRow> {
    const before = await this.byId(id);
    const [updated] = await this.db
      .update(entity)
      .set({
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.externalRef !== undefined ? { externalRef: dto.externalRef } : {}),
        ...(dto.attrs !== undefined ? { attrs: dto.attrs } : {}),
        updatedAt: new Date(),
      })
      .where(eq(entity.id, id))
      .returning();

    await this.audit.record({
      actorKind: "system",
      actorRef,
      action: "entity.update",
      target: id,
      before,
      after: updated,
    });
    return updated;
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
