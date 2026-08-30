import { Inject, Injectable } from "@nestjs/common";
import { notificationDelivery } from "@mydon/db";
import { inArray } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { EventsService } from "../events/events.service";
import { applyRules, immediateOnly, RULES, RULE_EVENT_TYPES, type Notification } from "./rules";

export interface PendingNotifications {
  since: string;
  /** Fixed upper bound of this catch-up scan; newer events belong to the next scan. */
  until: string;
  /** Сколько событий ПОД ПРАВИЛА нашлось в окне (шум крона сюда не входит). */
  events: number;
  /**
   * Окно упёрлось в лимит выборки: показано не всё, что случилось.
   *
   * Молчать об этом нельзя — обрезанная лента выглядит ровно как полная, и
   * ровно так на проде «сигналы за 14 суток» тихо превратились в 37 часов.
   */
  truncated: boolean;
  /** Strict oldest-first cursor for the next page when `truncated=true`. */
  nextCursor: { occurredAt: string; eventId: string } | null;
  notifications: (Notification & { eventId: string; occurredAt: string })[];
}

export interface PendingNotificationsPage {
  until: Date;
  after?: { occurredAt: Date; eventId: string };
}

/**
 * Потолок выборки событий под правила.
 *
 * Остаётся 500 — но теперь он режет ТОЛЬКО события, на которые есть правила
 * (`RULE_EVENT_TYPES`), а не всю ленту вперемешку с шумом крона. Упереться в
 * него по-прежнему можно, и тогда об этом говорит `truncated`.
 */
export const PENDING_EVENTS_LIMIT = 500;

@Injectable()
export class RulesService {
  constructor(
    private readonly events: EventsService,
    @Inject(DB) private readonly db: Db,
  ) {}

  /** Ключ уведомления: событие + правило, детерминированно и стабильно. */
  private key(eventId: string, ruleId: string): string {
    return `${eventId}:${ruleId}`;
  }

  /**
   * Отметить уведомления доставленными. Бот зовёт это ПОСЛЕ успешной отправки в
   * Telegram — до неё сигнал не считается дошедшим. Идемпотентно: повторная
   * отметка того же ключа ничего не ломает.
   */
  async ack(keys: string[]): Promise<{ acked: number }> {
    const clean = [...new Set(keys.filter((k) => typeof k === "string" && k.length > 0))];
    if (clean.length === 0) return { acked: 0 };
    await this.db
      .insert(notificationDelivery)
      .values(clean.map((key) => ({ key })))
      .onConflictDoNothing({ target: notificationDelivery.key });
    return { acked: clean.length };
  }

  /**
   * Атомарная заявка на одноразовое действие. Вернёт true ровно один раз
   * на ключ — дальше всегда false.
   *
   * Нужна рассылкам, которые идут по таймеру: перезапуск бота в 07:00:30 не
   * должен слать дайджест второй раз. `ack` для этого не годится — он не
   * различает «записал» и «уже было»; здесь ставку делает RETURNING.
   */
  async claim(key: string): Promise<boolean> {
    if (typeof key !== "string" || key.length === 0) return false;
    const rows = await this.db
      .insert(notificationDelivery)
      .values({ key })
      .onConflictDoNothing({ target: notificationDelivery.key })
      .returning({ key: notificationDelivery.key });
    return rows.length > 0;
  }

  /** Список правил — владелец должен видеть, что и когда его побеспокоит. */
  list() {
    return RULES.map((r) => ({
      id: r.id,
      eventType: r.eventType,
      urgency: r.urgency,
      conditional: Boolean(r.when),
    }));
  }

  /**
   * Уведомления по событиям с момента `since`, ЕЩЁ НЕ доставленные.
   *
   * Уже доставленное (отметка в notification_delivery) отсекается здесь, а не в
   * памяти бота: перезапуск бота не задвоит тревоги, а окно `since` может
   * перекрываться без риска повторной отправки.
   */
  async pending(
    since: Date,
    onlyImmediate = false,
    page?: PendingNotificationsPage,
  ): Promise<PendingNotifications> {
    // Фильтр по типам стоит В SQL, до лимита: иначе 500 свежайших строк
    // выбирает шум крона, а события правил остаются за окном (прод: 4315
    // событий за 14 суток, из них 4180 — `sales.sync`/`supply.sync`).
    const upper = page?.until ?? new Date();
    const candidates = await this.events.list(
      page
        ? {
            since,
            until: upper,
            ...(page.after
              ? { after: { occurredAt: page.after.occurredAt, id: page.after.eventId } }
              : {}),
            types: RULE_EVENT_TYPES,
            order: "asc",
            limit: PENDING_EVENTS_LIMIT + 1,
          }
        : { since, types: RULE_EVENT_TYPES, limit: PENDING_EVENTS_LIMIT },
    );
    const truncated = page
      ? candidates.length > PENDING_EVENTS_LIMIT
      : candidates.length >= PENDING_EVENTS_LIMIT;
    const events = page ? candidates.slice(0, PENDING_EVENTS_LIMIT) : candidates;
    const last = events.at(-1);
    const nextCursor =
      page && truncated && last
        ? { occurredAt: last.occurredAt.toISOString(), eventId: last.id }
        : null;
    const out: PendingNotifications["notifications"] = [];

    for (const e of events) {
      const payload = (e.payload ?? {}) as Record<string, unknown>;
      const matched = applyRules({ source: e.source, type: e.type, payload });
      const selected = onlyImmediate ? immediateOnly(matched) : matched;
      for (const n of selected) {
        out.push({ ...n, eventId: e.id, occurredAt: e.occurredAt.toISOString() });
      }
    }

    // Отсекаем уже доставленное: спрашиваем БД только по встретившимся ключам.
    const keys = out.map((n) => this.key(n.eventId, n.ruleId));
    if (keys.length > 0) {
      const done = await this.db
        .select({ key: notificationDelivery.key })
        .from(notificationDelivery)
        .where(inArray(notificationDelivery.key, keys));
      const delivered = new Set(done.map((d) => d.key));
      if (delivered.size > 0) {
        return {
          since: since.toISOString(),
          until: upper.toISOString(),
          events: events.length,
          truncated,
          nextCursor,
          notifications: out.filter((n) => !delivered.has(this.key(n.eventId, n.ruleId))),
        };
      }
    }

    return {
      since: since.toISOString(),
      until: upper.toISOString(),
      events: events.length,
      truncated,
      nextCursor,
      notifications: out,
    };
  }

  /** Проверка правила на выдуманном событии — без записи в шину. */
  dryRun(type: string, payload: Record<string, unknown>, source = "dry-run") {
    return applyRules({ source, type, payload });
  }
}
