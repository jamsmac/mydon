import { createHash } from "node:crypto";

const MAX_MEMORY_SIGNATURE_LENGTH = 512;

/**
 * Сторожевая сигнатура «повода нет». Runner пишет её при no_signal, затирая
 * сигнатуру последней подачи: «повод исчез» — тоже изменение повода. Иначе
 * тот же набор фактов, вернувшийся после полного разрешения (встал ДРУГОЙ
 * автомат, а idleMachines снова 1), молча глотался бы устаревшей памятью как
 * no_change — TTL у памяти нет. Значение не пересекается с signature(): та
 * всегда отдаёт JSON-объект («{…}») либо префикс sha256:.
 */
export const NO_SIGNAL_SIGNATURE = "no-signal";

function canonicalSignature(facts: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(facts).sort()) sorted[key] = facts[key];
  return JSON.stringify(sorted);
}

function boundedSignature(canonical: string): string {
  if (canonical.length <= MAX_MEMORY_SIGNATURE_LENGTH) return canonical;
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/**
 * Дельта-память агента (шаг дорожной карты #6).
 *
 * Раньше навык предлагал одно и то же при каждом прогоне: «просрочено платежей: 2»
 * в 08:00, потом снова в 09:00 — и владелец приучался жать «одобрить» не глядя.
 * Дельта-память чинит это: агент помнит СИГНАТУРУ прошлого повода и повторяет
 * подачу, только если повод изменился. Не изменился — молчит.
 *
 * Хранение — в журнале Core (см. core-client recall/rememberMemory), а не в
 * памяти процесса: контейнер перезапускается, и память в процессе разошлась бы
 * с фактом. Сигнатуру считаем детерминированно от фактов предложения.
 */

/**
 * Стабильная сигнатура фактов: ключи сортируются, поэтому порядок полей не
 * влияет. По ней runner сравнивает «то же самое или изменилось».
 */
export function signature(facts: Record<string, unknown>): string {
  return boundedSignature(canonicalSignature(facts));
}

/**
 * Dual-read for signatures written before large payloads became hashed.
 * New writes are always bounded; an old raw cron value remains readable
 * without generating a duplicate action after rollout.
 */
export function matchesSignature(stored: string | null, facts: Record<string, unknown>): boolean {
  if (stored === null) return false;
  const canonical = canonicalSignature(facts);
  return stored === canonical || stored === boundedSignature(canonical);
}
