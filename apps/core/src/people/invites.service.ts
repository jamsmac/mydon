import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { auditLog, person, staffInvite } from "@mydon/db";
import {
  generateInviteCode,
  hashInviteCode,
  inviteExpiry,
  isInviteExpired,
  normalizeRoles,
  type StaffRole,
} from "@mydon/shared";
import { and, eq, isNull } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";

type PersonRow = typeof person.$inferSelect;

/**
 * Приглашения сотрудников.
 *
 * Заменяют привязку по @username: ник в Telegram освобождается после смены,
 * и любой, кто его займёт, получал доступ к чужой карточке со всеми задачами.
 * Приглашение знает только тот, кому его дали лично.
 *
 * Перец берётся из окружения. Пустой перец не считается ошибкой запуска —
 * иначе обновление уронило бы Core на живом сервере, — но громко сообщается
 * в лог: хеши без перца подбираются по радужной таблице.
 */
@Injectable()
export class InvitesService {
  private readonly pepper: string;

  constructor(@Inject(DB) private readonly db: Db) {
    this.pepper = process.env.INVITE_PEPPER ?? "";
    if (this.pepper.length < 16) {
      console.warn(
        "INVITE_PEPPER не задан или короче 16 символов — коды приглашений слабо защищены. " +
          "Задайте случайную строку в .env.",
      );
    }
  }

  /**
   * Выпустить приглашение. Прежнее живое гасится: две рабочие ссылки на
   * одного человека — это вопрос «а какая из них настоящая».
   */
  async issue(
    personId: string,
    roles: string[],
    actorRef = "owner",
  ): Promise<{ code: string; expiresAt: Date; person: PersonRow }> {
    const clean = normalizeRoles(roles);
    const code = generateInviteCode();
    const expiresAt = inviteExpiry();

    return this.db.transaction(async (tx) => {
      const [target] = await tx.select().from(person).where(eq(person.id, personId)).limit(1);
      if (!target) throw new NotFoundException("Сотрудника нет");
      if (target.active !== "yes") throw new BadRequestException("Карточка сотрудника неактивна");

      await tx
        .update(staffInvite)
        .set({ revokedAt: new Date() })
        .where(and(eq(staffInvite.personId, personId), isNull(staffInvite.usedAt), isNull(staffInvite.revokedAt)));

      const [created] = await tx
        .insert(staffInvite)
        .values({
          personId,
          codeHash: hashInviteCode(code, this.pepper),
          roles: clean,
          expiresAt,
          createdBy: actorRef,
        })
        .returning();

      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "person.invite_issued",
        target: personId,
        // Код в журнал НЕ пишется: журнал читают, а приглашение — секрет.
        after: { inviteId: created.id, roles: clean, expiresAt },
      });

      return { code, expiresAt, person: target };
    });
  }

  /**
   * Погасить приглашение и привязать Telegram.
   *
   * Поиск идёт по хешу, а не перебором записей: сравнивать код с каждой
   * строкой означало бы время ответа, зависящее от числа приглашений.
   */
  async redeem(code: string, chatId: string): Promise<PersonRow> {
    const hash = hashInviteCode(code, this.pepper);

    return this.db.transaction(async (tx) => {
      const [invite] = await tx
        .select()
        .from(staffInvite)
        .where(and(eq(staffInvite.codeHash, hash), isNull(staffInvite.usedAt), isNull(staffInvite.revokedAt)))
        .limit(1);
      // Одна формулировка на «нет такого» и «уже погашено»: разные ответы
      // подсказали бы перебирающему, что код существует.
      if (!invite) throw new BadRequestException("Приглашение не найдено или уже использовано");
      if (isInviteExpired(invite.expiresAt)) {
        throw new BadRequestException("Приглашение просрочено — попроси новое");
      }

      const [target] = await tx.select().from(person).where(eq(person.id, invite.personId)).limit(1);
      if (!target || target.active !== "yes") {
        // Транзакция откатится: неактивная карточка не должна сжигать
        // приглашение — иначе владельцу придётся выпускать его заново.
        throw new BadRequestException("Карточка сотрудника неактивна — скажи владельцу");
      }

      // Освобождаем chat_id, если он был привязан к другому человеку:
      // один Telegram — один сотрудник.
      await tx
        .update(person)
        .set({ tgChatId: null })
        .where(and(eq(person.tgChatId, chatId), eq(person.active, "yes")));

      const [linked] = await tx
        .update(person)
        .set({
          tgChatId: chatId,
          roles: invite.roles.length > 0 ? invite.roles : target.roles,
        })
        .where(eq(person.id, target.id))
        .returning();

      const [used] = await tx
        .update(staffInvite)
        .set({ usedAt: new Date(), usedByChatId: chatId })
        .where(eq(staffInvite.id, invite.id))
        .returning();

      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef: `person:${target.id}`,
        action: "person.invite_redeemed",
        target: target.id,
        before: target,
        after: { ...linked, inviteId: used.id },
      });

      return linked;
    });
  }

  /** Отозвать доступ: снять привязку и погасить живые приглашения. */
  async revoke(personId: string, actorRef = "owner"): Promise<PersonRow> {
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(person).where(eq(person.id, personId)).limit(1);
      if (!before) throw new NotFoundException("Сотрудника нет");

      await tx
        .update(staffInvite)
        .set({ revokedAt: new Date() })
        .where(and(eq(staffInvite.personId, personId), isNull(staffInvite.usedAt), isNull(staffInvite.revokedAt)));

      const [after] = await tx
        .update(person)
        // Роли снимаем вместе с привязкой: карточка остаётся в реестре
        // (история работ на ней), но прав у неё больше нет.
        .set({ tgChatId: null, roles: [] })
        .where(eq(person.id, personId))
        .returning();

      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "person.access_revoked",
        target: personId,
        before,
        after,
      });
      return after;
    });
  }

  /** Проставить роли без выпуска приглашения — правка уже подключённого. */
  async setRoles(personId: string, roles: string[], actorRef = "owner"): Promise<PersonRow> {
    const clean: StaffRole[] = normalizeRoles(roles);
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(person).where(eq(person.id, personId)).limit(1);
      if (!before) throw new NotFoundException("Сотрудника нет");
      const [after] = await tx
        .update(person)
        .set({ roles: clean })
        .where(eq(person.id, personId))
        .returning();
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "person.roles_changed",
        target: personId,
        before,
        after,
      });
      return after;
    });
  }
}
