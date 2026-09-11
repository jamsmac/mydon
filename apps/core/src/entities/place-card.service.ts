import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { auditLog, entity, placeCard } from "@mydon/db";
import { actorKindOf, isPlaceOwnerType, isPlaceType, placeNameKeys } from "@mydon/shared";
import { and, eq, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DB, type Db } from "../db/db.module";
import { requestActor } from "../common/request-actor";

export interface PlaceOwnerRow {
  entityId: string;
  contractorId: string | null;
  contractorName: string | null;
  contractorType: string | null;
}

/**
 * Место принадлежит контрагенту (волна 2б, М-1, М-2, М-11).
 *
 * Ссылка — в тонкой таблице `place_card`, а не в attrs: её соединяют запросом
 * («все места KIUT») и держат внешним ключом. Владельцем помещения бывает
 * контрагент или наша компания (`own_company`: склады, мастерская — М-11);
 * пусто значит «не знаем, чьё помещение».
 */
@Injectable()
export class PlaceCardService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Владельцы всех мест одним запросом — для списка мест, карты и карточек. */
  async owners(): Promise<PlaceOwnerRow[]> {
    const owner = alias(entity, "owner");
    return this.db
      .select({
        entityId: placeCard.entityId,
        contractorId: placeCard.contractorId,
        contractorName: owner.name,
        contractorType: owner.type,
      })
      .from(placeCard)
      .leftJoin(owner, eq(owner.id, placeCard.contractorId));
  }

  /**
   * Назначить (или снять — `null`) владельца места. Имя места уникально В
   * ПРЕДЕЛАХ контрагента (М-10): два «4 корпус» у одного контрагента — ошибка
   * ввода, у разных — норма. Сравнение по ключу имени (регистр, пробелы, ё/е),
   * тем же, что автопривязка мест.
   */
  async setContractor(placeId: string, contractorId: string | null, actorRef = requestActor("owner")): Promise<PlaceOwnerRow> {
    return this.db.transaction(async (tx) => {
      const [place] = await tx.select().from(entity).where(eq(entity.id, placeId)).for("update");
      if (!place) throw new NotFoundException(`Место ${placeId} не найдено`);
      if (!isPlaceType(place.type)) throw new BadRequestException("Контрагента назначают только месту");

      let owner: { id: string; name: string; type: string } | null = null;
      if (contractorId !== null) {
        const [row] = await tx
          .select({ id: entity.id, name: entity.name, type: entity.type })
          .from(entity)
          .where(eq(entity.id, contractorId));
        if (!row) throw new NotFoundException(`Карточка ${contractorId} не найдена`);
        if (!isPlaceOwnerType(row.type)) {
          throw new BadRequestException("Владельцем места бывает контрагент или наша компания");
        }
        owner = row;

        const siblings = await tx
          .select({ id: entity.id, name: entity.name })
          .from(placeCard)
          .innerJoin(entity, eq(entity.id, placeCard.entityId))
          .where(and(eq(placeCard.contractorId, contractorId), ne(placeCard.entityId, placeId)));
        const mine = new Set(placeNameKeys(place.name));
        const clash = siblings.find((s) => placeNameKeys(s.name).some((k) => mine.has(k)));
        if (clash) {
          throw new ConflictException(
            `У «${owner.name}» уже есть место «${clash.name}» — имя места уникально в пределах контрагента`,
          );
        }
      }

      const [before] = await tx.select().from(placeCard).where(eq(placeCard.entityId, placeId));
      const [after] = await tx
        .insert(placeCard)
        .values({ entityId: placeId, contractorId, updatedBy: actorRef })
        .onConflictDoUpdate({
          target: placeCard.entityId,
          set: { contractorId, updatedBy: actorRef, updatedAt: new Date() },
        })
        .returning();

      await tx.insert(auditLog).values({
        actorKind: actorKindOf(actorRef),
        actorRef,
        action: "place.contractor_set",
        target: placeId,
        before: before ?? null,
        after: { ...after, contractorName: owner?.name ?? null },
      });
      return {
        entityId: placeId,
        contractorId,
        contractorName: owner?.name ?? null,
        contractorType: owner?.type ?? null,
      };
    });
  }

  /** Места контрагента — для его карточки. */
  async placesOf(contractorId: string): Promise<{ id: string; name: string; type: string }[]> {
    const rows = await this.db
      .select({ id: entity.id, name: entity.name, type: entity.type })
      .from(placeCard)
      .innerJoin(entity, eq(entity.id, placeCard.entityId))
      .where(eq(placeCard.contractorId, contractorId));
    return rows.filter((r) => isPlaceType(r.type));
  }
}

