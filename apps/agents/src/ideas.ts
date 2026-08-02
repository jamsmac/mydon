import { telegram, type ChannelPost } from "@mydon/connectors";
import type { Proposal } from "./skills";

/**
 * Идеи из Telegram-каналов владельца (ингестор @promtjam).
 *
 * Владелец постит в канал фишки, что ему понравились. Агент читает публичное
 * превью, собирает посты и приносит дайджест «что перенять». Дельта-память
 * рантайма не даёт повторять один и тот же набор — в фактах есть номер самого
 * свежего поста, он меняется только с появлением новых.
 */

export interface ChannelDigest {
  channel: string;
  posts: ChannelPost[];
  error?: string;
}

/** Читатель канала — реальный коннектор или фейк в тестах. */
export type ChannelReader = (channel: string) => Promise<ChannelPost[]>;

/** Читает каналы по очереди. Недоступный канал не роняет остальные. */
export async function readIdeaChannels(
  channels: string[],
  reader: ChannelReader = (c) => telegram.fetchChannelPosts(c),
): Promise<ChannelDigest[]> {
  const out: ChannelDigest[] = [];
  for (const channel of channels) {
    try {
      out.push({ channel, posts: await reader(channel) });
    } catch (err) {
      out.push({ channel, posts: [], error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/** Первая строка поста как заголовок идеи (обрезанная). */
function title(post: ChannelPost): string {
  const first = post.text.split("\n")[0].trim();
  return first.length > 120 ? `${first.slice(0, 117)}…` : first;
}

/**
 * Собирает предложение-дайджест из прочитанных каналов. Нет постов → null.
 * `latestNum` в фактах — для дельта-памяти: меняется только с новым постом.
 */
export function buildIdeasProposal(digests: ChannelDigest[]): Proposal | null {
  const all = digests.flatMap((d) => d.posts.map((p) => ({ post: p, channel: d.channel })));
  if (all.length === 0) return null;

  all.sort((a, b) => b.post.num - a.post.num);
  const top = all.slice(0, 10);
  const names = digests.map((d) => `@${d.channel.replace(/^@/, "")}`).join(", ");
  const failed = digests.filter((d) => d.error);
  const tail = failed.length ? ` Недоступны: ${failed.map((d) => d.channel).join(", ")}.` : "";

  return {
    action:
      `Идеи из каналов (${names}): ${all.length} постов. ` +
      `Свежие: ${top.slice(0, 3).map((t) => title(t.post)).join(" · ")}.${tail}`,
    facts: {
      channels: digests.map((d) => ({
        channel: d.channel,
        count: d.posts.length,
        ...(d.error ? { error: d.error } : {}),
      })),
      total: all.length,
      latestNum: all[0]?.post.num ?? 0,
      top: top.map((t) => ({
        id: t.post.id,
        title: title(t.post),
        links: t.post.links.slice(0, 3),
      })),
    },
  };
}
