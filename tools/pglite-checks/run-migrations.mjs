// Прогон цепочки миграций репо на pglite (PostgreSQL 17.5 в WASM) — локальная проверка без сервера.
// Использование: node run-migrations.mjs [--upto N] [--dump-file out.sql]  (папка drizzle — из репо)
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
// pglite ставится отдельно (см. README): PGLITE_DIR или ~/pgtest.
const PGLITE_DIR = process.env.PGLITE_DIR ?? path.join(os.homedir(), "pgtest");
const { PGlite } = await import(pathToFileURL(createRequire(path.join(PGLITE_DIR, "package.json")).resolve("@electric-sql/pglite")).href);
const req = createRequire(path.join(REPO, "packages/db/package.json"));
const { drizzle } = req("drizzle-orm/pglite");
const { migrate } = req("drizzle-orm/pglite/migrator");

export async function migratedDb({ upto } = {}) {
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
  const client = new PGlite();
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: folder });
  return { client, db, folder };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const i = process.argv.indexOf("--upto");
  const upto = i >= 0 ? Number(process.argv[i + 1]) : undefined;
  const t0 = Date.now();
  const { client } = await migratedDb({ upto });
  const r = await client.query("select count(*)::int as n from information_schema.tables where table_schema='public'");
  const m = await client.query("select count(*)::int as n from drizzle.__drizzle_migrations");
  console.log(`ok: таблиц ${r.rows[0].n}, миграций применено ${m.rows[0].n}, ${Date.now() - t0} мс`);
  await client.close();
}
