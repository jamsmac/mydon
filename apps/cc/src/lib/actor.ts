import "server-only";
import { cookies } from "next/headers";
import { UNRECOGNIZED_HUMAN_ACTOR, agentActor, isActorRef, parseAgentName } from "@mydon/shared";
import { resolveOwner, type OwnerIdentity } from "./owner";

/**
 * Кто совершает действие панели — актор записи в журнал (R-H-8, R-H-9).
 *
 * ЗАЧЕМ. Панель жёстко писала `owner` в ~40 местах и молчала в ~70 остальных,
 * а Core подставлял `owner` сам. Любая правка, сделанная агентом через панель
 * (Claude в браузере владельца 9–11.09), легла в журнал правкой владельца.
 *
 * ОТКУДА ЗНАТЬ. Личность из заголовка Tailscale (`resolveOwner`) агента от
 * владельца НЕ отличает: агент работает в браузере владельца, через тот же
 * tailnet, с тем же логином. Отличить может только объявление: агент в начале
 * работы открывает `/actor` и объявляет себя — кука `mydon_actor` с именем
 * агента. Это атрибуция, а не право: доступ по-прежнему решают SERVICE_TOKEN и
 * OWNER_ACTION_TOKEN, и ни одна проверка прав эту куку не читает.
 *
 * СРОК. Забытая кука подписала бы решения владельца работой машины — а
 * `@mydon/shared/actor.ts` прямо называет эту ошибку опасной стороной. Поэтому
 * кука живёт часы, а не год, как тема, и пока она есть, шапка панели
 * показывает это плашкой с кнопкой «сбросить».
 */
export const ACTOR_COOKIE = "mydon_actor";

/** Восемь часов — рабочая сессия агента, не больше. В секундах, как `maxAge`. */
export const ACTOR_COOKIE_MAX_AGE_S = 8 * 60 * 60;

/** Ссылка объявленного агента из значения куки; мусор — `null`. */
export function declaredAgentRef(raw: string | undefined): string | null {
  const name = parseAgentName(raw);
  return name === null ? null : agentActor(name);
}

/**
 * Решение «кого записать автором» — чистое, без чтения запроса.
 *
 * ПРИНЦИП: в журнал идёт то, что панель ЗНАЕТ. Где не знает — прежнее
 * допущение «владелец», и оно названо допущением здесь и в
 * `docs/decisions/2026-09-11-avtor-zapisi-i-podpisi-ostatka.md`.
 *
 * 1. Объявлен агент — автор агент, кто бы ни сидел за браузером: действие
 *    физически совершает он. Спрятаться за агентом нечем: суждения человека
 *    (назначить, принять, оценить задачу) Core агенту не даёт.
 * 2. Опознан владелец — `owner`.
 * 3. Логин пришёл, логин владельца настроен, и это не он — другой человек в
 *    tailnet. Записать его владельцем было бы ложью; пишем его логин (или
 *    «не опознан», если логин не укладывается в формат ссылки).
 * 4. Личность неизвестна (заголовка нет — прямой bind, локалка) или сравнивать
 *    не с чем (OWNER_TAILSCALE_LOGIN не задан) — `owner`, как было (R-P5-6).
 *    Иначе незаданная переменная отняла бы у владельца право принимать
 *    задачи в собственной панели: `assertCan` в Core узнаёт его по `owner`.
 *
 * @param identity             личность из заголовка Tailscale (`resolveOwner`).
 * @param declaredAgent        `agent:<имя>`, если в этом браузере объявлен агент.
 * @param ownerLoginConfigured задан ли OWNER_TAILSCALE_LOGIN — без него
 *                             `isOwner` всегда false, и «не владелец» ничего
 *                             не значит.
 */
export function pickActor(identity: OwnerIdentity, declaredAgent: string | null, ownerLoginConfigured: boolean): string {
  if (declaredAgent !== null) return declaredAgent;
  if (identity.isOwner) return "owner";
  if (identity.login !== null && ownerLoginConfigured) {
    return isActorRef(identity.login) ? identity.login : UNRECOGNIZED_HUMAN_ACTOR;
  }
  return "owner";
}

/**
 * Актор текущего запроса. Вне request-скоупа (скрипт, сборка) куки и
 * заголовков нет — это «ничего не объявлено», а не ошибка, как у
 * `resolveOwner`.
 */
export async function resolveActor(): Promise<string> {
  let declared: string | null = null;
  try {
    declared = declaredAgentRef((await cookies()).get(ACTOR_COOKIE)?.value);
  } catch {
    declared = null;
  }
  const ownerLoginConfigured = (process.env.OWNER_TAILSCALE_LOGIN ?? "").trim() !== "";
  return pickActor(await resolveOwner(), declared, ownerLoginConfigured);
}
