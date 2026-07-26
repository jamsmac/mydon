/**
 * Контроль доступа к боту: белый список чатов и ограничение частоты.
 * Требование ТЗ (Промпт 7): whitelist chat_id, отказ всем остальным, rate limiting.
 */

/** Разбирает TELEGRAM_ALLOWED_CHAT_IDS ("111,222"). Пустой список = не пускаем никого. */
export function parseAllowlist(raw: string | undefined): Set<number> {
  const ids = new Set<number>();
  for (const part of (raw ?? "").split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const id = Number(trimmed);
    if (Number.isFinite(id)) ids.add(id);
  }
  return ids;
}

/**
 * Закрытый по умолчанию доступ: если список пуст, не пускаем НИКОГО.
 * Иначе пустой TELEGRAM_ALLOWED_CHAT_IDS означал бы «открыто всем».
 */
export function isAllowed(chatId: number, allowlist: Set<number>): boolean {
  if (allowlist.size === 0) return false;
  return allowlist.has(chatId);
}

/** Ограничитель частоты: «дырявое ведро» на каждый чат. */
export class RateLimiter {
  private readonly hits = new Map<number, number[]>();

  constructor(
    private readonly limit = 20,
    private readonly windowMs = 60_000,
  ) {}

  /** true — запрос разрешён; false — превышен лимит. */
  allow(chatId: number, now: number = Date.now()): boolean {
    const since = now - this.windowMs;
    const recent = (this.hits.get(chatId) ?? []).filter((t) => t > since);
    if (recent.length >= this.limit) {
      this.hits.set(chatId, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(chatId, recent);
    return true;
  }

  /** Чистка старых записей, чтобы карта не росла бесконечно. */
  sweep(now: number = Date.now()): void {
    const since = now - this.windowMs;
    for (const [chatId, times] of this.hits) {
      const recent = times.filter((t) => t > since);
      if (recent.length === 0) this.hits.delete(chatId);
      else this.hits.set(chatId, recent);
    }
  }
}
