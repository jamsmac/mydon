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
  const target = await mkdtemp(path.join(os.tmpdir(), "mydon-migrations-0063-"));
  await mkdir(path.join(target, "meta"));

  for (const name of await readdir(source)) {
    const match = /^(\d{4})_.+\.sql$/.exec(name);
    if (match && Number(match[1]) <= 63) {
      await copyFile(path.join(source, name), path.join(target, name));
    }
  }

  const journalPath = path.join(source, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as Journal;
  journal.entries = journal.entries.filter((entry) => entry.idx <= 63);
  await writeFile(
    path.join(target, "meta", "_journal.json"),
    `${JSON.stringify(journal, null, 2)}\n`,
  );
  return target;
}

async function main(): Promise<void> {
  const sourceUrl = process.env.DATABASE_URL;
  if (!sourceUrl) throw new Error("DATABASE_URL обязателен для integration-проверки миграции");

  const databaseName = `mydon_upgrade_0064_${process.pid}_${Date.now()}`;
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

    // Код кофемашины: «c» + hex (a-f встречаются), НЕ «c» + ровно 10 цифр —
    // регулярка миграции обязана его не тронуть. Строка одна и без двойника,
    // поэтому любое изменение здесь — ложное срабатывание регулярки, а не
    // ожидаемое слияние.
    await testDb`
      INSERT INTO sale (id, dt, machine_serial, product, qty, amount, source, fetched_at)
      VALUES ('00000000-0000-0000-0000-000000006431', '2026-08-20', 'c7a6181f0000', 'Coffee', 1.00, 5.00, 'stock', '2026-08-20T01:00:00Z')
    `;
    await testDb`
      INSERT INTO machine_stock (id, dt, machine_serial, product, qty, fetched_at)
      VALUES ('00000000-0000-0000-0000-000000006432', '2026-08-20', 'c7a6181f0000', 'Coffee', 4.00, '2026-08-20T01:00:00Z')
    `;

    // sale: миграция обязана сложить аддитивные значения в голую строку,
    // сохранить её id, выбрать самый поздний fetched_at и удалить c-дубль.
    await testDb`
      INSERT INTO sale (id, dt, machine_serial, product, qty, amount, source, fetched_at)
      VALUES
        ('00000000-0000-0000-0000-000000006401', '2026-08-20', '2508160376', 'Test snack', 1.25, 10.10, 'stock', '2026-08-20T01:00:00Z'),
        ('00000000-0000-0000-0000-000000006402', '2026-08-20', 'c2508160376', 'Test snack', 2.75, 20.25, 'stock', '2026-08-20T03:00:00Z')
    `;

    // machine_stock: в первой паре новее c-строка, во второй время равно и
    // потому должна выжить голая. Фиксированные id доказывают, КАКАЯ строка
    // осталась, а не только то, что уникальный ключ случайно сошёлся.
    await testDb`
      INSERT INTO machine_stock (id, dt, machine_serial, product, qty, fetched_at)
      VALUES
        ('00000000-0000-0000-0000-000000006411', '2026-08-20', '2508160376', 'Latest wins', 3.00, '2026-08-20T01:00:00Z'),
        ('00000000-0000-0000-0000-000000006412', '2026-08-20', 'c2508160376', 'Latest wins', 9.50, '2026-08-20T03:00:00Z'),
        ('00000000-0000-0000-0000-000000006421', '2026-08-20', '2508160377', 'Bare wins tie', 7.00, '2026-08-20T02:00:00Z'),
        ('00000000-0000-0000-0000-000000006422', '2026-08-20', 'c2508160377', 'Bare wins tie', 99.00, '2026-08-20T02:00:00Z')
    `;

    await migrate(drizzle(testDb), { migrationsFolder });

    const sales = await testDb<
      {
        id: string;
        machine_serial: string;
        qty: string;
        amount: string;
        newest_fetched_at: boolean;
      }[]
    >`
      SELECT id, machine_serial, qty::text AS qty, amount::text AS amount,
             fetched_at = '2026-08-20T03:00:00Z'::timestamptz AS newest_fetched_at
      FROM sale
      WHERE product = 'Test snack'
      ORDER BY id
    `;
    assert.deepEqual([...sales], [
      {
        id: "00000000-0000-0000-0000-000000006401",
        machine_serial: "2508160376",
        qty: "4.00",
        amount: "30.35",
        newest_fetched_at: true,
      },
    ]);

    const stock = await testDb<
      { id: string; machine_serial: string; product: string; qty: string }[]
    >`
      SELECT id, machine_serial, product, qty::text AS qty
      FROM machine_stock
      WHERE product <> 'Coffee'
      ORDER BY product
    `;
    assert.deepEqual([...stock], [
      {
        id: "00000000-0000-0000-0000-000000006421",
        machine_serial: "2508160377",
        product: "Bare wins tie",
        qty: "7.00",
      },
      {
        id: "00000000-0000-0000-0000-000000006412",
        machine_serial: "2508160376",
        product: "Latest wins",
        qty: "9.50",
      },
    ]);

    const [duplicates] = await testDb<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM (
        SELECT machine_serial FROM sale
        UNION ALL
        SELECT machine_serial FROM machine_stock
      ) rows
      WHERE machine_serial ~ '^[cC][0-9]{10}$'
    `;
    assert.equal(duplicates?.count, 0, "c-дубли должны быть удалены, оставшиеся строки — канонизированы");

    const [coffeeSale] = await testDb<{ machine_serial: string }[]>`
      SELECT machine_serial FROM sale WHERE id = '00000000-0000-0000-0000-000000006431'
    `;
    assert.equal(coffeeSale?.machine_serial, "c7a6181f0000", "код кофемашины не должен канонизироваться");

    const [coffeeStock] = await testDb<{ machine_serial: string }[]>`
      SELECT machine_serial FROM machine_stock WHERE id = '00000000-0000-0000-0000-000000006432'
    `;
    assert.equal(coffeeStock?.machine_serial, "c7a6181f0000", "код кофемашины не должен канонизироваться");

    console.log("Migration 0063 -> 0064: exact sale merge and stock deduplication are valid.");
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
  console.error("Migration 0063 -> 0064 check failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
