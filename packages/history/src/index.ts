/**
 * Поиск по истории разговоров владельца.
 *
 * Зачем: MYDON не знал контекста прошлых решений и предлагал то, что уже
 * решено. Теперь помощник перед ответом ищет в 961 сессии (Claude Code,
 * Cursor, Codex) — и отвечает, зная, о чём уже договаривались.
 *
 * Почему не дообучение модели: у Claude его нет, и оно не нужно. Поиск в момент
 * вопроса точнее — свежие разговоры доступны сразу, ничего не «размывается».
 *
 * Индекс берётся готовый (chatdex): 12 138 сообщений уже разобраны и векторы
 * посчитаны. Модель эмбеддингов локальная (multilingual-e5-small, русский
 * поддерживает) — поиск не стоит денег и не требует ключей.
 */

import type { Database } from "better-sqlite3";

/** Найденный кусок разговора. */
export interface HistoryHit {
  sessionId: string;
  /** Заголовок сессии — из какого разговора кусок. */
  title: string;
  /** Проект, в котором шёл разговор. */
  project: string | null;
  /** Кто говорил: пользователь или ассистент. */
  role: string;
  /** Сам фрагмент текста. */
  text: string;
  when: string | null;
  /** Как нашли: точным совпадением, по смыслу или обоими способами. */
  via: ("text" | "meaning")[];
}

export interface HistorySearchOptions {
  limit?: number;
  /** Насколько «сглаживать» разницу рангов при объединении (RRF). */
  rrfK?: number;
}

/** Размерность векторов индекса. Несовпадение = поиск молча мажет. */
export const EMBED_DIM = 384;
export const DEFAULT_MODEL = "Xenova/multilingual-e5-small";

// Префиксы обязательны для моделей e5: запрос и текст кодируются по-разному.
// Перепутать их — тихо потерять качество поиска, без единой ошибки.
const QUERY_PREFIX = "query: ";

/**
 * Объединение двух списков находок (Reciprocal Rank Fusion).
 *
 * Точный поиск находит «Olma» дословно; смысловой — «кто нам должен» без единого
 * общего слова. RRF складывает позиции в обоих рейтингах, поэтому документ,
 * найденный обоими способами, поднимается сам — без подгонки весов вручную.
 */
export function fuseRankings<T>(
  byText: T[],
  byMeaning: T[],
  keyOf: (item: T) => string,
  opts: { limit?: number; rrfK?: number } = {},
): { item: T; score: number; via: ("text" | "meaning")[] }[] {
  const k = opts.rrfK ?? 60;
  const acc = new Map<string, { item: T; score: number; via: Set<"text" | "meaning"> }>();

  const add = (list: T[], via: "text" | "meaning"): void => {
    list.forEach((item, rank) => {
      const key = keyOf(item);
      const cur = acc.get(key) ?? { item, score: 0, via: new Set<"text" | "meaning">() };
      cur.score += 1 / (k + rank + 1);
      cur.via.add(via);
      acc.set(key, cur);
    });
  };

  add(byText, "text");
  add(byMeaning, "meaning");

  return [...acc.values()]
    .map((a) => ({ item: a.item, score: a.score, via: [...a.via] }))
    .sort((x, y) => y.score - x.score)
    .slice(0, opts.limit ?? 10);
}

/** Обрезка фрагмента до читаемого размера — в контекст нельзя лить всё подряд. */
export function trimSnippet(text: string, max = 400): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

/**
 * Отсев фрагментов кода и мусора.
 *
 * В истории много кусков программ и вывода команд. Для владельца-непрограммиста
 * они бесполезны, а место в контексте занимают. Признак — обилие скобок,
 * кавычек и знаков вместо обычных слов.
 */
