#!/usr/bin/env node
/**
 * Проверка .env.example: один ключ — одна строка.
 *
 * ЗАЧЕМ. 26.08.2026 структурный аудит нашёл `STAFF_LINK_BY_USERNAME` заданным
 * ДВАЖДЫ в одном файле: `=0` в начале (безопасно) и `=1` ближе к концу
 * (небезопасная аварийная привязка сотрудника по @username). При обычном
 * `cp .env.example .env` и построчном чтении (`dotenv` и подобные) побеждает
 * ПОСЛЕДНЕЕ значение — то есть заведомо небезопасное включалось незаметно,
 * без единой ошибки при старте. Дубль тихий: оба присваивания синтаксически
 * валидны, конфликта не видно без построчного чтения всего файла.
 *
 * ЧТО ДЕЛАЕТ. Построчно ищет `KEY=...` (без учёта закомментированных строк)
 * и падает с кодом 1, если один и тот же ключ встретился больше одного раза —
 * печатает ключ и номера строк, чтобы дубль было видно сразу, а не искать
 * по всему файлу заново.
 *
 * Запуск: node tools/check-env-example.mjs [path]  (по умолчанию .env.example)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** @param {string} source */
export function inspectEnvExample(source) {
  const lines = source.split("\n");
  const seen = new Map(); // key -> [номера строк, 1-based]
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^([A-Z_][A-Z0-9_]*)=/.exec(line);
    if (!m) continue;
    const key = m[1];
    const rows = seen.get(key) ?? [];
    rows.push(i + 1);
    seen.set(key, rows);
  }

  return {
    uniqueCount: seen.size,
    duplicates: [...seen.entries()].filter(([, rows]) => rows.length > 1),
  };
}

function main() {
  const path = process.argv[2] ?? ".env.example";
  const { duplicates, uniqueCount } = inspectEnvExample(readFileSync(path, "utf8"));
  if (duplicates.length > 0) {
    console.error(`Дубли ключей в ${path}:`);
    for (const [key, rows] of duplicates) {
      console.error(`  ${key} — строки ${rows.join(", ")}`);
    }
    console.error(
      "Один ключ — одна строка: при `cp .env.example .env` последнее значение молча " +
        "побеждает предыдущее (см. STAFF_LINK_BY_USERNAME, аудит 26.08.2026).",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`${path}: дублей ключей нет (${uniqueCount} уникальных).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
