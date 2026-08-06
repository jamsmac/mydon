/**
 * Ограничитель исходящих сообщений Telegram.
 *
 * У Bot API два разных лимита: ~30 сообщений в секунду суммарно и примерно
 * одно в секунду в один и тот же чат. Второй ловится раньше первого и бьёт
 * больнее: рассылка десяти карточек задач подряд одному человеку уходит
 * в 429, а с ней и всё, что стояло следом в очереди.
 *
 * Живёт внутри транспорта, а не в вызывающих: тогда он покрывает разом и
 * дайджест, и напоминания, и карточки, и брифинг — иначе каждый новый
 * рассыльщик пришлось бы вспоминать заново.
 */

/** Минимальный зазор между сообщениями в ОДИН чат. */
const PER_CHAT_MS = 1_100;
/** Минимальный зазор между сообщениями вообще (30/сек с запасом). */
const GLOBAL_MS = 40;
/** Через сколько забывать чат, чтобы карта не росла вечно. */
const FORGET_MS = 10 * 60_000;

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export class OutRate {
  private readonly lastByChat = new Map<number, number>();
  private lastAny = 0;
  /** До какого момента пауза для всех — выставляется по 429 retry_after. */
  private pausedUntil = 0;

  constructor(private readonly clock: Clock = realClock) {}

  /** Дождаться своей очереди на отправку в этот чат. */
  async take(chatId: number): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      const waits = [
        this.pausedUntil - now,
        (this.lastByChat.get(chatId) ?? 0) + PER_CHAT_MS - now,
        this.lastAny + GLOBAL_MS - now,
      ];
      const wait = Math.max(...waits);
      if (wait <= 0) {
        this.lastByChat.set(chatId, now);
        this.lastAny = now;
        return;
      }
      await this.clock.sleep(wait);
    }
  }

  /**
   * Telegram попросил подождать (429). Тормозим ВСЮ отправку, а не только
   * это сообщение: лимит общий, и попытка отправить следующее сразу же
   * получит тот же отказ и продлит наказание.
   */
  pause(seconds: number): void {
    const until = this.clock.now() + Math.max(1, seconds) * 1000;
    if (until > this.pausedUntil) this.pausedUntil = until;
  }

  /** Убрать давно неактивные чаты — иначе карта растёт вместе с историей. */
  sweep(): void {
    const cutoff = this.clock.now() - FORGET_MS;
    for (const [chatId, at] of this.lastByChat) {
      if (at < cutoff) this.lastByChat.delete(chatId);
    }
  }

  /** Сколько чатов помним — для проверки уборки. */
  get size(): number {
    return this.lastByChat.size;
  }
}
