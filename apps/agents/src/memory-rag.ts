import type { AgentsCoreClient } from "./core-client";
import { cosineSimilarity, type EmbeddingGateway } from "./embedding";

/**
 * Семантическая память (RAG, шаг #6b): агент вспоминает ПОХОЖИЕ прошлые случаи
 * по смыслу, а не по точному совпадению.
 *
 * Хранение — в журнале Core (событие `agent.embed:<namespace>` с вектором и
 * текстом), как и дельта-память: переживает рестарт контейнера. Поиск —
 * линейный косинус в процессе (как в прототипе на SQLite): для нынешних объёмов
 * достаточно; вырастет корпус — заведём векторный индекс.
 *
 * Спит без embed-шлюза (`embeddingGatewayFromEnv() === null`): remember/ recall
 * вернут false/[].
 */

export interface Recalled {
  id: string;
  text: string;
  /** Косинусная близость к запросу (1 — совпадение, 0 — нет). */
  score: number;
}

/** Запомнить факт в семантическую память. false — если эмбеддинг не получен. */
export async function rememberSemantic(
  core: AgentsCoreClient,
  embedder: EmbeddingGateway,
  namespace: string,
  id: string,
  text: string,
): Promise<boolean> {
  const vector = await embedder.embed(text);
  if (vector === null) return false;
  await core.recordEvent({
    source: `mem:${namespace}`,
    type: `agent.embed:${namespace}`,
    payload: { id, text, vector },
  });
  return true;
}

/**
 * Вспомнить top-k похожих на запрос фактов из namespace. Пустой запрос-вектор
 * или нет памяти → []. Векторы разной длины/битые считаем несовпадающими (0).
 */
export async function recallSemantic(
  core: AgentsCoreClient,
  embedder: EmbeddingGateway,
  namespace: string,
  query: string,
  k = 3,
): Promise<Recalled[]> {
  const qv = await embedder.embed(query);
  if (qv === null) return [];

  const events = await core.listEvents(`agent.embed:${namespace}`);
  const scored: Recalled[] = events.map((e) => {
    const p = (e.payload ?? {}) as { id?: unknown; text?: unknown; vector?: unknown };
    const vec = Array.isArray(p.vector) ? (p.vector as unknown[]).map(Number) : [];
    return {
      id: typeof p.id === "string" ? p.id : "",
      text: typeof p.text === "string" ? p.text : "",
      score: cosineSimilarity(qv, vec),
    };
  });

  return scored
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, k));
}
