import type { CoreClient } from "./core-client";

/** Уведомление к отправке: текст и его стабильный ключ доставки. */
export interface PendingNote {
  key: string;
  text: string;
}

export const NOTIFIER_STARTUP_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
export const NOTIFIER_DELIVERY_BATCH = 100;

interface CatchupScan {
  until: Date;
  after?: { occurredAt: string; eventId: string };
}

/**
 * Доставка срочных уведомлений (ТЗ FR-2: событие → правило → сообщение).
 *
 * Опрашивает Core и шлёт только то, что правила пометили как немедленное:
 * и бизнес-тревоги владельца, и операционные LLM-инциденты. Доставка «ровно один раз» держится на
 * Core, а не на памяти бота: `collect` отдаёт то, что Core ещё не считает
 * доставленным, а `ack` отмечает доставку — и его зовут ПОСЛЕ успешной отправки
 * в Telegram. Сорвалась отправка — ключ не отмечен, и на следующем опросе
 * уведомление придёт снова, а не потеряется. Перезапуск бота ничего не двоит:
 * отметки лежат в Core.
 */
export class Notifier {
  private since: Date;
  /** Отмеченные в этой сессии — быстрый заслон от повторной отправки в окне
   *  между `ack` и тем, как Core это учтёт. Истина всё равно в Core. */
  private readonly acked = new Set<string>();
  /** Unacked notes stay in memory even after the event scan cursor advances. */
  private readonly pending = new Map<string, string>();
  private scan: CatchupScan | null = null;
  private readonly memoryLimit: number;

  constructor(
    private readonly core: CoreClient,
    startFrom: Date = new Date(Date.now() - NOTIFIER_STARTUP_LOOKBACK_MS),
    memoryLimit = 5000,
  ) {
    this.since = startFrom;
    this.memoryLimit = Math.max(NOTIFIER_DELIVERY_BATCH, Math.floor(memoryLimit));
  }

  /** Что нужно отправить владельцу. НЕ отмечает доставку — это делает `ack`. */
  async collect(now: Date = new Date()): Promise<PendingNote[]> {
    // During a long Telegram outage, stop advancing Core's durable cursor once
    // the local retry buffer reaches its high-water mark. No event is skipped:
    // scanning resumes from the same cursor after successful acknowledgements.
    if (this.pending.size < this.memoryLimit) {
      // Drain the oldest already-fetched notes first. They may have failed in
      // Telegram after Core's event cursor moved; memory keeps at-least-once
      // delivery within this process, while the 7-day scan repairs a restart.
      this.scan ??= { until: now };
      const result = await this.core.pendingNotifications(this.since, {
        until: this.scan.until,
        ...(this.scan.after ? { after: this.scan.after } : {}),
      });

      for (const n of result.notifications) {
        const key = `${n.eventId}:${n.ruleId}`;
        if (this.acked.has(key)) continue;
        this.pending.set(key, n.text);
      }

      if (result.truncated) {
        if (result.nextCursor === null) {
          throw new Error("Core вернул truncated без notification cursor");
        }
        if (
          this.scan.after?.occurredAt === result.nextCursor.occurredAt &&
          this.scan.after.eventId === result.nextCursor.eventId
        ) {
          throw new Error("Core не продвинул notification cursor");
        }
        this.scan.after = result.nextCursor;
      } else {
        // Fix the upper bound at scan start. Events written while a long
        // catch-up is running are picked up by the next overlapping scan.
        this.since = new Date(this.scan.until.getTime() - 5_000);
        this.scan = null;
      }
    }

    const batch = [...this.pending.entries()]
      .slice(0, NOTIFIER_DELIVERY_BATCH)
      .map(([key, text]) => ({ key, text }));
    return batch;
  }

  /**
   * Отметить доставленными — ТОЛЬКО после успешной отправки. Персистит в Core;
   * при ошибке персиста ключи не запоминаются, и уведомление придёт снова
   * (доставка «хотя бы один раз»).
   */
  async ack(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.core.ackNotifications(keys);
    for (const k of keys) {
      this.pending.delete(k);
      this.acked.add(k);
    }
    if (this.acked.size > this.memoryLimit) this.acked.clear();
  }
}
