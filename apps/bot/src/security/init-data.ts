import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Проверка Telegram WebApp initData.
 *
 * Закрывает finding из фронта Ф9: «отсутствие валидации auth_date в Telegram initData».
 * Без проверки возраста подписанные данные можно переиспользовать сколь угодно долго
 * (replay): перехваченный один раз initData давал бы вход навсегда.
 *
 * Алгоритм Telegram:
 *   secret_key   = HMAC_SHA256(key="WebAppData", data=<bot_token>)
 *   expected_hash = HMAC_SHA256(key=secret_key, data=data_check_string)
 * где data_check_string — пары "ключ=значение", кроме hash, отсортированные по ключу и склеенные \n.
 */

export const MAX_AUTH_AGE_SECONDS = 24 * 60 * 60; // 24 часа

export type InitDataResult =
  | { ok: true; userId: number | null; authDate: Date }
  | { ok: false; reason: string };

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export function verifyInitData(
  initData: string,
  botToken: string,
  now: Date = new Date(),
  maxAgeSeconds: number = MAX_AUTH_AGE_SECONDS,
): InitDataResult {
  if (!botToken) return { ok: false, reason: "TELEGRAM_BOT_TOKEN не задан" };
  if (!initData) return { ok: false, reason: "initData пуст" };

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "в initData нет подписи (hash)" };

  const authDateRaw = params.get("auth_date");
  if (!authDateRaw) return { ok: false, reason: "в initData нет auth_date" };
  const authDateSeconds = Number(authDateRaw);
  if (!Number.isFinite(authDateSeconds)) {
    return { ok: false, reason: "auth_date не является числом" };
  }

  // Подпись проверяем ДО решения о возрасте, чтобы не доверять неподписанным полям.
  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (!safeEqualHex(hash, expected)) {
    return { ok: false, reason: "подпись initData не совпадает" };
  }

  const ageSeconds = Math.floor(now.getTime() / 1000) - authDateSeconds;
  if (ageSeconds > maxAgeSeconds) {
    return { ok: false, reason: `initData устарел (${ageSeconds} с > ${maxAgeSeconds} с)` };
  }
  if (ageSeconds < -60) {
    // Дата из будущего — часы подделаны или рассинхронизированы.
    return { ok: false, reason: "auth_date из будущего" };
  }

  let userId: number | null = null;
  const userRaw = params.get("user");
  if (userRaw) {
    try {
      const parsed = JSON.parse(userRaw) as { id?: unknown };
      if (typeof parsed.id === "number") userId = parsed.id;
    } catch {
      return { ok: false, reason: "поле user повреждено" };
    }
  }

  return { ok: true, userId, authDate: new Date(authDateSeconds * 1000) };
}
