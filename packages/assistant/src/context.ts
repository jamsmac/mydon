/**
 * context.ts — память помощника: поиск по прошлым разговорам и знаниям.
 *
 * Зачем: без этого MYDON отвечает «с чистого листа» — предлагает то, что владелец
 * уже решил, и не помнит договорённостей. С этим — перед ответом смотрит, что
 * говорили раньше.
 *
 * Два источника, оба через Core (сурфейсы остаются тонкими, индекс — в одном месте):
 *   • заметки (/notes)          — выжимки решений, память Cowork. Отобраны вручную.
 *   • история (/history/search) — 12 тыс. сообщений прошлых разговоров.
 *
 * Оба необязательны: не ответили или не настроены — помощник работает как раньше.
 */

import type { ContextHit, ContextSearch } from "./index";

export interface ContextConfig {
  /** Адрес Core. */
  baseUrl: string;
  /** Сколько выдержек отдавать модели. Больше — не лучше: растёт шум. */
  limit?: number;
  timeoutMs?: number;
}

/** Обрезка до читаемого куска: в заметке может быть 20 000 знаков. */
function trim(text: string, max = 500): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  // Без кэширования: ответ должен опираться на сегодняшние заметки, а не на
  // прошлые. Next.js по умолчанию fetch не кэширует, отдельный флаг не нужен.
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Заметки Core → выдержки. Заголовок важнее текста: по нему видно, о чём запись. */
export function notesToHits(data: unknown): ContextHit[] {
  if (!Array.isArray(data)) return [];
  return data
    .filter((n): n is Record<string, unknown> => n !== null && typeof n === "object")
    .map((n) => ({
      kind: "знание" as const,
      where: typeof n.title === "string" && n.title.length > 0 ? n.title : "заметка",
      text: trim(String(n.body ?? "")),
    }))
    .filter((h) => h.text.length > 0);
}

/** Находки истории → выдержки. Проект показываем как «где» — так понятнее. */
export function historyToHits(data: unknown): ContextHit[] {
  const hits = (data as { hits?: unknown } | null)?.hits;
  if (!Array.isArray(hits)) return [];
  return hits
    .filter((h): h is Record<string, unknown> => h !== null && typeof h === "object")
    .map((h) => {
      const project = typeof h.project === "string" && h.project.length > 0 ? h.project : null;
      const title = typeof h.title === "string" && h.title.length > 0 ? h.title : "разговор";
      return {
        kind: "разговор" as const,
        where: project ?? title,
        text: trim(String(h.text ?? "")),
      };
    })
    .filter((h) => h.text.length > 0);
}

/**
 * Смешивание источников.
 *
 * Заметки идут первыми: это отобранные решения владельца, а не сырой разговор.
 * Но история не должна вытесняться совсем — иначе теряется контекст «как пришли
 * к решению». Поэтому обоим гарантируем место.
 */
export function mergeHits(notes: ContextHit[], history: ContextHit[], limit: number): ContextHit[] {
  const notesQuota = Math.min(notes.length, Math.max(1, Math.ceil(limit / 2)));
  const picked = [...notes.slice(0, notesQuota)];
  for (const h of history) {
    if (picked.length >= limit) break;
    picked.push(h);
  }
  // Осталось место — доливаем заметками.
  for (const n of notes.slice(notesQuota)) {
    if (picked.length >= limit) break;
    picked.push(n);
  }
  return picked;
}

/**
 * Поиск контекста через Core. Источники опрашиваются параллельно и независимо:
 * упавший или ненастроенный не мешает второму.
 */
export function createContextSearch(config: ContextConfig): ContextSearch {
  const limit = config.limit ?? 6;
  const timeoutMs = config.timeoutMs ?? 6000;
  const base = config.baseUrl.replace(/\/$/, "");

  return async (query: string): Promise<ContextHit[]> => {
    const q = query.trim();
    if (q.length < 2) return [];
    const enc = encodeURIComponent(q);

    const [notes, history] = await Promise.all([
      getJson(`${base}/notes?q=${enc}`, timeoutMs)
        .then(notesToHits)
        .catch(() => []),
      getJson(`${base}/history/search?q=${enc}&limit=${limit}`, timeoutMs)
        .then(historyToHits)
        .catch(() => []),
    ]);

    return mergeHits(notes, history, limit);
  };
}
