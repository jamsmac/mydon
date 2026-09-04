import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * Интеграционная проверка миграции 0084 (part_unit) на настоящем Postgres:
 * бэкфилл восстанавливает нить физического узла из периодов machine_part
 * (спека 2026-09-04-vendhub-parts-inventory §4.5).
 *
 * Заглушка drizzle это не проверит в принципе: правило живёт в plpgsql-блоке
 * миграции. Сценарий кладёт намеренно запутанные цепочки на базу 0083 и после
 * 0084 сверяет, какие периоды получили ОДНУ карточку, а какие — разные.
 *
 * Сценарий и проверки вынесены в функции с голым SQL-исполнителем, чтобы тот
 * же прогон работал и локально на pglite (без сервера), и здесь на postgres.
 */
export type SqlRunner = (sql: string) => Promise<Record<string, unknown>[]>;

const A = "00000000-0000-0000-0000-00000000aa01"; // автомат A
const B = "00000000-0000-0000-0000-00000000bb01"; // автомат B
const L1 = "00000000-0000-0000-0000-0000000000f1"; // part_install: миксер на A
const L2 = "00000000-0000-0000-0000-0000000000f2"; // part_remove: миксер с A на мойку
const L3 = "00000000-0000-0000-0000-0000000000f3"; // part_install: тот же миксер с мойки на B
const L4 = "00000000-0000-0000-0000-0000000000f4"; // part_replace: гриндер SN-77 → SN-88 на A
const P = {
  mixerA: "00000000-0000-0000-0000-000000000101",
  mixerWash: "00000000-0000-0000-0000-000000000102",
  mixerB: "00000000-0000-0000-0000-000000000103",
  grinder77old: "00000000-0000-0000-0000-000000000104", // SN-77 на B, давно снят, без журнала
  grinder77: "00000000-0000-0000-0000-000000000105", // SN-77 на A, снят заменой L4
  grinder88: "00000000-0000-0000-0000-000000000106", // SN-88 на A, поставлен заменой L4
  dupA: "00000000-0000-0000-0000-000000000107", // бункер с серийником DUP открыт на A
  dupB: "00000000-0000-0000-0000-000000000108", // тот же серийник DUP открыт на B одновременно
  brewerB: "00000000-0000-0000-0000-000000000109", // варка на B без серийника и без журнала
} as const;

/** Данные ДО миграции: база на 0083, колонки part_unit_id ещё нет. */
export async function seedBefore0084(run: SqlRunner): Promise<void> {
  await run(`
    INSERT INTO entity (id, type, name) VALUES
      ('${A}', 'machine', 'Автомат A (0084)'),
      ('${B}', 'machine', 'Автомат B (0084)')
  `);
  await run(`
    INSERT INTO maintenance_log (id, entity_id, kind, part_kind, performed_on, outcome) VALUES
      ('${L1}', '${A}', 'part_install', 'mixer', '2026-06-01', 'done'),
      ('${L2}', '${A}', 'part_remove', 'mixer', '2026-07-01', 'done'),
      ('${L3}', '${B}', 'part_install', 'mixer', '2026-07-10', 'done'),
      ('${L4}', '${A}', 'part_replace', 'grinder', '2026-08-01', 'done')
  `);
  await run(`
    INSERT INTO machine_part (id, machine_id, location, part_kind, slot, serial_number, installed_on, removed_on, install_log_id, remove_log_id, created_at) VALUES
      -- цепочка 1: один миксер без серийника — A → мойка → B (нить по общему log_id)
      ('${P.mixerA}',    '${A}', 'machine', 'mixer', 1, NULL, '2026-06-01', '2026-07-01', '${L1}', '${L2}', '2026-06-01T09:00:00Z'),
      ('${P.mixerWash}', NULL,   'washing', 'mixer', NULL, NULL, '2026-07-01', '2026-07-10', '${L2}', '${L3}', '2026-07-01T09:00:00Z'),
      ('${P.mixerB}',    '${B}', 'machine', 'mixer', 2, NULL, '2026-07-10', NULL, '${L3}', NULL, '2026-07-10T09:00:00Z'),
      -- цепочка 2: серийник SN-77 в двух периодах без журнала между ними; замена L4 ставит ДРУГОЙ узел SN-88
      ('${P.grinder77old}', '${B}', 'machine', 'grinder', NULL, 'SN-77', '2026-01-01', '2026-04-01', NULL, NULL, '2026-01-01T09:00:00Z'),
      ('${P.grinder77}',    '${A}', 'machine', 'grinder', NULL, 'SN-77', '2026-05-01', '2026-08-01', NULL, '${L4}', '2026-05-01T09:00:00Z'),
      ('${P.grinder88}',    '${A}', 'machine', 'grinder', NULL, 'SN-88', '2026-08-01', NULL, '${L4}', NULL, '2026-08-01T09:00:00Z'),
      -- страховка: один серийник открыт на двух автоматах сразу — ошибка ввода, две карточки
      ('${P.dupA}', '${A}', 'machine', 'hopper', 3, 'DUP', '2026-06-01', NULL, NULL, NULL, '2026-06-01T09:00:00Z'),
      ('${P.dupB}', '${B}', 'machine', 'hopper', 3, 'DUP', '2026-06-15', NULL, NULL, NULL, '2026-06-15T09:00:00Z'),
      -- одиночный период без серийника и журнала — своя карточка
      ('${P.brewerB}', '${B}', 'machine', 'brewer', NULL, NULL, '2026-03-01', NULL, NULL, NULL, '2026-03-01T09:00:00Z')
  `);
}

