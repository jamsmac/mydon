/**
 * Кто совершил действие — вид актора по его ссылке.
 *
 * ЗАЧЕМ. В журнале `audit_log` две колонки: `actor_kind` (человек / агент /
 * система) и `actor_ref` (кто именно). Вид долго проставляли литералом
 * `"human"` во всех местах сразу, и массовый прогон инструмента попадал в
 * журнал человеком. Разница не косметическая: «вид автомата выбрал человек»
 * и «вид проставил скрипт» — это разный вес решения, и ровно на нём стоит
 * обещание `docs/REGISTRY_CLEANUP.md` про «через полгода будет видно».
 *
 * СОГЛАШЕНИЕ О ССЫЛКАХ. Вид выводится из префикса, а не из списка известных
 * имён: список пришлось бы править при каждом новом инструменте, и он молча
 * устаревал бы, продолжая называть скрипты людьми.
 *
 *   `tool:<имя>`   → system  — массовые прогоны, миграции, скрипты
 *   `agent:<имя>`  → agent   — AI-агенты MYDON и ассистенты
 *   `system`       → system  — действие без установленного инициатора
 *   всё остальное  → human   — `owner`, логин сотрудника
 *
 * Умолчание «человек» осознанно: неизвестная ссылка скорее человек, чем
 * скрипт, а ошибиться в сторону завышенного веса решения безопаснее, чем
 * записать решение владельца работой машины.
 */
export type ActorKind = "human" | "agent" | "system";

/** Префиксы ссылок. Меняя их, поправить и `actorKindOf`, и тесты. */
export const ACTOR_PREFIX = {
  tool: "tool:",
  agent: "agent:",
} as const;

export function actorKindOf(actorRef: string | null | undefined): ActorKind {
  const ref = (actorRef ?? "").trim().toLowerCase();
  if (ref.length === 0) return "system";
  if (ref.startsWith(ACTOR_PREFIX.tool)) return "system";
  if (ref.startsWith(ACTOR_PREFIX.agent)) return "agent";
  if (ref === "system") return "system";
  return "human";
}

/** Ссылка инструмента: `tool:apply-maintenance-norms`. */
export function toolActor(name: string): string {
  return `${ACTOR_PREFIX.tool}${name}`;
}

/** Ссылка агента: `agent:coffee-monitor`. */
export function agentActor(name: string): string {
  return `${ACTOR_PREFIX.agent}${name}`;
}
