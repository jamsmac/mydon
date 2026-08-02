import type { AutonomyTier } from "@mydon/shared";
import { maxTier } from "./policy";

/**
 * Классификация инструментов навыка и вытекающий из них минимальный тир
 * (перенос TOOLTYPE_MIN из mydon-agent-os).
 *
 * Навык объявляет `allowed-tools` во frontmatter. Тип инструмента задаёт пол
 * автономии: читать данные безопасно (T0), а исполнять команду или трогать
 * деньги/договор — нет (T3/T4). Это ещё один источник floor для мульти-
 * источникового гейта (#5): эффективный тир навыка = максимум из карточки
 * агента, объявленного тира навыка И пола по инструментам — строже побеждает.
 *
 * Неизвестный инструмент считаем `net` (T1), а не `read`: не пропускаем
 * незнакомое как безопасное.
 */

export type ToolType = "read" | "net" | "write" | "exec" | "money" | "contract";

const TOOLTYPE_MIN: Record<ToolType, AutonomyTier> = {
  read: "T0",
  net: "T1",
  write: "T2",
  exec: "T3",
  money: "T3",
  contract: "T4",
};

/**
 * Классифицирует инструмент по имени. Порядок проверок — от самого опасного к
 * безопасному, чтобы `exec:pay_...` не утёк в read по подстроке.
 */
export function classifyTool(tool: string): ToolType {
  const t = tool.trim().toLowerCase();
  if (/(^|[:_])(contract|edo|dogovor|договор)/.test(t)) return "contract";
  if (/(money|invoice|payment|^pay|_pay|платеж|платёж|инкасс)/.test(t)) return "money";
  if (/(^exec|[:_]exec|^run[:_]|shell|bash|command)/.test(t)) return "exec";
  if (/(^write|[:_]write|create|update|delete|записать|создать|изменить)/.test(t)) return "write";
  if (/(^send|notify|post|message|telegram|email|отправ)/.test(t)) return "net"; // исходящее уведомление
  if (/(web|net|fetch|http|scrape|browse)/.test(t)) return "net";
  if (/(^read|[:_]read|^get|^list|kb|db|reg|entities)/.test(t)) return "read";
  return "net"; // неизвестное — консервативно, не как read
}

/** Пол тира по набору инструментов навыка: строжайший тип. Пусто → T0. */
export function toolTierFloor(tools: readonly string[]): AutonomyTier {
  return maxTier(tools.map((t) => TOOLTYPE_MIN[classifyTool(t)]));
}
