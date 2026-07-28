import { Injectable, Logger } from "@nestjs/common";
import type { HistoryHit, HistoryIndex } from "@mydon/history";

export interface HistorySearchResult {
  /** Индекс подключён? Нет — значит поиск по разговорам просто недоступен. */
  configured: boolean;
  hits: HistoryHit[];
}

/**
 * Поиск по истории разговоров владельца (индекс chatdex).
 *
 * Индекс — большой файл на диске, а не в базе MYDON: он готовится отдельно и
 * только читается. Путь задаётся HISTORY_DB_PATH; не задан — раздел молча
 * выключен, помощник работает как раньше.
 *
 * Почему в Core, а не в панели и боте по отдельности: индекс должен лежать в
 * одном месте, а сурфейсы — оставаться тонкими. Плюс нативная библиотека
 * (better-sqlite3) собирается только здесь.
 */
@Injectable()
export class HistoryService {
  private readonly log = new Logger(HistoryService.name);
  /** Открываем один раз: открытие тянет sqlite и модель эмбеддингов. */
  private indexPromise: Promise<HistoryIndex | null> | null = null;

  private open(): Promise<HistoryIndex | null> {
    if (this.indexPromise !== null) return this.indexPromise;

    const path = process.env.HISTORY_DB_PATH;
    if (!path || path.length === 0) {
      this.indexPromise = Promise.resolve(null);
      return this.indexPromise;
    }

    // Импорт динамический: без индекса нативный модуль грузить незачем, а на
    // сервере его может не быть вовсе — это не должно ронять Core.
    this.indexPromise = import("@mydon/history")
      .then((m) =>
        m.openHistory(path, {
          ...(process.env.HISTORY_MODEL_DIR ? { modelCacheDir: process.env.HISTORY_MODEL_DIR } : {}),
        }),
      )
      .catch((err: unknown) => {
        this.log.warn(
          `Индекс истории не открылся (${path}): ${err instanceof Error ? err.message : String(err)}. ` +
            "Поиск по разговорам выключен.",
        );
        return null;
      });
    return this.indexPromise;
  }

  async search(q: string, limit = 6): Promise<HistorySearchResult> {
    const index = await this.open();
    if (index === null) return { configured: false, hits: [] };
    try {
      return { configured: true, hits: await index.search(q, { limit }) };
    } catch (err) {
      // Сбой поиска не должен ломать ответ помощника — он обойдётся без истории.
      this.log.warn(`Поиск по истории не удался: ${err instanceof Error ? err.message : String(err)}`);
      return { configured: true, hits: [] };
    }
  }

  async stats(): Promise<{ configured: boolean; sessions: number; messages: number; embedded: number }> {
    const index = await this.open();
    if (index === null) return { configured: false, sessions: 0, messages: 0, embedded: 0 };
    return { configured: true, ...index.stats() };
  }
}
