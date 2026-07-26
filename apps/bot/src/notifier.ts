import type { CoreClient } from "./core-client";

/**
 * Доставка срочных уведомлений (ТЗ FR-2: событие → правило → сообщение).
 *
 * Опрашивает Core и шлёт только то, что правила пометили как немедленное
 * (четыре тревоги владельца из Ф11). Каждое уведомление доставляется один раз:
 * отправленные помним по паре «событие + правило».
 */
export class Notifier {
  private since: Date;
  private readonly delivered = new Set<string>();

  constructor(
    private readonly core: CoreClient,
    startFrom: Date = new Date(),
    private readonly memoryLimit = 5000,
  ) {
    this.since = startFrom;
  }

  /** Возвращает тексты, которые нужно отправить владельцу. */
  async collect(now: Date = new Date()): Promise<string[]> {
    const result = await this.core.pendingNotifications(this.since);
    const fresh: string[] = [];

    for (const n of result.notifications) {
      const key = `${n.eventId}:${n.ruleId}`;
      if (this.delivered.has(key)) continue;
      this.delivered.add(key);
      fresh.push(n.text);
    }

    // Окно двигаем с небольшим перекрытием, чтобы не потерять события,
    // записанные в ту же секунду, что и предыдущий опрос.
    this.since = new Date(now.getTime() - 5_000);

    if (this.delivered.size > this.memoryLimit) {
      // Простая защита от бесконечного роста: начинаем помнить заново.
      this.delivered.clear();
    }
    return fresh;
  }
}
