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

/**
 * ЕДИНЫЙ источник видимости личного контура (R-P5-7b).
 *
 * Один вопрос — «виден ли этому запросу personal» — на который отвечают все
 * чтения Core, вместо того чтобы каждый эндпоинт складывал `enforced && !token`
 * заново. Правило:
 *   • ужесточение ВЫКЛЮЧЕНО → personal виден всегда (поведение прода не меняется);
 *   • ужесточение ВКЛЮЧЕНО → personal виден ТОЛЬКО владельцу (owner-токен).
 *
 * Брифинг/overview/ленту потребляет и бот для owner-сводки: гейт обязан быть
 * по видимости, а не глухим `excludePersonal`, иначе владелец с токеном терял
 * бы собственный контур. `excludePersonal` — это ровно отрицание видимости и
 * ВЫВОДИТСЯ отсюда, чтобы не разъехались два определения одного инварианта.
 */
export async function personalVisible(req: Request, db: Db): Promise<boolean> {
  if (!(await isOwnerIdentityEnforced(db))) return true;
  return ownerTokenValid(req);
}

/**
 * Исключать ли личный контур из domain-less чтения — отрицание `personalVisible`.
 *
 * Один источник правды: контроллеры зовут этот хелпер, а не повторяют формулу.
 * Флаг выключен (дефолт) → personalVisible=true → excludePersonal=false → SQL
 * прежний, и мерж среза поведение прода не меняет.
 */
export async function excludePersonal(req: Request, db: Db): Promise<boolean> {
  return !(await personalVisible(req, db));
}
