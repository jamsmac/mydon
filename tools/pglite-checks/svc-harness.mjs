// Сервисы Core на настоящем SQL: локально pglite, в CI — сервис postgres:17
// (режим выбирает run-migrations.mjs по CHECKS_DATABASE_URL). Сценарий один и тот же.
import path from "node:path";
import { createRequire } from "node:module";
import { migratedDb, ENGINE } from "./run-migrations.mjs";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
export const reqCore = createRequire(path.join(REPO, "apps/core/package.json"));
export const reqDb = createRequire(path.join(REPO, "packages/db/package.json"));
export { ENGINE };
export async function coreDb() {
  const { schema } = reqDb(path.join(REPO, "packages/db/dist/schema.js"));
  const { client, db } = await migratedDb({ schema });
  const run = async (sql, params) => (await client.query(sql, params)).rows;
  return { client, db, run, close: () => client.close() };
}
