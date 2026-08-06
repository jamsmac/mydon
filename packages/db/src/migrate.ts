import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as runMigrations } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * Применить миграции схемы — вместо `drizzle-kit migrate`.
 *
 * Замена не косметическая. `drizzle-kit migrate` при отказе SQL завершается
 * кодом 1 и НЕ печатает ничего: спиннер затирает строку, а само исключение
 * теряется. Из-за этого полевой контур три дня не разворачивался на сервере,
 * и в журнале автодеплоя было видно только «ОШИБКА (строка 128)» — без
 * единого слова о том, какая миграция и на каком операторе упала.
 *
 * Здесь тот же мигратор drizzle-orm, что дёргает и сам drizzle-kit, но с
 * честным catch: печатаются сообщение постгреса, код ошибки и текст запроса.
 *
 * Папка миграций считается от расположения файла, а не от рабочего каталога:
 * скрипт зовут и из корня образа, и из `packages/db`, и промах по cwd
 * означал бы «нечего применять» вместо ошибки.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL не задан — применять миграции некуда.");
    process.exit(1);
  }

  const folder = path.resolve(__dirname, "..", "drizzle");
  // NOTICE-сообщения («schema already exists, skipping») — норма при повторном
  // прогоне и только зашумляют вывод, в котором ищут ошибку.
  const sql = postgres(url, { max: 1, onnotice: () => {} });

  try {
    await runMigrations(drizzle(sql), { migrationsFolder: folder });
    console.log("Миграции применены.");
  } catch (err: unknown) {
    const e = err as { message?: string; query?: string; cause?: { message?: string; code?: string } };
    console.error("Миграции НЕ применены.");
    console.error("Причина:", e.cause?.message ?? e.message ?? String(err));
    if (e.cause?.code) console.error("Код postgres:", e.cause.code);
    if (e.query) console.error("Запрос:", e.query.trim().slice(0, 500));
    await sql.end({ timeout: 5 });
    process.exit(1);
  }

  await sql.end({ timeout: 5 });
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("Миграции НЕ применены:", err instanceof Error ? err.message : err);
  process.exit(1);
});
