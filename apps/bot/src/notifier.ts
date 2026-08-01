import type { CoreClient } from "./core-client";

/** Уведомление к отправке: текст и его стабильный ключ доставки. */
export interface PendingNote {
  key: string;
  text: string;
}

/**
 * Доставка срочных уведомлений (ТЗ FR-2: событие → правило → сообщение).
 *
 * Опрашивает Core и шлёт только то, что правила пометили как немедленное
 * (четыре тревоги владельца из Ф11). Доставка «ровно один раз» держится на
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

  constructor(
    private readonly core: CoreClient,
    startFrom: Date = new Date(),
    private readonly memoryLimit = 5000,
  ) {
    this.since = startFrom;
  }

  /** Что нужно отправить владельцу. НЕ отмечает доставку — это делает `ack`. */
  async collect(now: Date = new Date()): Promise<PendingNote[]> {
    const result = await this.core.pendingNotifications(this.since);
    const fresh: PendingNote[] = [];

    for (const n of result.notifications) {
      const key = `${n.eventId}:${n.ruleId}`;
      if (this.acked.has(key)) continue; // уже отправили в этой сессии
      fresh.push({ key, text: n.text });
    }

    // Окно двигаем с небольшим перекрытием, чтобы не потерять события,
    // записанные в ту же секунду, что и предыдущий опрос. Даже если окно уедет
    // вперёд, Core не отдаст уже доставленное — потери нет.
    this.since = new Date(now.getTime() - 5_000);
    return fresh;
  }

  /**
   * Отметить доставленными — ТОЛЬКО после успешной отправки. Персистит в Core;
   * при ошибке персиста ключи не запоминаются, и уведомление придёт снова
   * (доставка «хотя бы один раз»).
   */
  async ack(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.core.ackNotifications(keys);
    for (const k of keys) this.acked.add(k);
    if (this.acked.size > this.memoryLimit) this.acked.clear();
  }
}
