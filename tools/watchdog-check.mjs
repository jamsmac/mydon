#!/usr/bin/env node
/**
 * Внешний сторож MYDON — проверка свежести heartbeat (dead-man switch).
 *
 * Сервер пишет отметку «я жив» в приватный gist каждые 2 минуты
 * (deploy/heartbeat.sh). Этот скрипт запускается GitHub Actions по расписанию
 * С ДРУГОГО провайдера: тянет gist, сравнивает возраст отметки с порогом и
 * при протухании бьёт тревогу в ОТДЕЛЬНЫЙ Telegram-бот (общий бот лежал бы
 * вместе с сервером — ТЗ §6).
 *
 * Состояние (падение уже объявлено?) живёт в файле STATE_FILE, который
 * workflow переносит между запусками через actions/cache: тревога шлётся
 * при переходе живой→лежит, напоминание — каждый запуск пока лежит,
 * «поднялся» — один раз при восстановлении.
 *
 * Обратная сторона: сторож оставляет в том же gist отметку «я отработал»
 * (файл watchdog.json). Её читает сервер — deploy/watchdog-liveness.sh, — и
 * бьёт тревогу, если сторож замолчал. Получается взаимная слежка: сторож
 * следит за сервером, сервер — за сторожем.
 *
 * env: WATCHDOG_GIST_ID (+ WATCHDOG_GH_TOKEN — нужен Gists: Read and write,
 *      теперь сторож не только читает gist, но и отмечается в нём),
 *      WATCHDOG_BOT_TOKEN, WATCHDOG_CHAT_IDS (через запятую),
 *      WATCHDOG_STALE_MINUTES (порог, по умолчанию 10),
 *      WATCHDOG_STATE_FILE (по умолчанию .watchdog-state.json).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const GIST_ID = process.env.WATCHDOG_GIST_ID ?? "";
const GH_TOKEN = process.env.WATCHDOG_GH_TOKEN ?? "";
const BOT = process.env.WATCHDOG_BOT_TOKEN ?? "";
const CHATS = (process.env.WATCHDOG_CHAT_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const STALE_MIN = Number(process.env.WATCHDOG_STALE_MINUTES ?? "10");
const STATE_FILE = process.env.WATCHDOG_STATE_FILE ?? ".watchdog-state.json";

if (!GIST_ID) {
  console.error("WATCHDOG_GIST_ID не задан — сторожу нечего проверять.");
  process.exit(1);
}

async function notify(text) {
  console.log(text);
  if (!BOT || CHATS.length === 0) {
    console.warn("WATCHDOG_BOT_TOKEN/WATCHDOG_CHAT_IDS не заданы — тревога только в лог.");
    return;
  }
  for (const chatId of CHATS) {
    try {
      await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      console.error("Тревога не отправлена:", err.message);
    }
  }
}

function readState() {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    /* битое состояние — начинаем с чистого */
  }
  return { down: false };
}
const saveState = (s) => writeFileSync(STATE_FILE, JSON.stringify(s));

/** Возраст отметки в минутах; null — heartbeat не удалось получить/разобрать. */
export function heartbeatAgeMinutes(content, now = Date.now()) {
  try {
    const j = JSON.parse(content);
    const ts = Date.parse(j.ts);
    if (!Number.isFinite(ts)) return null;
    return (now - ts) / 60_000;
  } catch {
    return null;
  }
}

/**
 * Отметка «сторож отработал» — отдельным файлом в том же gist.
 *
 * Сторож видит, что сервер лежит. Обратного не знал никто: когда умирал сам
 * сторож (сломанный workflow, отключённое расписание, отозванный токен),
 * тишина читалась как «всё хорошо» — ровно в тот момент, когда проверять
 * стало некому.
 *
 * Пишется на ОБОИХ исходах: важно, что сторож отработал, а не что ему
 * понравилось увиденное. Ошибка записи гасится в лог — доставка тревоги о
 * сервере важнее отметки о себе, и падать из-за неё сторож не должен.
 */
async function markWatchdogRan(verdict) {
  if (!GH_TOKEN) {
    console.warn("WATCHDOG_GH_TOKEN не задан — отметку сторожа записать нечем.");
    return;
  }
  const mark = JSON.stringify({
    ts: new Date().toISOString(),
    verdict,
    run: process.env.GITHUB_RUN_ID ?? null,
  });
  try {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: "PATCH",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${GH_TOKEN}`,
        "Content-Type": "application/json",
      },
      // Только свой файл: PATCH с одним файлом не трогает heartbeat.json,
      // который в этот же gist пишет сервер.
      body: JSON.stringify({ files: { "watchdog.json": { content: mark } } }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error("Отметка сторожа не записана:", err.message);
  }
}

const state = readState();
let content = null;
let detail = "";
try {
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(GH_TOKEN ? { Authorization: `Bearer ${GH_TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`gist HTTP ${res.status}`);
  const gist = await res.json();
  content = gist.files?.["heartbeat.json"]?.content ?? null;
} catch (err) {
  detail = `gist недоступен: ${err.message}`;
}

const age = content !== null ? heartbeatAgeMinutes(content) : null;
const alive = age !== null && age <= STALE_MIN;

if (alive) {
  if (state.down) {
    await notify(`✅ MYDON/OS снова жив: heartbeat ${Math.round(age)} мин назад.`);
  }
  saveState({ down: false });
  await markWatchdogRan("ok");
  console.log(`ok: heartbeat ${age.toFixed(1)} мин назад (порог ${STALE_MIN}).`);
  process.exit(0);
}

// Лежит (или heartbeat нечитаем). Диагноз из последней отметки — что было живо.
let lastInfo = "";
if (content !== null) {
  try {
    const j = JSON.parse(content);
    lastInfo = `\nПоследняя отметка: ${j.ts ?? "?"} · диск ${j.disk_avail_gb ?? "?"}ГБ\n${(j.containers ?? "").split(";").filter(Boolean).join("\n")}`;
  } catch {
    lastInfo = "\nПоследняя отметка нечитаема.";
  }
}
const ageText = age !== null ? `${Math.round(age)} мин назад` : detail || "не разобрана";
await notify(
  `🚨 MYDON/OS не подаёт признаков жизни!\nHeartbeat: ${ageText} (порог ${STALE_MIN} мин).${lastInfo}\n` +
    "Проверь сервер: ssh root@100.81.197.68 (Tailscale) и хостинг Hetzner.",
);
saveState({ down: true });
await markWatchdogRan("down");
process.exit(0);
