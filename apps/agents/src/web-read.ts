import { web } from "@mydon/connectors";
import type { FetchedPage } from "@mydon/connectors";
import type { WebSource } from "./registry";
import type { Proposal } from "./skills";

/**
 * Чтение сайтов агентом (шаг «агент читает источник по задаче»).
 *
 * Только ЧТЕНИЕ: коннектор web доставляет и чистит текст, но не кликает, не
 * заполняет форм и не создаёт учётных записей. Понимание (что за сигналы на
 * странице) — за LLM-слоем; пока модель не подключена, доклад фактический:
 * что прочитано, статусы, объём, короткие выжимки для владельца.
 *
 * Недоверенный текст со страниц оборачивается от инъекций НЕ здесь, а на
 * границе модели (callModel → wrapUntrusted): оборачивать данные, которые
 * владелец и так читает глазами, смысла нет.
 */

/** Итог чтения одного источника. Ошибка одного не роняет остальные. */
export interface WebReadResult {
  name: string;
  url: string;
  /** HTTP-статус или null, если запрос не состоялся. */
  status: number | null;
  /** Длина очищенного текста (символов). */
  chars: number;
  /** Страница была больше лимита и обрезана. */
  truncated: boolean;
  /** Короткая выжимка начала страницы — для беглого взгляда владельца. */
  excerpt: string;
  /** Причина, если источник не прочитался. */
  error?: string;
}

/** Сигнатура читателя страницы — реальный `web.fetchPage` или фейк в тестах. */
export type PageFetcher = (
  url: string,
  opts?: { maxBytes?: number; timeoutMs?: number; headers?: Record<string, string> },
) => Promise<FetchedPage>;

const EXCERPT_CHARS = 400;
const MAX_BYTES = 300_000;
const TIMEOUT_MS = 15_000;

/**
 * Читает список источников по очереди. Один недоступный сайт не роняет весь
 * прогон — его ошибка попадает в результат этого источника, остальные читаются.
 */
export async function readWebSources(
  sources: WebSource[],
  fetcher: PageFetcher = web.fetchPage,
): Promise<WebReadResult[]> {
  const out: WebReadResult[] = [];
  for (const s of sources) {
    try {
      const page = await fetcher(s.url, { maxBytes: MAX_BYTES, timeoutMs: TIMEOUT_MS });
      out.push({
        name: s.name,
        url: s.url,
        status: page.status,
        chars: page.text.length,
        truncated: page.truncated,
        excerpt: page.text.replace(/\s+/g, " ").trim().slice(0, EXCERPT_CHARS),
      });
    } catch (err) {
      out.push({
        name: s.name,
        url: s.url,
        status: null,
        chars: 0,
        truncated: false,
        excerpt: "",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/** Источник прочитан успешно: без ошибки и со статусом < 400. */
function isOk(r: WebReadResult): boolean {
  return r.error === undefined && r.status !== null && r.status < 400;
}

/**
 * Собирает предложение из прочитанного. Пустой список → null (читать было
 * нечего, повода нет). Иначе — фактический доклад: сколько прочитано, что
 * недоступно, выжимки. Появится модель — она разберёт сигналы из этих же фактов.
 */
export function buildWebProposal(results: WebReadResult[]): Proposal | null {
  if (results.length === 0) return null;
  const good = results.filter(isOk);
  const bad = results.filter((r) => !isOk(r));
  const names = good.map((r) => r.name).join(", ") || "—";
  const tail = bad.length ? ` Недоступны: ${bad.map((r) => r.name).join(", ")}.` : "";
  return {
    action: `Разведка: прочитал ${good.length}/${results.length} источников (${names}). Свежие данные готовы к разбору.${tail}`,
    facts: {
      read: results.length,
      ok: good.length,
      failed: bad.length,
      sources: results.map((r) => ({
        name: r.name,
        url: r.url,
        status: r.status,
        chars: r.chars,
        truncated: r.truncated,
        ...(r.error ? { error: r.error } : {}),
        excerpt: r.excerpt,
      })),
    },
  };
}
