#!/usr/bin/env node
/**
 * Выгрузка истории Telegram-группы БЕЗ ожидания экспорта Telegram Desktop.
 *
 * Bot API историю до подключения бота не отдаёт вовсе, а штатный экспорт
 * Telegram Desktop для свежей сессии заставляет ждать до 24 часов. Этот
 * инструмент — третий путь: читает историю от имени ЛИЧНОГО аккаунта
 * владельца через официальный MTProto API (тот же протокол, которым работает
 * сам Telegram Desktop). Владелец — участник группы, читает свою же
 * переписку своими же ключами: легитимно и без чужих учётных данных.
 *
 * Результат совместим с экспортом Telegram Desktop (result.json + photos/),
 * так что дальше работает готовый tools/import-telegram-coffee.mjs.
 *
 * Подготовка (один раз):
 *   1. https://my.telegram.org → API development tools → создать приложение
 *      → получить api_id и api_hash (это ключи ТВОЕГО аккаунта — не публикуй).
 *   2. TG_API_ID=... TG_API_HASH=... node tools/fetch-telegram-history.mjs --out ~/coffee-export
 *      При первом запуске спросит телефон, код из Telegram и пароль 2FA (если есть),
 *      затем напечатает TG_SESSION=... — сохрани в окружение, чтобы не входить заново.
 *
 * Запуск:
 *   TG_API_ID=.. TG_API_HASH=.. [TG_SESSION=..] \
 *   node tools/fetch-telegram-history.mjs --out <папка> [--chat -1003307473916] [--limit N] [--no-photos]
 *     [--topics]    — только показать темы форум-группы (id и название) и выйти
 *     [--topic N]   — выгрузить только одну тему (id из --topics)
 *
 * Повторный запуск в ту же папку НЕ перекачивает фото: файл на диске — кэш.
 *
 * Дальше:
 *   node tools/import-telegram-coffee.mjs <папка>/result.json --photos --dry
 *
 * Безопасность:
 *   • api_id/api_hash/TG_SESSION — полный доступ к аккаунту: только .env/окружение,
 *     никогда в git (репо-правило «ни одного ключа в коде»);
 *   • после импорта сессию можно отозвать: Telegram → Settings → Devices;
 *   • инструмент ТОЛЬКО читает — ничего не пишет и не удаляет.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const OUT = opt("out");
const CHAT = opt("chat", process.env.TELEGRAM_COFFEE_HISTORY_CHAT ?? "-1003307473916");
const LIMIT = Number(opt("limit", "100000"));
const PHOTOS = !args.includes("--no-photos");
const LIST_TOPICS = args.includes("--topics");
const TOPIC = opt("topic") !== null ? Number(opt("topic")) : null;

const API_ID = Number(process.env.TG_API_ID ?? "");
const API_HASH = process.env.TG_API_HASH ?? "";
if (!OUT || !API_ID || !API_HASH) {
  console.error(
    "Использование: TG_API_ID=.. TG_API_HASH=.. node tools/fetch-telegram-history.mjs --out <папка> [--chat id] [--limit N] [--no-photos]\n" +
      "  api_id/api_hash — с https://my.telegram.org (API development tools).",
  );
  process.exit(1);
}

const { TelegramClient } = await import("telegram");
const { StringSession } = await import("telegram/sessions/index.js");

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => rl.question(q);

const client = new TelegramClient(new StringSession(process.env.TG_SESSION ?? ""), API_ID, API_HASH, {
  connectionRetries: 3,
});
await client.start({
  phoneNumber: async () => ask("Телефон (с кодом страны, напр. +99890...): "),
  password: async () => ask("Пароль 2FA (если включён): "),
  phoneCode: async () => ask("Код из Telegram: "),
  onError: (err) => console.error("Ошибка входа:", err.message),
});
if (!process.env.TG_SESSION) {
  console.log("\nСессия создана. Чтобы не входить заново, сохрани в окружение:");
  console.log(`TG_SESSION=${client.session.save()}\n`);
}

// Группа: -100XXXXXXXXXX → внутренний id канала/супергруппы.
const chatId = /^-100\d+$/.test(CHAT) ? Number(CHAT) : CHAT;
const entity = await client.getEntity(chatId);
const title = entity.title ?? String(CHAT);

// Темы форум-группы: id темы = id её корневого сообщения. Нужны, чтобы брать
// фото только из «Заполнение бункеров», а не из всей группы подряд.
const { Api } = await import("telegram");
let topicTitles = new Map();
if (entity.forum) {
  try {
    const res = await client.invoke(new Api.channels.GetForumTopics({ channel: entity, limit: 100 }));
    topicTitles = new Map((res.topics ?? []).map((t) => [Number(t.id), t.title ?? String(t.id)]));
  } catch (err) {
    console.error(`Темы форума не прочитались (${err.message}) — продолжаю без названий.`);
  }
}
if (LIST_TOPICS) {
  console.log(`Группа: «${title}». Темы форума:`);
  if (topicTitles.size === 0) console.log("  (тем нет — это не форум-группа или темы не читаются)");
  for (const [id, name] of topicTitles) console.log(`  ${id}\t${name}`);
  console.log("\nДальше: node tools/fetch-telegram-history.mjs --out <папка> --topic <id>");
  await client.disconnect();
  rl.close();
  process.exit(0);
}
console.log(
  `Группа: «${title}»${TOPIC !== null ? ` · тема ${TOPIC}${topicTitles.has(TOPIC) ? ` «${topicTitles.get(TOPIC)}»` : ""}` : ""}. Читаю историю…`,
);

mkdirSync(OUT, { recursive: true });
if (PHOTOS) mkdirSync(join(OUT, "photos"), { recursive: true });

const messages = [];
let count = 0;
let photoCount = 0;
// reverse: от старых к новым — как в экспорте Telegram Desktop.
// --topic N — читаем только одну тему (replyTo в MTProto — фильтр по треду темы).
const iterOpts = { reverse: true, limit: LIMIT, ...(TOPIC !== null ? { replyTo: TOPIC } : {}) };
for await (const msg of client.iterMessages(entity, iterOpts)) {
  if (!msg || (!msg.message && !msg.photo)) continue;
  const date = new Date(msg.date * 1000).toISOString().slice(0, 19);
  const sender = msg.sender;
  const from = sender?.title ?? [sender?.firstName, sender?.lastName].filter(Boolean).join(" ") ?? "?";

  const row = { id: msg.id, type: "message", date, from: from || "?", text: msg.message ?? "" };

  // Тема сообщения (форум): корень треда. Без replyTo — General.
  const rt = msg.replyTo;
  const topicId = rt?.forumTopic ? Number(rt.replyToTopId ?? rt.replyToMsgId ?? 0) || null : TOPIC;
  if (topicId) {
    row.topicId = topicId;
    const t = topicTitles.get(topicId);
    if (t) row.topic = t;
  }

  if (msg.photo && PHOTOS) {
    const rel = `photos/photo_${msg.id}.jpg`;
    // Кэш: уже скачанное при прошлом запуске не перекачиваем.
    if (existsSync(join(OUT, rel))) {
      row.photo = rel;
      photoCount += 1;
    } else {
      try {
        const buf = await client.downloadMedia(msg, {});
        if (buf && buf.length > 0) {
          writeFileSync(join(OUT, rel), buf);
          row.photo = rel;
          photoCount += 1;
        }
      } catch (err) {
        console.error(`  фото сообщения ${msg.id} не скачалось: ${err.message}`);
      }
    }
  } else if (msg.photo) {
    row.photo = ""; // фото есть, но пропущено (--no-photos)
  }

  messages.push(row);
  count += 1;
  if (count % 100 === 0) console.log(`  …${count} сообщений${PHOTOS ? `, ${photoCount} фото` : ""}`);
}

const result = { name: title, type: "private_supergroup", id: CHAT, messages };
writeFileSync(join(OUT, "result.json"), JSON.stringify(result, null, 1));
console.log(`\nГотово: ${count} сообщений${PHOTOS ? `, ${photoCount} фото` : ""} → ${join(OUT, "result.json")}`);

// Раскладка по темам — видно, где фото-таблицы, а где текстовые возвраты.
const byTopic = new Map();
for (const m of messages) {
  const key = m.topic ?? (m.topicId ? `тема ${m.topicId}` : "General");
  const s = byTopic.get(key) ?? { msgs: 0, photos: 0 };
  s.msgs += 1;
  if (m.photo) s.photos += 1;
  byTopic.set(key, s);
}
if (byTopic.size > 1 || TOPIC === null) {
  console.log("По темам:");
  for (const [name, s] of byTopic) console.log(`  ${name}: сообщений ${s.msgs}, фото ${s.photos}`);
}
console.log(`\nДальше: node tools/import-telegram-coffee.mjs ${join(OUT, "result.json")} --photos --dry`);

await client.disconnect();
rl.close();
process.exit(0);
