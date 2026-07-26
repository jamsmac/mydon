import path from "node:path";
import { config as loadEnv } from "dotenv";

// .env лежит в корне монорепо. Секретов в коде нет — только чтение окружения.
loadEnv({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} не задан. Заполните его в корневом .env монорепо.`);
  }
  return value;
}

export const appConfig = {
  get databaseUrl(): string {
    return required("DATABASE_URL");
  },
  port: process.env.PORT ? Number(process.env.PORT) : 3001,
  tz: process.env.TZ ?? "Asia/Tashkent",
};