/** Проверки ПОСЛЕ миграции. */
export async function assertAfter0084(run: SqlRunner): Promise<void> {
  const rows = await run(`
    SELECT mp.id, mp.part_unit_id, pu.serial_number AS unit_serial, pu.origin, pu.part_kind
      FROM machine_part mp JOIN part_unit pu ON pu.id = mp.part_unit_id
     WHERE mp.id::text LIKE '00000000-0000-0000-0000-0000000001%'
  `);
  const unitOf = new Map(rows.map((r) => [String(r.id), String(r.part_unit_id)]));
  assert.equal(rows.length, 9, "у каждого периода сценария должен быть узел (NOT NULL)");
  assert.ok(rows.every((r) => r.origin === "backfill"), "карточки заведены бэкфиллом");

  // Цепочка 1: три периода — один узел.
  assert.equal(unitOf.get(P.mixerA), unitOf.get(P.mixerWash), "снятие (part_remove) связывает A → мойка");
  assert.equal(unitOf.get(P.mixerWash), unitOf.get(P.mixerB), "установка (part_install) связывает мойка → B");
  const mixerUnit = rows.find((r) => String(r.id) === P.mixerA);
  assert.equal(mixerUnit?.unit_serial, null, "у миксера серийника не было — и у карточки нет");

  // Цепочка 2: SN-77 — один узел по серийнику; SN-88 — другой (замена не связывает).
  assert.equal(unitOf.get(P.grinder77old), unitOf.get(P.grinder77), "одинаковый серийник — тот же узел");
  assert.notEqual(unitOf.get(P.grinder77), unitOf.get(P.grinder88), "part_replace ставит ДРУГОЙ узел");
  const sn88 = rows.find((r) => String(r.id) === P.grinder88);
  assert.equal(sn88?.unit_serial, "SN-88", "серийник переехал на карточку");

  // Страховка: DUP открыт на двух автоматах — две карточки, индекс «один открытый период» цел.
  assert.notEqual(unitOf.get(P.dupA), unitOf.get(P.dupB), "серийник на двух автоматах сразу — две карточки");

  // Одиночка — своя карточка.
  const brewerUnit = unitOf.get(P.brewerB);
  assert.ok(brewerUnit && [...unitOf.entries()].filter(([, u]) => u === brewerUnit).length === 1);

  // Итого карточек по сценарию: миксер 1 + гриндеры 2 + бункеры 2 + варка 1 = 6.
  assert.equal(new Set(unitOf.values()).size, 6, "ровно 6 карточек узлов");

  // Узел SN-77 после замены не имеет открытого периода — «местонахождение неизвестно», это законно.
  const [open77] = await run(`
    SELECT count(*)::int AS n FROM machine_part WHERE part_unit_id = '${unitOf.get(P.grinder77)}' AND removed_on IS NULL
  `);
  assert.equal(open77?.n, 0, "снятый заменой до 0084 узел остаётся без открытого периода");

  // Индексы и NOT NULL на месте.
  const [idx] = await run(`
    SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = 'machine_part' AND indexname = 'machine_part_unit_open_key'
  `);
  assert.equal(idx?.n, 1, "уникальный индекс «один узел — один открытый период» создан");
  const [notNull] = await run(`
    SELECT is_nullable FROM information_schema.columns WHERE table_name = 'machine_part' AND column_name = 'part_unit_id'
  `);
  assert.equal(notNull?.is_nullable, "NO", "part_unit_id NOT NULL после бэкфилла");
}

type Journal = { entries: Array<{ idx: number }>; [key: string]: unknown };

async function makeBaselineFolder(source: string): Promise<string> {
  const target = await mkdtemp(path.join(os.tmpdir(), "mydon-migrations-0083-"));
  await mkdir(path.join(target, "meta"));
  for (const name of await readdir(source)) {
    const match = /^(\d{4})_.+\.sql$/.exec(name);
    if (match && Number(match[1]) <= 83) await copyFile(path.join(source, name), path.join(target, name));
  }
  const journal = JSON.parse(await readFile(path.join(source, "meta", "_journal.json"), "utf8")) as Journal;
  journal.entries = journal.entries.filter((entry) => entry.idx <= 83);
  await writeFile(path.join(target, "meta", "_journal.json"), `${JSON.stringify(journal, null, 2)}\n`);
  return target;
}

async function main(): Promise<void> {
  const sourceUrl = process.env.DATABASE_URL;
  if (!sourceUrl) throw new Error("DATABASE_URL обязателен для integration-проверки миграции");

  const databaseName = `mydon_upgrade_0084_${process.pid}_${Date.now()}`;
  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = "/postgres";
  const testUrl = new URL(sourceUrl);
  testUrl.pathname = `/${databaseName}`;

  const migrationsFolder = path.resolve(__dirname, "..", "drizzle");
  const baselineFolder = await makeBaselineFolder(migrationsFolder);
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => undefined });
  let testDb: ReturnType<typeof postgres> | undefined;
  let databaseCreated = false;

  try {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    testDb = postgres(testUrl.toString(), { max: 1, onnotice: () => undefined });
    const run: SqlRunner = async (sql) => (await testDb!.unsafe(sql)) as unknown as Record<string, unknown>[];

    await migrate(drizzle(testDb), { migrationsFolder: baselineFolder });
    await seedBefore0084(run);
    await migrate(drizzle(testDb), { migrationsFolder });
    await assertAfter0084(run);
    console.log("Migration 0083 -> 0084: part_unit backfill restores part chains correctly.");
  } finally {
    await testDb?.end({ timeout: 5 });
    if (databaseCreated) {
      await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${databaseName}`;
      await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
    }
    await admin.end({ timeout: 5 });
    await rm(baselineFolder, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error("Migration 0083 -> 0084 check failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
