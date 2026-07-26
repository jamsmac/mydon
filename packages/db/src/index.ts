/**
 * @mydon/db — клиент и схема MYDON Core (Drizzle + postgres.js).
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema } from "./schema";

export * from "./schema";

/** Создаёт подключение к MYDON Core. Строка берётся из окружения (DATABASE_URL). */
export function createDb(connectionString: string) {
  const client = postgres(connectionString, { prepare: false });
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;
