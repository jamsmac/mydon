#!/usr/bin/env node
/**
 * Загрузка сырой выгрузки источника в MYDON.
 *
 * Слой сырых данных хранит строки ровно так, как их отдала чужая система:
 * те же колонки, тот же порядок, значения строками. Этот скрипт ничего не
 * переименовывает и не приводит к типам — он только доставляет файл в базу.
 *
 * Формат файла (JSON):
 *   {
 *     "source": "gjvending",            // код системы из справочника источников
 *     "report": "order_query",          // код отчёта
 *     "fetchedAt": "2026-07-30T22:10:00+05:00",
 *     "periodFrom": "2024-04-01",       // необязательно
 *     "periodTo":   "2026-07-31",       // необязательно
 *     "account": "G9982401B",           // необязательно
 *     "rowsTotal": 56212,               // сколько строк показывал источник
 *     "columns": ["Order number", "..."],
 *     "rows": [["ff0001", "..."], ...]  // значения строками, порядок как в источнике
 *   }
 *
 * Большая выгрузка режется на части: тело запроса ограничено мегабайтом,
 * поэтому строки уходят пачками, а снимок остаётся один.
 *
 * Запуск (на Маке; Core доступен через SSH-туннель):
 *   ssh -f root@100.81.197.68 -L 13001:127.0.0.1:3001 sleep 300
 *   INGEST_KEY=... node tools/import-raw.mjs tools/samples/gjvending-order-query.json
 */

import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : null;
};
const DRY = args.includes("--dry");
const CORE = process.env.CORE_API_URL ?? "http://127.0.0.1:13001";
const KEY = process.env.INGEST_KEY ?? opt("key");
/** Пачка строк за запрос. 1000 надёжно влезает в мегабайтное тело. */
const CHUNK = Number(opt("chunk") ?? 1000);

if (!file) {
  console.error("Использование: node tools/import-raw.mjs <файл.json> [--key <ключ>] [--chunk 1000] [--dry]");
  process.exit(1);
}
if (!KEY && !DRY) {
  console.error("Не задан INGEST_KEY: без него Core выгрузку не примет.");
  process.exit(1);
}

const snapshot = JSON.parse(await readFile(file, "utf8"));
const { source, report, rows } = snapshot;
if (!source || !report || !Array.isArray(rows)) {
  console.error("В файле должны быть source, report и массив rows.");
  process.exit(1);
}

const columns = snapshot.columns ?? [];
console.log(`Источник: ${source} · отчёт: ${report}`);
console.log(`Колонок: ${columns.length} · строк в файле: ${rows.length.toLocaleString("ru-RU")}`);
if (snapshot.rowsTotal && snapshot.rowsTotal > rows.length) {
  console.log(`У источника было ${snapshot.rowsTotal.toLocaleString("ru-RU")} — снимок неполный, так и запишем.`);
}

// Строки, где значений больше, чем колонок, — признак того, что выгрузка
// собрана неверно. Молча обрезать нельзя: потеряется то, чего мы не видели.
const wide = rows.findIndex((r) => Array.isArray(r) && columns.length > 0 && r.length > columns.length);
if (wide >= 0) {
  console.error(`Строка ${wide + 1} длиннее шапки (${rows[wide].length} против ${columns.length}). Проверь выгрузку.`);
  process.exit(1);
}

if (DRY) {
  console.log("--dry: ничего не отправлено.");
  process.exit(0);
}

async function send(body) {
  const res = await fetch(`${CORE}/raw/import/${encodeURIComponent(KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

const meta = {
  source,
  report,
  fetchedAt: snapshot.fetchedAt,
  ...(snapshot.periodFrom ? { periodFrom: snapshot.periodFrom } : {}),
  ...(snapshot.periodTo ? { periodTo: snapshot.periodTo } : {}),
  ...(snapshot.account ? { account: snapshot.account } : {}),
  ...(snapshot.rowsTotal ? { rowsTotal: snapshot.rowsTotal } : {}),
  ...(snapshot.note ? { note: snapshot.note } : {}),
  columns,
};

let sent = 0;
try {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map((r) => r.map((c) => (c === null || c === undefined ? "" : String(c))));
    // Первая пачка заменяет снимок целиком, остальные дописываются к нему.
    const out = await send({ ...meta, rows: chunk, ...(i === 0 ? {} : { append: true }) });
    sent += chunk.length;
    console.log(`  отправлено ${sent.toLocaleString("ru-RU")} / ${rows.length.toLocaleString("ru-RU")} (в снимке: ${out.total})`);
  }
} catch (err) {
  console.error(`Не получилось: ${err.message}`);
  process.exit(1);
}

console.log(`Готово. Открой панель: VendHub → Источники → ${report}.`);
