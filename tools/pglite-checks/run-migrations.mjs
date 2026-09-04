// Цепочка миграций репо на настоящем PostgreSQL — ДВА режима, один и тот же код сценариев:
//
//   · локально, без сервера: pglite (PostgreSQL 17 в WASM), ставится отдельно (см. README);
//   · в CI и всюду, где Postgres уже есть: `CHECKS_DATABASE_URL` — каждому сценарию своя
//     свежая база из шаблона, после прогона она удаляется.
//
// Второй режим появился, чтобы поставить сценарии в CI, НЕ добавляя тяжёлый WASM-пакет в
// lockfile: в CI уже поднят сервис postgres:17, на котором гоняются миграции и смоуки.
//
// Использование: node run-migrations.mjs [--upto N]  (папка drizzle — из репо)
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const req = createRequire(path.join(REPO, "packages/db/package.json"));
/** Настоящий сервер вместо WASM: базы создаём и удаляем сами. */
const PG_URL = process.env.CHECKS_DATABASE_URL ?? "";

async function pgliteEngine() {
  // pglite ставится отдельно (см. README): PGLITE_DIR или ~/pgtest.
  const PGLITE_DIR = process.env.PGLITE_DIR ?? path.join(os.homedir(), "pgtest");
  const { PGlite } = await import(pathToFileURL(createRequire(path.join(PGLITE_DIR, "package.json")).resolve("@electric-sql/pglite")).href);
  const { drizzle } = req("drizzle-orm/pglite");
  const { migrate } = req("drizzle-orm/pglite/migrator");
  return async (folder, schema) => {
    const client = new PGlite();
    const db = drizzle(client, schema ? { schema } : undefined);
    await migrate(db, { migrationsFolder: folder });
    return { client, db, applyMigrations: (f = path.join(REPO, "packages/db/drizzle")) => migrate(db, { migrationsFolder: f }) };
  };
}

/**
 * Свежая база на настоящем сервере под каждый сценарий.
 *
 * Цепочка миграций применяется ОДИН раз за процесс — в базу-шаблон, а сценариям
 * достаётся её копия (`create database … template …`, копия каталога вместо 87
 * миграций: секунды вместо минут на семь сценариев). Postgres копирует шаблон
 * только когда к нему никто не подключён, поэтому соединение шаблона закрывается
 * сразу после миграций.
 */
async function postgresEngine() {
  const postgres = req("postgres");
  const { drizzle } = req("drizzle-orm/postgres-js");
  const { migrate } = req("drizzle-orm/postgres-js/migrator");
  const base = new URL(PG_URL);
  // Застава: базы создаёт и УДАЛЯЕТ этот код. На чужом хосте это должно быть
  // осознанным решением, а не следствием забытой переменной окружения.
  if (!["localhost", "127.0.0.1", "::1"].includes(base.hostname) && process.env.CHECKS_ALLOW_REMOTE !== "1") {
    throw new Error(`CHECKS_DATABASE_URL смотрит на ${base.hostname}: сценарии создают и удаляют базы, для не-локального хоста нужен CHECKS_ALLOW_REMOTE=1`);
  }
  const admin = (fn) => {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    return fn(sql).finally(() => sql.end({ timeout: 5 }));
  };
  const urlOf = (name) => { const u = new URL(PG_URL); u.pathname = `/${name}`; return u.toString(); };
  const templates = new Map();
  let seq = 0;
  return async (folder, schema) => {
    const key = folder;
    if (!templates.has(key)) {
      const tpl = `checks_tpl_${process.pid}_${templates.size}`;
      await admin((sql) => sql.unsafe(`drop database if exists ${tpl}`));
      await admin((sql) => sql.unsafe(`create database ${tpl}`));
      const tsql = postgres(urlOf(tpl), { max: 1, prepare: false, onnotice: () => {} });
      await migrate(drizzle(tsql), { migrationsFolder: folder });
      await tsql.end({ timeout: 5 });
      templates.set(key, tpl);
    }
    const name = `checks_${process.pid}_${seq++}`;
    await admin((sql) => sql.unsafe(`drop database if exists ${name}`));
    await admin((sql) => sql.unsafe(`create database ${name} template ${templates.get(key)}`));
    const sql = postgres(urlOf(name), { max: 1, prepare: false, onnotice: () => {} });
    const db = drizzle(sql, schema ? { schema } : undefined);
    return {
      client: {
        query: async (text, params) => ({ rows: await sql.unsafe(text, params ?? []) }),
        close: async () => {
          await sql.end({ timeout: 5 });
          await admin((a) => a.unsafe(`drop database if exists ${name}`));
        },
      },
      db,
      applyMigrations: (f = path.join(REPO, "packages/db/drizzle")) => migrate(db, { migrationsFolder: f }),
    };
  };
}

const engine = await (PG_URL ? postgresEngine() : pgliteEngine());
/** Где гоняются сценарии — печатается в их выводе, чтобы «зелёное» нельзя было спутать. */
export const ENGINE = PG_URL ? "postgres" : "pglite";

export async function migratedDb({ upto, schema } = {}) {
  const source = path.join(REPO, "packages/db/drizzle");
  let folder = source;
  if (upto !== undefined) {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), "mig-upto-"));
    fs.mkdirSync(path.join(folder, "meta"));
    for (const f of fs.readdirSync(source)) { const m = /^(\d{4})_.+\.sql$/.exec(f); if (m && Number(m[1]) <= upto) fs.copyFileSync(path.join(source, f), path.join(folder, f)); }
    const j = JSON.parse(fs.readFileSync(path.join(source, "meta/_journal.json"), "utf8"));
    j.entries = j.entries.filter((e) => e.idx <= upto);
    fs.writeFileSync(path.join(folder, "meta/_journal.json"), JSON.stringify(j, null, 2));
  }
  const built = await engine(folder, schema);
  return { ...built, folder };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const i = process.argv.indexOf("--upto");
  const upto = i >= 0 ? Number(process.argv[i + 1]) : undefined;
  const t0 = Date.now();
  const { client } = await migratedDb({ upto });
  const r = await client.query("select count(*)::int as n from information_schema.tables where table_schema='public'");
  const m = await client.query("select count(*)::int as n from drizzle.__drizzle_migrations");
  console.log(`ok (${ENGINE}): таблиц ${r.rows[0].n}, миграций применено ${m.rows[0].n}, ${Date.now() - t0} мс`);
  await client.close();
}
