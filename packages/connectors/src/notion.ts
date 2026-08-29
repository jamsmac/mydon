/**
 * Notion — место, куда владелец и так смотрит.
 *
 * Принцип разделения (важно, иначе получим два источника правды):
 *   • РАБОТА живёт в MYDON — задачи, исполнители, согласования, журнал;
 *   • в Notion уходит ЧТЕНИЕ — отчёты и находки агентов.
 * Дублировать задачи в Notion нельзя: у владельца там своя «Business OS»,
 * и две очереди задач означали бы, что ни одной нельзя доверять.
 *
 * Работает по обычному REST API Notion с интеграционным токеном: это
 * детерминированно, не требует ключа Claude и стоит ноль. Токена нет —
 * коннектор молчит, а система работает дальше.
 */

const NOTION_VERSION = "2022-06-28";
const API = "https://api.notion.com/v1";

export interface NotionConfig {
  token: string;
  /** Страница, под которой агенты создают отчёты. */
  parentPageId: string;
  timeoutMs?: number;
}

export interface ReportBlock {
  /** Заголовок раздела. */
  heading?: string;
  /** Абзацы текста. */
  paragraphs?: string[];
  /** Маркированный список — для находок и цифр. */
  bullets?: string[];
}

export interface NotionReport {
  title: string;
  blocks: ReportBlock[];
  /** Кто написал: имя агента. Владелец должен видеть авторство. */
  author: string;
}

export class NotionError extends Error {
  constructor(
    readonly reason: string,
    /** HTTP status is required by the outbox dispatcher to distinguish safe retries. */
    readonly status?: number,
    /** Provider-requested delay parsed from Retry-After, when present. */
    readonly retryAfterMs?: number,
  ) {
    super(reason);
    this.name = "NotionError";
  }
}

function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);

  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, at - now);
}

/** Notion режет текст блока по 2000 символов — режем сами, а не теряем хвост. */
function chunk(text: string, size = 1900): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function paragraph(text: string): unknown {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: text } }] },
  };
}

function bullet(text: string): unknown {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: { rich_text: [{ type: "text", text: { content: text } }] },
  };
}

function heading(text: string): unknown {
  return {
    object: "block",
    type: "heading_2",
    heading_2: { rich_text: [{ type: "text", text: { content: text } }] },
  };
}

/** Отчёт → блоки Notion. Вынесено отдельно: проверяется тестом без сети. */
export function toBlocks(report: NotionReport): unknown[] {
  const out: unknown[] = [];
  for (const b of report.blocks) {
    if (b.heading) out.push(heading(b.heading));
    for (const p of b.paragraphs ?? []) {
      for (const part of chunk(p)) out.push(paragraph(part));
    }
    for (const item of b.bullets ?? []) {
      for (const part of chunk(item)) out.push(bullet(part));
    }
  }
  // Подпись: через неделю должно быть понятно, кто это написал и когда.
  out.push(
    paragraph(
      `— ${report.author}, MYDON · ${new Date().toLocaleString("ru-RU", { timeZone: "Asia/Tashkent" })}`,
    ),
  );
  // Notion принимает не больше 100 блоков за раз.
  return out.slice(0, 100);
}

export const notion = {
  name: "notion",
  status: "live" as const,
  note: "Отчёты агентов страницами в Notion. Нужен токен интеграции и доступ к странице.",

  /** Настроен ли коннектор. Нет — агенты просто не пишут в Notion. */
  configured(env: NodeJS.ProcessEnv = process.env): boolean {
    return Boolean(env.NOTION_TOKEN && env.NOTION_PARENT_PAGE_ID);
  },

  fromEnv(env: NodeJS.ProcessEnv = process.env): NotionConfig | null {
    if (!env.NOTION_TOKEN || !env.NOTION_PARENT_PAGE_ID) return null;
    return { token: env.NOTION_TOKEN, parentPageId: env.NOTION_PARENT_PAGE_ID };
  },

  /**
   * Создаёт страницу-отчёт под родительской страницей.
   * Возвращает ссылку — её можно отправить владельцу в Telegram.
   */
  async publish(report: NotionReport, config: NotionConfig): Promise<{ url: string; id: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 15_000);
    try {
      const res = await fetch(`${API}/pages`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.token}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          parent: { page_id: config.parentPageId },
          properties: {
            title: [{ type: "text", text: { content: report.title } }],
          },
          children: toBlocks(report),
        }),
      });

      if (!res.ok) {
        // Причину отдаём словами: чаще всего это «страница не расшарена
        // интеграции» — владелец должен понять, что чинить.
        let detail = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { message?: string; code?: string };
          if (body.message) detail = body.message;
          if (body.code === "object_not_found") {
            detail =
              "Страница не найдена или не расшарена интеграции. " +
              "Открой страницу в Notion → «…» → «Connections» → добавь интеграцию MYDON.";
          }
        } catch {
          // тело не JSON — оставляем код
        }
        throw new NotionError(detail, res.status, parseRetryAfter(res.headers.get("retry-after")));
      }

      const body = (await res.json()) as { id: string; url?: string };
      return { id: body.id, url: body.url ?? `https://notion.so/${body.id.replace(/-/g, "")}` };
    } finally {
      clearTimeout(timer);
    }
  },
};
