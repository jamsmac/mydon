import { Injectable } from "@nestjs/common";
import { EventsService } from "../events/events.service";
import { applyRules, immediateOnly, RULES, type Notification } from "./rules";

export interface PendingNotifications {
  since: string;
  events: number;
  notifications: (Notification & { eventId: string; occurredAt: string })[];
}

@Injectable()
export class RulesService {
  constructor(private readonly events: EventsService) {}

  /** Список правил — владелец должен видеть, что и когда его побеспокоит. */
  list() {
    return RULES.map((r) => ({
      id: r.id,
      eventType: r.eventType,
      urgency: r.urgency,
      conditional: Boolean(r.when),
    }));
  }

  /** Уведомления по событиям с момента `since`. */
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

    return { since: since.toISOString(), events: events.length, notifications: out };
  }

  /** Проверка правила на выдуманном событии — без записи в шину. */
  dryRun(type: string, payload: Record<string, unknown>, source = "dry-run") {
    return applyRules({ source, type, payload });
  }
}
