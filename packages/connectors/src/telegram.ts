import { htmlToText } from "./web";

/**
 * telegram — чтение ПУБЛИЧНОГО превью Telegram-канала (t.me/s/<канал>).
 *
 * Зачем: у владельца есть канал идей (@promtjam) — новости про фишки, что ему
 * понравились. Публичное превью отдаётся обычным HTML без бота и токена, поэтому
 * MYDON читает его напрямую и приносит дайджест «что перенять».
 *
 * Только чтение публичной страницы. Разбор — по стабильной разметке превью
 * (`data-post`, `tgme_widget_message_text`, `<time>`); при смене разметки парсер
 * деградирует мягко (вернёт меньше постов или пустой список, не упадёт).
 */

export interface ChannelPost {
  /** Идентификатор поста, напр. "promtjam/414". */
  id: string;
  /** Номер поста в канале (для сортировки/«новее прошлого»). */
  num: number;
  /** Очищенный текст поста. */
  text: string;
  /** Внешние ссылки из поста (http/https), без дублей. */
  links: string[];
  /** ISO-время поста или null. */
  datetime: string | null;
}

/** URL публичного превью канала. Имя нормализуется (без @ и мусора). */
export function channelPreviewUrl(channel: string): string {
  const name = channel.replace(/^@/, "").trim().replace(/[^a-zA-Z0-9_]/g, "");
  return `https://t.me/s/${name}`;
}

const TEXT_RE = /tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/;
const TIME_RE = /<time[^>]*datetime="([^"]+)"/;
const HREF_RE = /href="([^"]+)"/g;

/**
 * Разбирает HTML превью в посты. Режем по `data-post="` — каждый сегмент это
 * одно сообщение; из него берём текст (первый блок message_text), ссылки и время.
 * Сегмент без текста (медиа-пост) пропускаем.
 */
export function parseChannelPosts(html: string): ChannelPost[] {
  const parts = html.split('data-post="');
  const out: ChannelPost[] = [];
  for (let i = 1; i < parts.length; i += 1) {
    const seg = parts[i];
    const idEnd = seg.indexOf('"');
    if (idEnd === -1) continue;
    const id = seg.slice(0, idEnd);

    const textM = TEXT_RE.exec(seg);
    if (textM === null) continue;
    const rawText = textM[1];
    const text = htmlToText(rawText).trim();
    if (text.length === 0) continue;

    const links: string[] = [];
    HREF_RE.lastIndex = 0;
    let hm: RegExpExecArray | null;
    while ((hm = HREF_RE.exec(rawText)) !== null) {
      if (/^https?:\/\//.test(hm[1])) links.push(hm[1]);
    }

    const numM = /\/(\d+)$/.exec(id);
    const timeM = TIME_RE.exec(seg);
    out.push({
      id,
      num: numM ? Number(numM[1]) : 0,
      text,
      links: [...new Set(links)],
      datetime: timeM ? timeM[1] : null,
    });
  }
  return out;
}

/** Читатель страницы — реальный fetch или фейк в тестах. */
export type HtmlFetcher = (url: string) => Promise<string>;

async function defaultFetch(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "MYDON/1.0 (owner-authorized channel reader)" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Telegram превью ответило ${res.status}`);
  return res.text();
}

/** Забирает и разбирает посты публичного канала. */
export async function fetchChannelPosts(channel: string, fetcher: HtmlFetcher = defaultFetch): Promise<ChannelPost[]> {
  const html = await fetcher(channelPreviewUrl(channel));
  return parseChannelPosts(html);
}

export const telegram = {
  name: "telegram",
  status: "live" as const,
  note: "Чтение публичного превью Telegram-канала: посты, ссылки, время.",
  channelPreviewUrl,
  parseChannelPosts,
  fetchChannelPosts,
};
