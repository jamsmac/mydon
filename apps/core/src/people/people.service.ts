import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { auditLog, person } from "@mydon/db";
import type { Domain } from "@mydon/shared";
import { and, asc, eq, isNotNull, ne, or } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";

type PersonRow = typeof person.$inferSelect;

export interface UpsertPersonInput {
  name: string;
  role?: string | null;
  email?: string | null;
  phone?: string | null;
  tgUsername?: string | null;
  domain?: Domain | null;
  active?: boolean;
}

/** @username в разных написаниях приводим к одному виду: без «@», в нижнем регистре. */
export function normalizeUsername(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const clean = raw.trim().replace(/^@+/, "").toLowerCase();
  return clean.length > 0 ? clean : null;
}

/**
 * Сотрудники (ТЗ §7 person).
 *
 * Задачи людям доходят через Telegram — значит нужны две разные вещи:
 * `tgUsername` владелец пишет руками, а `tgChatId` появляется сам, когда
 * сотрудник нажал /start у бота. Писать можно ТОЛЬКО по chat_id.
 *
 * Уволенный сотрудник не удаляется, а помечается неактивным: его задачи и
 * история должны остаться объяснимыми.
 */
@Injectable()
export class PeopleService {
  constructor(@Inject(DB) private readonly db: Db) {}

  list(opts: { includeInactive?: boolean } = {}): Promise<PersonRow[]> {
    return this.db
      .select()
      .from(person)
      .where(opts.includeInactive ? undefined : eq(person.active, "yes"))
      .orderBy(asc(person.name));
  }

  async byId(id: string): Promise<PersonRow> {
    const [row] = await this.db.select().from(person).where(eq(person.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Сотрудник ${id} не найден`);
    return row;
  }

  /** Кому можно писать в Telegram — только к тем, кто нажал /start. */
  linked(): Promise<PersonRow[]> {
    return this.db
      .select()
      .from(person)
      .where(and(eq(person.active, "yes"), isNotNull(person.tgChatId)))
      .orderBy(asc(person.name));
  }

  async create(input: UpsertPersonInput, actorRef = "owner"): Promise<PersonRow> {
    const uname = normalizeUsername(input.tgUsername);
    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(person)
        .values({
          name: input.name,
          role: input.role ?? null,
          email: input.email ?? null,
          phone: input.phone ?? null,
          tgUsername: uname,
          domain: input.domain ?? null,
          active: input.active === false ? "no" : "yes",
        })
        .returning();

      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "person.create",
        target: created.id,
        after: created,
      });
      return created;
    });
  }

  async update(id: string, patch: Partial<UpsertPersonInput>, actorRef = "owner"): Promise<PersonRow> {
    const before = await this.byId(id);
    const values: Record<string, unknown> = {};
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.role !== undefined) values.role = patch.role;
    if (patch.email !== undefined) values.email = patch.email;
    if (patch.phone !== undefined) values.phone = patch.phone;
    if (patch.tgUsername !== undefined) values.tgUsername = normalizeUsername(patch.tgUsername);
    if (patch.domain !== undefined) values.domain = patch.domain;
    if (patch.active !== undefined) values.active = patch.active ? "yes" : "no";

    return this.db.transaction(async (tx) => {
      const [updated] = await tx.update(person).set(values).where(eq(person.id, id)).returning();
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "person.update",
        target: id,
        before,
        after: updated,
      });
      return updated;
    });
  }

  /**
   * Привязка Telegram: сотрудник нажал /start.
   *
   * ВНИМАНИЕ: привязка по @username — дыра. Ник в Telegram освобождается
   * после смены, и любой, кто его займёт, получит карточку сотрудника со
   * всеми задачами. Штатный путь подключения теперь — одноразовое
   * приглашение (`InvitesService`), а этот остаётся аварийным и выключается
   * тумблером `STAFF_LINK_BY_USERNAME=0`.
   *
   * Повторный /start уже привязанного не ломает связь — поиск по chat_id
   * работает всегда, независимо от тумблера.
   */
  async linkTelegram(chatId: string, username: string | null): Promise<PersonRow | null> {
    // Выключено — ищем только по уже привязанному chat_id.
    const byUsernameAllowed = (process.env.STAFF_LINK_BY_USERNAME ?? "1") !== "0";
    const uname = byUsernameAllowed ? normalizeUsername(username) : null;
    const [found] = await this.db
      .select()
      .from(person)
      .where(
        and(
          eq(person.active, "yes"),
          uname
            ? or(eq(person.tgUsername, uname), eq(person.tgChatId, chatId))
            : eq(person.tgChatId, chatId),
        ),
      )
      .limit(1);

    if (!found) return null;
    if (found.tgChatId === chatId) return found; // уже привязан — повтор безопасен

    // Карточка найдена по username, но уже привязана к ДРУГОМУ чату — не
    // перехватываем. Освободившийся ник может занять кто угодно, и
    // перепривязка молча снимала бы карточку с настоящего сотрудника (имя,
    // роли, задачи) и отдавала её новому владельцу ника. Аварийный путь по
    // username остаётся только для карточек БЕЗ привязки; занятая карточка
    // переезжает на новый чат только одноразовым приглашением от владельца.
    if (found.tgChatId !== null) return null;

    return this.db.transaction(async (tx) => {
      // Освобождаем chat_id, если он был на другом сотруднике.
      await tx
        .update(person)
        .set({ tgChatId: null })
        .where(and(eq(person.tgChatId, chatId), ne(person.id, found.id)));

      const [linked] = await tx
        .update(person)
        .set({ tgChatId: chatId })
        .where(eq(person.id, found.id))
        .returning();

      await tx.insert(auditLog).values({
        actorKind: "system",
        actorRef: "telegram",
        action: "person.link_telegram",
        target: found.id,
        after: { name: linked.name, chatId },
      });
      return linked;
    });
  }

  /** Кто написал боту: по chat_id находим сотрудника. */
  async byChatId(chatId: string): Promise<PersonRow | null> {
    const [row] = await this.db
      .select()
      .from(person)
      .where(and(eq(person.tgChatId, chatId), eq(person.active, "yes")))
      .limit(1);
    return row ?? null;
  }
}
