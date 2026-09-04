#!/usr/bin/env node
/**
 * Донести поля паспортов-файлов (apps/agents/agents/<агент>/config.yaml) до карточек
 * агентов в базе Core.
 *
 * Зачем. Агенты при старте делают POST /agents/seed, и он идемпотентен нарочно:
 * СУЩЕСТВУЮЩИХ агентов не трогает, иначе каждое обновление системы затирало бы
 * правки владельца в панели. Обратная сторона: поля, появившиеся в паспортах
 * ПОСЛЕ первого посева — mission, non_goals, break_glass, web_sources, kb_pages,
 * новые skills, — в базу не попадают. Карточка живёт без миссии, llm-навык
 * идёт к модели без KB, break-glass пуст, а в панели этого не видно.
 *
 * Правило. База — источник истины владельца. Скрипт ЗАПОЛНЯЕТ ПУСТОЕ и
 * ДОБАВЛЯЕТ навыки, но не переписывает то, что уже задано, — если явно не
 * попросить `--overwrite=<поле,поле>`:
 *
 *   заполняются, если в базе пусто:  description, mission, nonGoals, breakGlass,
 *                                     webSources, kbPages, ideaChannels
 *   объединяются (база ∪ паспорт):    skills
 *   НЕ трогаются никогда:             status, autonomyDefault, schedule, budget*
 *     — статус и тир меняет владелец в панели (тир вообще отдельным owner-
 *     маршрутом, R-P5-5), расписание — отдельная тема со своей проверкой.
 *
 * Расхождения «в базе одно, в паспорте другое» печатаются, но база остаётся
 * как есть: владелец решает сам, что из этого править.
 *
 * Запуск НА СЕРВЕРЕ (Core слушает локально, мутации закрыты сервис-токеном):
 *   cd /opt/mydon-app
 *   docker compose -f deploy/docker-compose.yml --env-file .env \
 *     exec -T mydon-core node tools/apply-passport-fields.mjs --dry-run
 *   ... node tools/apply-passport-fields.mjs                         # применить
 *   ... node tools/apply-passport-fields.mjs --only=globerent-sales  # один агент
 *   ... node tools/apply-passport-fields.mjs --overwrite=webSources,kbPages
 *
 * Идемпотентно: повторный прогон печатает «изменений нет» и ничего не пишет.
 * Паспорт, которого в базе нет, скрипт не заводит — это сделает seed при
 * следующем старте агентов (он создаёт новых, пропускает существующих).
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const AGENTS_DIR = process.env.AGENTS_DIR ?? path.join(ROOT, "apps/agents/agents");
const CORE = process.env.CORE_API_URL ?? "http://127.0.0.1:3001";
const TOKEN = process.env.SERVICE_TOKEN ?? "";

/** Поля, которые заполняются только при пустом значении в базе. */
export const FILL_FIELDS = ["description", "mission", "nonGoals", "breakGlass", "webSources", "kbPages", "ideaChannels"];
/** Поля-списки, которые объединяются: база ∪ паспорт. */
export const MERGE_FIELDS = ["skills"];

// То же правило, что в apps/agents/src/registry.ts (isKbPagePath) и в DTO Core:
// только относительный путь внутри shared/, .md, без `..`.
const KB_PAGE = /^shared\/[A-Za-z0-9_\-./]+\.md$/;
export function isKbPagePath(value) {
  return typeof value === "string" && KB_PAGE.test(value) && !value.includes("..");
}

/**
 * Паспорт-файл (разобранный YAML) → поля карточки в форме Core.
 * Зеркало разбора в apps/agents/src/registry.ts: что рантайм не примет, того
 * не отправляем и сюда (битые kb_pages, источники без url).
 */
export function passportFields(raw) {
  const strings = (v) =>
    Array.isArray(v) ? v.filter((s) => typeof s === "string" && s.trim().length > 0).map((s) => s.trim()) : [];
  const text = (v) => (typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined);
  const kbPages = (Array.isArray(raw.kb_pages) ? raw.kb_pages : [])
    .map((s) => (typeof s === "string" ? s.split("#")[0].trim() : ""))
    .filter(isKbPagePath);
  const webSources = (Array.isArray(raw.web_sources) ? raw.web_sources : [])
    .filter((s) => s && typeof s.name === "string" && typeof s.url === "string")
    .map((s) => ({ name: s.name, url: s.url }));
  return {
    description: text(raw.description),
    mission: text(raw.mission),
    nonGoals: strings(raw.non_goals),
    breakGlass: strings(raw.break_glass),
    ideaChannels: strings(raw.idea_channels),
    kbPages,
    webSources,
    skills: strings(raw.skills),
  };
}

const isEmpty = (v) =>
  v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Что отправить в PATCH /agents/:name для одной карточки.
 * Возвращает { patch, kept }: patch — поля к записи (пусто = изменений нет),
 * kept — расхождения, где база сохранена (паспорт говорит иное, но поле задано).
 */
