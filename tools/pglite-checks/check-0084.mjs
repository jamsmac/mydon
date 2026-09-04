// Локальный прогон сценария migration-0084.integration на pglite: 0083 → seed → 0084 → assert.
import path from "node:path";
import { createRequire } from "node:module";
import { migratedDb } from "./run-migrations.mjs";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const req = createRequire(path.join(REPO, "packages/db/package.json"));
const { seedBefore0084, assertAfter0084 } = req(path.join(REPO, "packages/db/dist/migration-0084.integration.js"));
const { migrate } = req("drizzle-orm/pglite/migrator");
const { client, db } = await migratedDb({ upto: 83 });
const run = async (sql) => (await client.query(sql)).rows;
await seedBefore0084(run);
await migrate(db, { migrationsFolder: path.join(REPO, "packages/db/drizzle") });
await assertAfter0084(run);
const units = await run("select part_kind, serial_number, origin from part_unit order by part_kind, serial_number");
console.log("part_unit после бэкфилла:", units.map(u => `${u.part_kind}/${u.serial_number ?? "—"}`).join(", "));
console.log("0083 → 0084 на pglite: бэкфилл верный");
await client.close();
