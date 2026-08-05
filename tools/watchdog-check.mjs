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

/**
 * Значение переменной окружения или запасное.
 *
 * `??` здесь мало: НЕЗАДАННЫЙ секрет GitHub подставляет в env пустой строкой,
 * а не отсутствием. Пустая строка не nullish, `??` её пропускает — и запасное
 * значение не срабатывает там, где обязано.
 */
const envText = (name, fallback = "") => (process.env[name] ?? "").trim() || fallback;

/**
 * Число из окружения — только положительное и конечное, иначе запасное.
 *
 * Тот же капкан, но с зубами: `Number("")` даёт 0, а не NaN. Порог протухания
 * становится нулевым, свежайший heartbeat оказывается «старше порога», и
 * сторож объявляет живой сервер мёртвым — на каждом прогоне.
 *
 * Отказ тем опаснее, что выглядит как работа: тревоги приходят настоящие с
 * виду, владелец за день приучается их пролистывать, а вместе с ними
 * пролистает и ту единственную, которая окажется правдой. И ловушка стояла
 * ровно там, где на неё обязаны были наступить: WATCHDOG_STALE_MINUTES
 * задокументирован как необязательный.
 */
function envNumber(name, fallback) {
  const raw = envText(name);
  const n = Number(raw);
  return raw !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
}

const GIST_ID = envText("WATCHDOG_GIST_ID");
const GH_TOKEN = envText("WATCHDOG_GH_TOKEN");
const BOT = envText("WATCHDOG_BOT_TOKEN");
const CHATS = envText("WATCHDOG_CHAT_IDS")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const STALE_MIN = envNumber("WATCHDOG_STALE_MINUTES", 10);
const STATE_FILE = envText("WATCHDOG_STATE_FILE", ".watchdog-state.json");

// Не настроен — говорим это целиком и один раз, а не по одному секрету за
// прогон. Пустой WATCHDOG_GIST_ID почти всегда означает не «забыли один», а
// «шаг настройки не делали вовсе», и владельцу нужен весь список сразу.
const REQUIRED = [
  "WATCHDOG_GIST_ID",
  "WATCHDOG_GH_TOKEN",
  "WATCHDOG_BOT_TOKEN",
  "WATCHDOG_CHAT_IDS",
];
if (GIST_ID === "") {
  const missing = REQUIRED.filter((n) => envText(n) === "");
  console.error(
    `Сторож не настроен: не заданы секреты ${missing.join(", ")}.\n` +
      "Это не поломка кода — сторожу нечего проверять, пока их нет.\n" +
      "Настройка: docs/watchdog.md, шаги 1–5 (gist, токены, бот, секреты Actions).",
  );
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
