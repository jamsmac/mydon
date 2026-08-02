import { telegram, type ChannelPost } from "@mydon/connectors";
import type { BudgetStrategy } from "./budget";
import { callModel } from "./llm";
import { resolveModelChain, type ModelGateway } from "./model-gateway";
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

/**
 * Оценка идей моделью (первый LLM-навык, Stage 0 плана мозга).
 *
 * Просит модель выбрать из постов канала фишки, которые стоит внедрить в MYDON,
 * и коротко объяснить куда. Посты — ВНЕШНИЙ контент, поэтому идут как
 * `untrustedContext`: callModel оборачивает их от инъекций, а системный страж
 * запрещает исполнять инструкции из них. Бюджет проверяется до вызова.
 *
 * Нет постов → null. Модель не ответила (или путь выключен) → null: не выдаём
 * пустую оценку за работу.
 */
export async function assessIdeas(
  gateway: ModelGateway,
  digests: ChannelDigest[],
  opts: { perDayUsd?: number; strategy?: BudgetStrategy } = {},
): Promise<Proposal | null> {
  const posts = digests.flatMap((d) => d.posts.map((p) => `[${p.id}] ${p.text}`));
  if (posts.length === 0) return null;

  // Шлюз есть → путь включён. Нет явной модели в env → «default» (харнесс/шлюз
  // возьмёт свою), иначе callModel бы отказал на пустой цепочке.
  const chain = resolveModelChain();
  const res = await callModel(
    gateway,
    {
      system:
        "Ты — куратор идей MYDON (агенты · оболочка · ядро; бизнесы GLOBERENT и VendHub). " +
        "Оцени фишки из канала: какие стоит внедрить в MYDON и куда именно.",
      prompt:
        "Ниже посты канала идей. Выбери 3–5 самых полезных для MYDON и на каждую — одной строкой: " +
        "что это и в какой слой встроить. Коротко, по делу, без воды.",
      untrustedContext: posts.join("\n\n---\n\n"),
      ...(opts.perDayUsd !== undefined ? { perDayUsd: opts.perDayUsd } : {}),
      ...(opts.strategy !== undefined ? { strategy: opts.strategy } : {}),
    },
    chain.length ? chain : ["default"],
  );
  if (!res.ok || res.text.trim().length === 0) return null;

  const firstLine = res.text.trim().split("\n")[0].slice(0, 160);
  return {
    action: `Оценка идей канала (модель ${res.model ?? "?"}): ${firstLine}`,
    facts: {
      assessment: res.text.slice(0, 4000),
      ...(res.model !== undefined ? { model: res.model } : {}),
      costUsd: res.costUsd,
      channels: digests.map((d) => d.channel),
      posts: posts.length,
    },
  };
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
        // Полный текст (с потолком) — исполнитель кладёт каждую идею отдельной карточкой.
        text: t.post.text.length > 1500 ? `${t.post.text.slice(0, 1500)}…` : t.post.text,
        links: t.post.links.slice(0, 5),
      })),
    },
  };
}
