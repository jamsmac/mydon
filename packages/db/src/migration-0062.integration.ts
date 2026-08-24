import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

type Journal = {
  entries: Array<{ idx: number }>;
  [key: string]: unknown;
};

async function makeBaselineFolder(source: string): Promise<string> {
  const target = await mkdtemp(path.join(os.tmpdir(), "mydon-migrations-0061-"));
  await mkdir(path.join(target, "meta"));

  for (const name of await readdir(source)) {
    const match = /^(\d{4})_.+\.sql$/.exec(name);
    if (match && Number(match[1]) <= 61) {
      await copyFile(path.join(source, name), path.join(target, name));
    }
  }

  const journalPath = path.join(source, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as Journal;
  journal.entries = journal.entries.filter((entry) => entry.idx <= 61);
  await writeFile(
    path.join(target, "meta", "_journal.json"),
    `${JSON.stringify(journal, null, 2)}\n`,
  );
  return target;
}

async function main(): Promise<void> {
  const sourceUrl = process.env.DATABASE_URL;
  if (!sourceUrl) throw new Error("DATABASE_URL обязателен для integration-проверки миграции");

  const databaseName = `mydon_upgrade_0062_${process.pid}_${Date.now()}`;
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

    await migrate(drizzle(testDb), { migrationsFolder: baselineFolder });
    const [vendhub] = await testDb<{ id: string }[]>`
      INSERT INTO org (code, name) VALUES ('vendhub', 'VendHub') RETURNING id
    `;
    assert.ok(vendhub?.id);

    await testDb`
      INSERT INTO raw_snapshot (source_code, report_code, domain, fetched_at, columns)
      VALUES ('smoke', 'upgrade', 'vendhub', now(), '[]'::jsonb)
    `;
    await testDb`
      INSERT INTO entity (type, name, created_from)
      VALUES ('location', 'Coffee location', 'coffee-import'),
             ('location', 'Manual location', 'manual')
    `;

    await migrate(drizzle(testDb), { migrationsFolder });

    const [snapshot] = await testDb<{ backfilled: boolean }[]>`
      SELECT completed_at = created_at AS backfilled FROM raw_snapshot WHERE report_code = 'upgrade'
    `;
    assert.equal(snapshot?.backfilled, true, "completed_at должен заполниться из created_at");

    const locations = await testDb<
      { name: string; org_code: string | null; approved: boolean; approved_by: string | null }[]
    >`
      SELECT e.name, o.code AS org_code, e.approved_at IS NOT NULL AS approved, e.approved_by
      FROM entity e
      LEFT JOIN org o ON o.id = e.org_id
      WHERE e.name IN ('Coffee location', 'Manual location')
      ORDER BY e.name
    `;
    const coffee = locations.find((row) => row.name === "Coffee location");
    const manual = locations.find((row) => row.name === "Manual location");
    assert.deepEqual(
      { org: coffee?.org_code, approved: coffee?.approved, by: coffee?.approved_by },
      { org: "vendhub", approved: true, by: "owner" },
    );
    assert.deepEqual(
      { org: manual?.org_code, approved: manual?.approved, by: manual?.approved_by },
      { org: null, approved: false, by: null },
    );

    // «No-op» проверяется снимком до/после, а не зашитым числом миграций:
    // хардкод ломался бы каждой новой миграцией (сломался на 0063/0064).
    const [before] = await testDb<{ count: number }[]>`
      SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations
    `;
    await migrate(drizzle(testDb), { migrationsFolder });
    const [journal] = await testDb<{ count: number }[]>`
      SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations
    `;
    assert.equal(journal?.count, before?.count, "повторный запуск должен быть no-op");
    console.log("Migration 0061 -> 0062: upgrade, backfill and repeat run are valid.");
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

main().catch((err: unknown) => {
  console.error("Migration 0061 -> 0062 check failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
