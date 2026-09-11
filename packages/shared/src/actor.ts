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

/**
 * Заголовок, которым панель передаёт Core актора записи (R-H-9). Одна
 * константа на обе стороны: две копии строки разъехались бы на первой правке,
 * и Core молча перестал бы видеть актора — журнал снова подписывал бы всё
 * владельцем, без единой ошибки.
 */
export const ACTOR_HEADER = "x-mydon-actor";

/**
 * Формат ссылки, которую можно передать заголовком и записать в журнал:
 * `owner`, `agent:claude-code`, `person:<uuid>`, логин tailnet. Только ASCII
 * без пробелов — значение заголовка в `fetch` обязано быть ASCII, иначе запись
 * падает целиком, а пробелы, переводы строк и разметка в журнале не нужны.
 * Одна проверка на обе стороны: панель не отправит того, что Core отбросит.
 */
const ACTOR_REF_PATTERN = /^[A-Za-z0-9_.:@+-]{1,120}$/;

export function isActorRef(ref: string | null | undefined): ref is string {
  return typeof ref === "string" && ACTOR_REF_PATTERN.test(ref);
}

/**
 * Человек, которого панель видит по логину, но записать логином не может
 * (логин не укладывается в формат ссылки). Честнее «не опознан», чем
 * молча записать владельцем.
 */
export const UNRECOGNIZED_HUMAN_ACTOR = "tailnet:unrecognized";

/**
 * Имя агента, которое можно объявить в панели: `claude-code`, `codex`.
 * Строчные латиница, цифры и дефис — оно становится частью ссылки
 * `agent:<имя>` в журнале, и мусор в нём прочитает человек.
 */
const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;

/** Нормализовать имя агента; не годится — `null`. */
export function parseAgentName(raw: string | null | undefined): string | null {
  const name = (raw ?? "").trim().toLowerCase();
  return AGENT_NAME_PATTERN.test(name) ? name : null;
}