export function planPatch(fields, row, opts = {}) {
  const overwrite = new Set(opts.overwrite ?? []);
  const patch = {};
  const kept = [];
  for (const field of FILL_FIELDS) {
    const want = fields[field];
    if (isEmpty(want)) continue; // паспорт молчит — донести нечего
    const have = row[field];
    if (same(have, want)) continue;
    if (isEmpty(have) || overwrite.has(field)) patch[field] = want;
    else kept.push({ field, db: have, passport: want });
  }
  const haveSkills = Array.isArray(row.skills) ? row.skills : [];
  const wantSkills = fields.skills ?? [];
  if (overwrite.has("skills")) {
    if (!same(haveSkills, wantSkills)) patch.skills = wantSkills;
  } else {
    const missing = wantSkills.filter((s) => !haveSkills.includes(s));
    if (missing.length > 0) patch.skills = [...haveSkills, ...missing];
  }
  return { patch, kept };
}

/** Все паспорта каталога: имя → поля. _template и каталоги без config.yaml пропускаются. */
export function readPassports(dir, parseYaml) {
  const out = new Map();
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith("_") || name.startsWith(".")) continue;
    const cfg = path.join(dir, name, "config.yaml");
    if (!fs.existsSync(cfg)) continue;
    const raw = parseYaml(fs.readFileSync(cfg, "utf8")) ?? {};
    out.set(typeof raw.name === "string" ? raw.name : name, passportFields(raw));
  }
  return out;
}

function parseArgs(argv) {
  const list = (flag) =>
    (argv.find((a) => a.startsWith(`${flag}=`)) ?? "")
      .slice(flag.length + 1)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return { dry: argv.includes("--dry-run"), overwrite: list("--overwrite"), only: list("--only") };
}

function show(value) {
  const text = JSON.stringify(value);
  return text.length > 90 ? `${text.slice(0, 87)}…` : text;
}

async function api(method, route, body) {
  const res = await fetch(`${CORE}${route}`, {
    method,
    headers: { "content-type": "application/json", "x-service-token": TOKEN },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return res.json();
}

async function main() {
  const { dry, overwrite, only } = parseArgs(process.argv.slice(2));
  const allowed = new Set([...FILL_FIELDS, ...MERGE_FIELDS]);
  const badFields = overwrite.filter((f) => !allowed.has(f));
  if (badFields.length > 0) {
    console.error(`--overwrite: неизвестные поля ${badFields.join(", ")}. Допустимы: ${[...allowed].join(", ")}.`);
    process.exit(1);
  }
  if (!TOKEN && !dry) {
    console.error("SERVICE_TOKEN не задан — мутации Core закрыты без него (возьми из .env).");
    process.exit(1);
  }

  // `yaml` — зависимость @mydon/agents; в корне монорепы pnpm её не поднимает.
  const { parse: parseYaml } = createRequire(path.join(ROOT, "apps/agents/package.json"))("yaml");
  const passports = readPassports(AGENTS_DIR, parseYaml);
  const rows = await api("GET", "/agents");
  const byName = new Map(rows.map((r) => [r.name, r]));

  let patched = 0;
  let unchanged = 0;
  let failed = 0;
  let keptTotal = 0;
  const missingInDb = [];

  for (const [name, fields] of passports) {
    if (only.length > 0 && !only.includes(name)) continue;
    const row = byName.get(name);
    if (!row) {
      missingInDb.push(name);
      continue;
    }
    const { patch, kept } = planPatch(fields, row, { overwrite });
    keptTotal += kept.length;
    const changes = Object.keys(patch);
    console.log(`\n${name} (${row.status})`);
    for (const k of kept) console.log(`  ≠ ${k.field}: в базе ${show(k.db)}, в паспорте ${show(k.passport)} — база сохранена`);
    if (changes.length === 0) {
      console.log("  = изменений нет");
      unchanged += 1;
      continue;
    }
    for (const field of changes) console.log(`  + ${field} ← ${show(patch[field])}`);
    if (dry) continue;
    try {
      await api("PATCH", `/agents/${encodeURIComponent(name)}`, patch);
      patched += 1;
    } catch (error) {
      failed += 1;
      console.log(`  ! не записано: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log("");
  if (missingInDb.length > 0) {
    console.log(`В базе нет: ${missingInDb.join(", ")} — заведёт seed при следующем старте агентов.`);
  }
  console.log(
    dry
      ? `Предпросмотр: паспортов ${passports.size}, без изменений ${unchanged}, расхождений сохранено ${keptTotal}. Ничего не записано.`
      : `Готово: обновлено ${patched}, без изменений ${unchanged}, ошибок ${failed}, расхождений сохранено ${keptTotal}.`,
  );
  if (keptTotal > 0) console.log("Переписать поле из паспорта поверх базы: --overwrite=<поле,…>.");
  process.exit(failed > 0 ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
