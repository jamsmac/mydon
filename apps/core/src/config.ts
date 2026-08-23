import path from "node:path";
import { config as loadEnv } from "dotenv";
import { TZ } from "@mydon/shared";

// Часовой пояс закрепляем В КОДЕ, до первого обращения к датам.
// Полагаться на окружение нельзя: контейнер по умолчанию стартует с TZ=UTC,
// dotenv уже выставленную переменную не перезаписывает — и весь брифинг 07:30
// вместе с ночными выборками молча уезжал бы на 5 часов.
process.env.TZ = TZ;

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
  /**
   * Внутренний токен доступа к мутациям Core. Пусто — guard отклоняет ВСЕ
   * мутации (fail-closed) и Core предупреждает на старте; заполнен — мутации
   * требуют его, чтения открыты в обоих случаях. Задавать один и тот же
   * токен Core и всем клиентам (панель/бот/агенты) одновременно.
   */
  get serviceToken(): string {
    return process.env.SERVICE_TOKEN ?? "";
  },
  /** Фактический пояс процесса — сообщаем то, что есть, а не то, что хотелось бы. */
  get tz(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  },
  /** Путь на том же файловом слое, нехватка места на котором должна портить health. */
  get healthStoragePath(): string {
    return process.env.HEALTH_STORAGE_PATH?.trim() || "/";
  },
  /** Ниже этого остатка запись БД/вложений и Docker-сборки уже ненадёжна. */
  get healthMinStorageMb(): number {
    const parsed = Number(process.env.HEALTH_MIN_STORAGE_MB ?? "1024");
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1024;
  },
};