export function looksLikeProse(text: string): boolean {
  const t = text.trim();
  if (t.length < 40) return false; // слишком коротко, чтобы быть полезным
  const symbols = (t.match(/[{}()<>[\];=+*/\\|`$#]/g) ?? []).length;
  if (symbols / t.length > 0.08) return false;
  // Должны быть настоящие слова, а не идентификаторы.
  const words = t.split(/\s+/).filter((w) => /^[\p{L}][\p{L}-]{2,}$/u.test(w));
  return words.length >= 5;
}

/** Ключ для отсева повторов: один и тот же текст встречается в разных сессиях. */
export function dedupeKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 120);
}

/**
 * Загрузка тяжёлых модулей в обход статической проверки.
 *
 * better-sqlite3, sqlite-vec и модель эмбеддингов — необязательные: на сервере
 * (alpine/musl) они могут не собраться. Имя модуля берётся переменной, поэтому
 * ни сборка, ни упаковщик не требуют их наличия — не нашлись, вернём null и
 * останемся без поиска по истории, а не уроним всю систему.
 */
async function loadOptional(name: string): Promise<Record<string, unknown> | null> {
  try {
    return (await import(name)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Минимум, который нам нужен от библиотеки эмбеддингов. */
interface Transformers {
  env: { cacheDir?: string };
  pipeline: (
    task: string,
    model: string,
    opts: Record<string, unknown>,
  ) => Promise<(input: string[], opts: Record<string, unknown>) => Promise<{ data: Float32Array }>>;
}

export interface HistoryIndex {
  search(query: string, opts?: HistorySearchOptions): Promise<HistoryHit[]>;
  close(): void;
  /** Сколько всего сообщений в индексе — для отчёта владельцу. */
  stats(): { sessions: number; messages: number; embedded: number };
}

/**
 * Открывает индекс истории.
 *
 * Модель эмбеддингов грузится ЛЕНИВО, при первом смысловом поиске: она весит
 * ~120 МБ, и держать её в памяти ради текстового поиска незачем.
 *
 * Нет векторного расширения или модели — работает точный поиск по тексту.
 * Это хуже, чем гибрид, но лучше, чем отсутствие поиска.
 */
export async function openHistory(dbPath: string, opts: { modelCacheDir?: string } = {}): Promise<HistoryIndex> {
  const sqlite = await loadOptional("better-sqlite3");
  if (sqlite === null) {
    throw new Error("better-sqlite3 не установлен — поиск по истории недоступен");
  }
  const SQLite = (sqlite.default ?? sqlite) as new (p: string, o: Record<string, unknown>) => Database;
  const db: Database = new SQLite(dbPath, { readonly: true, fileMustExist: true });

  // Векторное расширение подключаем best-effort: без него остаётся текстовый поиск.
  let vectorsReady = false;
  try {
    const vec = await loadOptional("sqlite-vec");
    if (vec === null) throw new Error("нет sqlite-vec");
    (vec as unknown as { load: (d: unknown) => void }).load(db);
    db.prepare("SELECT count(*) FROM vec_chunks").get();
    vectorsReady = true;
  } catch {
    vectorsReady = false;
  }

  let embedQuery: ((text: string) => Promise<Float32Array>) | null = null;
  async function ensureEmbedder(): Promise<((text: string) => Promise<Float32Array>) | null> {
    if (embedQuery !== null) return embedQuery;
    try {
      const mod = await loadOptional("@huggingface/transformers");
      if (mod === null) return null;
      const t = mod as unknown as Transformers;
      if (opts.modelCacheDir) t.env.cacheDir = opts.modelCacheDir;
      const extractor = await t.pipeline("feature-extraction", DEFAULT_MODEL, {
        dtype: "q8",
        device: "cpu",
      });
      embedQuery = async (text: string): Promise<Float32Array> => {
        const out = await extractor([QUERY_PREFIX + text], { pooling: "mean", normalize: true });
        return out.data.slice(0, EMBED_DIM);
      };
      return embedQuery;
    } catch {
      return null; // модели нет — останется текстовый поиск
    }
  }

  const byText = db.prepare(`
    SELECT m.session_id AS sessionId, m.idx AS idx, m.role AS role, m.text AS text,
           s.title AS title, s.project AS project, m.ts AS ts
    FROM messages_fts f
    JOIN messages m ON m.rowid = f.rowid
    LEFT JOIN sessions s ON s.id = m.session_id
    WHERE messages_fts MATCH ?
    ORDER BY bm25(messages_fts)
    LIMIT ?
  `);

  // Готовим ТОЛЬКО при загруженном расширении: без него prepare падает с
  // «no such module: vec0» — и уронил бы даже текстовый поиск, который работает.
  const byVector = vectorsReady
    ? db.prepare(`
        SELECT c.session_id AS sessionId, c.msg_idx AS idx, c.text AS text,
               s.title AS title, s.project AS project
        FROM vec_chunks v
        JOIN chunks c ON c.rowid = v.rowid
        LEFT JOIN sessions s ON s.id = c.session_id
        WHERE v.embedding MATCH ? AND k = ?
        ORDER BY distance
      `)
    : null;

  return {
    stats() {
      const one = (sql: string): number => {
        try {
          return Number((db.prepare(sql).get() as { n: number }).n);
        } catch {
          return 0;
        }
      };
      return {
        sessions: one("SELECT count(*) n FROM sessions"),
        messages: one("SELECT count(*) n FROM messages"),
        embedded: one("SELECT count(*) n FROM embedded_messages"),
      };
    },

    async search(query, options = {}) {
      const limit = options.limit ?? 8;
      const fetchN = Math.min(limit * 4, 60);

      // Точный поиск. FTS падает на спецсимволах — экранируем запрос кавычками.
      let textHits: Record<string, unknown>[] = [];
      try {
        const safe = `"${query.replace(/"/g, '""')}"`;
        textHits = byText.all(safe, fetchN) as Record<string, unknown>[];
      } catch {
        textHits = [];
      }

      // Смысловой поиск — только если есть и векторы, и модель.
      let vecHits: Record<string, unknown>[] = [];
      if (byVector !== null) {
        const embed = await ensureEmbedder();
        if (embed !== null) {
          try {
            const v = await embed(query);
            vecHits = byVector.all(Buffer.from(v.buffer), fetchN) as Record<string, unknown>[];
          } catch {
            vecHits = [];
          }
        }
      }

      const keyOf = (h: Record<string, unknown>): string => `${String(h.sessionId)}#${String(h.idx)}`;
      // Берём с запасом: часть уйдёт на отсев кода и повторов.
      const fused = fuseRankings(textHits, vecHits, keyOf, {
        limit: limit * 3,
        ...(options.rrfK !== undefined ? { rrfK: options.rrfK } : {}),
      });

      // Отсев: куски кода бесполезны владельцу, повторы занимают место в контексте.
      const seen = new Set<string>();
      const useful = fused.filter(({ item }) => {
        const text = String(item.text ?? "");
        if (!looksLikeProse(text)) return false;
        const key = dedupeKey(text);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      return (useful.length > 0 ? useful : fused).slice(0, limit).map(({ item, via }) => ({
        sessionId: String(item.sessionId ?? ""),
        title: String(item.title ?? "разговор"),
        project: item.project === null || item.project === undefined ? null : String(item.project),
        role: String(item.role ?? "assistant"),
        text: trimSnippet(String(item.text ?? "")),
        when: item.ts === null || item.ts === undefined ? null : new Date(Number(item.ts)).toISOString(),
        via,
      }));
    },

    close() {
      db.close();
    },
  };
}
