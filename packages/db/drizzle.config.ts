import path from "node:path";
import { config as loadEnv } from "dotenv";
import { defineConfig } from "drizzle-kit";

// .env лежит в корне монорепо. Подхватываем и корневой, и локальный (если есть).
// Без этого drizzle-kit не видит DATABASE_URL, заполненный владельцем в корне.
loadEnv({ path: path.resolve(__dirname, "../../.env"), quiet: true });
loadEnv({ path: path.resolve(__dirname, ".env"), quiet: true });

const url = process.env.DATABASE_URL;

// Команды, которым нужно живое подключение. `generate` работает офлайн — только по схеме.
const NEEDS_CONNECTION = ["migrate", "push", "studio", "pull", "up", "check"];
const requiresDb = process.argv.some((arg) => NEEDS_CONNECTION.includes(arg));

if (requiresDb && !url) {
  throw new Error(
    "DATABASE_URL не задан. Заполните его в корневом .env монорепо.\n" +
      "Молчаливый фолбэк на localhost убран намеренно: он мог увести миграции в чужую базу.",
  );
}

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: url ?? "" },
});
