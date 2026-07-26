/**
 * Структурный сид MYDON Core.
 *
 * Заводит ТОЛЬКО направления (org) — это каркас схемы, а не бизнес-данные.
 * Договоры, счета, контрагенты и прочее НЕ загружаются: они заводятся
 * отдельно и только по согласованию владельца.
 *
 * Идемпотентен: повторный запуск ничего не дублирует.
 */
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { eq } from "drizzle-orm";
import { createDb } from "./index";
import { org } from "./schema";
import { DOMAINS, DOMAIN_LABELS } from "@mydon/shared";

loadEnv({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL не задан. Заполните его в корневом .env монорепо.");
  }

  const db = createDb(url);
  let created = 0;
  let existed = 0;

  for (const code of DOMAINS) {
    const [found] = await db.select({ id: org.id }).from(org).where(eq(org.code, code));
    if (found) {
      existed += 1;
      continue;
    }
    await db.insert(org).values({ code, name: DOMAIN_LABELS[code] });
    created += 1;
  }

  console.log(`Направления: создано ${created}, уже было ${existed}, всего ${DOMAINS.length}.`);
  console.log("Бизнес-данные (договоры, счета, контрагенты) НЕ загружались — только по согласованию.");
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("Сид не выполнен:", err instanceof Error ? err.message : err);
  process.exit(1);
});
