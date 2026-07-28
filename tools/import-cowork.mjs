#!/usr/bin/env node
/**
 * Перенос Cowork → MYDON.
 *
 * Запускается НА МАКЕ владельца (данные Cowork лежат только там) и отправляет
 * их в Core по Tailscale. После этого MYDON видит агента, его расписание,
 * состояние запусков и — главное — память решений, даже когда Мак выключен.
 *
 * Запуск:
 *   node tools/import-cowork.mjs                     — перенести всё
 *   node tools/import-cowork.mjs --dry               — показать, что будет, ничего не менять
 *
 * Настройки (переменные окружения):
 *   COWORK_BASE_DIR — папка данных Cowork (обязательно)
 *   CORE_API_URL    — адрес Core (по умолчанию http://100.81.197.68:3001)
 */

import { cowork } from "../packages/connectors/dist/cowork.js";

const BASE = process.env.COWORK_BASE_DIR;
const CORE = process.env.CORE_API_URL ?? "http://100.81.197.68:3001";
const DRY = process.argv.includes("--dry");

if (!BASE) {
  console.error(
    "Не задана папка Cowork. Пример:\n" +
      '  COWORK_BASE_DIR="$HOME/Library/Application Support/Claude/local-agent-mode-sessions/<id>/<id>" node tools/import-cowork.mjs',
  );
  process.exit(1);
}

/** Запрос к Core. В сухом прогоне ничего не отправляем. */
async function send(path, method, body) {
  if (DRY) return { dry: true };
  const res = await fetch(`${CORE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j.message) detail = Array.isArray(j.message) ? j.message.join("; ") : String(j.message);
    } catch {
      /* тело не JSON */
    }
    throw new Error(`${method} ${path}: ${detail}`);
  }
  return res.json();
}

const snap = cowork.snapshot(BASE, { runsLimit: 500 });

console.log(`Cowork: агентов ${snap.tasks.length}, пространств ${snap.spaces.length}, ` +
  `файлов памяти ${snap.memory.length}, сессий ${snap.runs.length}`);
if (DRY) console.log("(сухой прогон — ничего не отправляется)\n");

// ── 1. Агенты Cowork → карточки агентов MYDON ────────────────────────────────
// Владелец хочет видеть их вместе со своими. Заводим выключенными: расписание
// исполняет Cowork на Маке, а MYDON только показывает состояние.
for (const task of snap.tasks) {
  const name = `cowork-${task.id}`.slice(0, 64);
  try {
    await send("/agents", "POST", {
      name,
      business: "mydon",
      status: "paused",
      description: `Агент Cowork (Claude Desktop). Инструкция: ${task.skillPath}`,
      mission: `Работает по расписанию ${task.cron} на Маке владельца. MYDON показывает его состояние.`,
      nonGoals: ["НЕ запускается из MYDON — расписание исполняет Cowork на Маке"],
      autonomyDefault: "T1",
      schedule: [],
    });
    console.log(`  агент заведён: ${name}`);
  } catch (err) {
    // Уже есть — это нормально при повторном запуске.
    if (String(err).includes("уже есть")) console.log(`  агент уже был: ${name}`);
    else console.error(`  агент ${name}: ${err.message}`);
  }
}

// ── 2. Запуски → события ─────────────────────────────────────────────────────
// Ошибки видны владельцу в MYDON: агент мог встать три дня назад, а он не знает.
const runsOfTasks = snap.runs.filter((r) => r.taskId !== null);
const failed = runsOfTasks.filter((r) => r.error !== null);
for (const run of runsOfTasks.slice(-30)) {
  try {
    await send("/events", "POST", {
      source: `cowork:${run.taskId}`,
      type: run.error === null ? "cowork.run.ok" : "cowork.run.failed",
      payload: {
        sessionId: run.sessionId,
        at: run.at,
        title: run.title,
        ...(run.error ? { error: run.error } : {}),
      },
    });
  } catch (err) {
    console.error(`  запуск ${run.sessionId}: ${err.message}`);
  }
}
console.log(`  запусков перенесено: ${Math.min(runsOfTasks.length, 30)} (сбоев среди них: ${failed.length})`);

// ── 3. Память Cowork → заметки MYDON ─────────────────────────────────────────
// Самое ценное: готовые выжимки решений владельца. Без них MYDON предлагает то,
// что уже решено, — а помощник не знает контекста.
for (const m of snap.memory) {
  try {
    await send("/notes", "POST", {
      title: `[Cowork] ${m.title}`.slice(0, 512),
      body: m.body.slice(0, 20000),
      tags: ["cowork", "память", m.name],
    });
    console.log(`  память перенесена: ${m.name}`);
  } catch (err) {
    console.error(`  память ${m.name}: ${err.message}`);
  }
}

console.log("\nГотово.");
if (failed.length > 0) {
  console.log(`ВНИМАНИЕ: у агента Cowork ${failed.length} неудачных запусков — проверь в MYDON.`);
}
