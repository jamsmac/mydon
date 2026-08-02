/**
 * Шлюз эмбеддингов для семантической памяти (шаг #6b, RAG).
 *
 * Отдельно от LLM-шлюза: эмбеддинги — своя модель (и свой endpoint). Подписочные
 * CLI-харнессы их не отдают, поэтому путь — HTTP (OpenAI-совместимый
 * `/embeddings`) на локальную/облачную embed-модель. Выключено по умолчанию: нет
 * `EMBED_BASE_URL` → шлюза нет → семантическая память спит, агенты работают как
 * раньше (дельта-память по сигнатуре остаётся).
 */

export interface EmbeddingGateway {
  /** Вектор текста или null, если модель недоступна/ошиблась. */
  embed(text: string): Promise<number[] | null>;
}

/** OpenAI-совместимый HTTP-шлюз эмбеддингов (`POST {base}/embeddings`). */
export class HttpEmbeddingGateway implements EmbeddingGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey = "",
    private readonly model = "text-embedding-3-small",
    private readonly timeoutMs = 20_000,
  ) {}

  async embed(text: string): Promise<number[] | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.model, input: text }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { data?: { embedding?: unknown }[] };
      const vec = data?.data?.[0]?.embedding;
      return Array.isArray(vec) ? vec.map(Number) : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Шлюз эмбеддингов из окружения. Нет `EMBED_BASE_URL` → null (память спит). */
export function embeddingGatewayFromEnv(): EmbeddingGateway | null {
  const baseUrl = (process.env.EMBED_BASE_URL ?? "").trim();
  if (!baseUrl) return null;
  const model = (process.env.EMBED_MODEL ?? "").trim() || "text-embedding-3-small";
  return new HttpEmbeddingGateway(baseUrl, (process.env.EMBED_API_KEY ?? "").trim(), model);
}

/** Косинусная близость двух векторов. Разные длины/нули → 0 (безопасно). */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
