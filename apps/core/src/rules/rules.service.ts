import { Inject, Injectable } from "@nestjs/common";
import { notificationDelivery } from "@mydon/db";
import { inArray } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { EventsService } from "../events/events.service";
import { applyRules, immediateOnly, RULES, type Notification } from "./rules";

export interface PendingNotifications {
  since: string;
  events: number;
  notifications: (Notification & { eventId: string; occurredAt: string })[];
}

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
  async pending(since: Date, onlyImmediate = false): Promise<PendingNotifications> {
    const events = await this.events.list({ since, limit: 500 });
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
          events: events.length,
          notifications: out.filter((n) => !delivered.has(this.key(n.eventId, n.ruleId))),
        };
      }
    }

    return { since: since.toISOString(), events: events.length, notifications: out };
  }

  /** Проверка правила на выдуманном событии — без записи в шину. */
  dryRun(type: string, payload: Record<string, unknown>, source = "dry-run") {
    return applyRules({ source, type, payload });
  }
}
