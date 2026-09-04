// Сервисы Core на настоящем SQL (pglite): drizzle(pglite, { schema }) вместо postgres-js.
import path from "node:path";
import { createRequire } from "node:module";
import { migratedDb } from "./run-migrations.mjs";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
export const reqCore = createRequire(path.join(REPO, "apps/core/package.json"));
export const reqDb = createRequire(path.join(REPO, "packages/db/package.json"));
export async function coreDb() {
  const { client } = await migratedDb();
  const { drizzle } = reqDb("drizzle-orm/pglite");
  const { schema } = reqDb(path.join(REPO, "packages/db/dist/schema.js"));
  const db = drizzle(client, { schema });
  const run = async (sql, params) => (await client.query(sql, params)).rows;
  return { client, db, run, close: () => client.close() };
}
