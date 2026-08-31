import { timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { appConfig } from "../config";
import type { Db } from "../db/db.module";
import { settingValue } from "../system/settings";

/** Ключ мастер-тумблера ужесточения owner-identity (config-spec + .env). */
export const OWNER_IDENTITY_ENFORCED_KEY = "OWNER_IDENTITY_ENFORCED";

/** Сравнение в постоянное время: иначе токен подбирается по времени ответа. */
function secretEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Доказан ли запрос отдельным токеном действия владельца.
 *
 * R-P5-2: Core доверяет ТОЛЬКО `OWNER_ACTION_TOKEN`, которого нет у Bot/Agents,
 * и НЕ читает Tailscale-заголовок — подделать `Tailscale-User-Login` из tailnet
 * бесполезно, потому что Core его вообще не смотрит. Токен обязан отличаться от
 * общего `SERVICE_TOKEN`, иначе «второй пояс» вырождается в первый (тот же
 * инвариант, что у `OwnerActionGuard`).
 */
export function ownerTokenValid(req: Request): boolean {
  const expected = appConfig.ownerActionToken;
  const shared = appConfig.serviceToken;
  const header = req.headers["x-owner-action-token"];
  const provided = typeof header === "string" ? header : "";
  if (!expected || expected === shared || provided.length === 0) return false;
  return secretEquals(provided, expected);
}

/**
 * Включено ли ужесточение owner-identity (R-P5-6).
 *
 * По умолчанию ВЫКЛЮЧЕНО: мерж среза не меняет поведение прода, пока владелец
 * сам не выставит флаг. Приоритет как у панели настроек (база > env > дефолт),
 * НО с одним исключением — env `OWNER_IDENTITY_ENFORCED=0` это аварийный
 * kill-switch: он выключает ужесточение всегда, даже если в базе стоит "1",
 * чтобы ошибка настройки не отрезала владельца от собственной панели.
 */
export async function isOwnerIdentityEnforced(db: Db): Promise<boolean> {
  if (appConfig.ownerIdentityEnforcedEnv === "0") return false;
  return (await settingValue(db, OWNER_IDENTITY_ENFORCED_KEY)) === "1";
}
