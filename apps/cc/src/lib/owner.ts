import "server-only";
import { headers } from "next/headers";

/**
 * Owner-identity оболочки (пункт 5 аудита, рулинги R-P5-1, R-P5-3, R-P5-6).
 *
 * ЕДИНСТВЕННОЕ место, где панель узнаёт «кто смотрит». Личность приходит
 * заголовком, который проставляет `tailscale serve` перед CC. Заголовок из
 * прямого запроса (bind без serve) приходить НЕ должен — но если не пришёл,
 * это НЕ повод запереть владельца (R-P5-6): отсутствие заголовка трактуем как
 * «личность неизвестна», а не «чужой».
 *
 * ВАЖНО (R-P5-2): доверять этому заголовку можно ТОЛЬКО потому, что его читает
 * CC за доверенным serve-прокси. Сам Core заголовку из tailnet не верит — он
 * принимает лишь OWNER_ACTION_TOKEN, которого нет у Bot/Agents. То есть здесь,
 * на уровне CC, заголовок — источник личности; в Core личность превращается в
 * право через отдельный секретный токен, а не через этот же заголовок.
 */

/**
 * Имя заголовка идентичности. Tailscale serve (1.10x) проставляет
 * `Tailscale-User-Login`. Заголовки в fetch/Next нечувствительны к регистру и
 * читаются через `Headers.get`, поэтому храним имя в нижнем регистре — так его
 * же вернёт `headers()`.
 */
export const OWNER_LOGIN_HEADER = "tailscale-user-login";

export interface OwnerIdentity {
  /** Заголовок пришёл и логин совпал с настроенным владельцем. */
  isOwner: boolean;
  /** Логин из заголовка; `null` — заголовка нет (прямой bind без serve). */
  login: string | null;
}

/**
 * Включён ли гейт роутов (R-P5-6). По умолчанию ВЫКЛ: мерж PR не меняет
 * поведение прода, пока владелец сам не выставит `OWNER_IDENTITY_ENFORCED=1`.
 * Ошибка конфигурации serve не должна отрезать владельца от собственной панели —
 * поэтому флаг вводится осознанно и отдельно от выкатки кода.
 */
export function ownerEnforcementEnabled(): boolean {
  return process.env.OWNER_IDENTITY_ENFORCED === "1";
}

/**
 * Чистое сопоставление логина с настройкой владельца — без чтения заголовков,
 * чтобы решение было тестируемым в отрыве от Next.
 *
 * `OWNER_TAILSCALE_LOGIN` не задан → владельца опознать НЕЛЬЗЯ: `isOwner=false`
 * при любом логине. Это безопасно в паре с выключенным по умолчанию гейтом
 * (гейт не заперет никого) и с owner-токеном (он не проставится без OWNER_
 * ACTION_TOKEN). Сравнение без учёта регистра — tailnet-логины (email/акк)
 * регистронезависимы.
 */
export function matchOwner(login: string | null, configuredLogin: string | undefined): OwnerIdentity {
  const configured = (configuredLogin ?? "").trim().toLowerCase();
  const normalized = login && login.trim() !== "" ? login.trim() : null;
  const isOwner = configured !== "" && normalized !== null && normalized.toLowerCase() === configured;
  return { isOwner, login: normalized };
}

/**
 * Прочитать личность из заголовка serve и сопоставить с владельцем.
 *
 * Единственное место чтения заголовка (R-P5-1). Провал чтения `headers()`
 * (вызов вне request-скоупа) трактуем как «заголовка нет» — не как ошибку и не
 * как владельца.
 */
export async function resolveOwner(): Promise<OwnerIdentity> {
  let login: string | null = null;
  try {
    const store = await headers();
    login = store.get(OWNER_LOGIN_HEADER);
  } catch {
    login = null;
  }
  return matchOwner(login, process.env.OWNER_TAILSCALE_LOGIN);
}

/**
 * Решение гейта личного контура (R-P5-4, R-P5-6). `true` — содержимое НЕ
 * отдавать (честный отказ, а не пустая страница).
 *
 * - НЕ `personal` — прочие домены открыты в tailnet как сейчас (осознанно).
 * - Гейт ВЫКЛ — как сейчас, personal открыт (R-P5-6).
 * - Заголовка нет (`login === null`, прямой bind без serve) — как сейчас, не
 *   запираем владельца (R-P5-6: ошибка конфигурации serve ≠ потеря доступа).
 * - Заголовок есть и это не владелец — отказ.
 */
export function personalGateBlocks(
  domain: string,
  identity: OwnerIdentity,
  enforced: boolean,
): boolean {
  if (domain !== "personal") return false;
  if (!enforced) return false;
  if (identity.login === null) return false;
  return !identity.isOwner;
}
