import type { SkillMeta } from "./skill-loader";

/**
 * Каталог навыков для Core (R-SD-1: каталог — зеркало файлов).
 *
 * Источник истины о навыке — его `.md` в образе агентов, а не база: панель
 * `/skills` не должна читать диск контейнера агентов и не должна догадываться,
 * какие навыки существуют. Поэтому агенты при каждом успешном старте
 * ПОЛНОСТЬЮ переписывают каталог в Core, а панель читает только Core.
 *
 * Форма строки повторяет DTO Core один в один: там стоит
 * `whitelist + forbidNonWhitelisted`, и ОДИН лишний ключ (или `tier: undefined`,
 * пришедший как `null`) завалил бы весь каталог 400-й ошибкой — панель осталась
 * бы пустой, и никто бы не понял почему. Отсюда правило: незаданные поля не
 * попадают в объект вовсе.
 */
export interface CatalogSkill {
  agent: string;
  skill: string;
  description: string;
  executor: "code" | "llm";
  /** `requires-approval` навыка: T0..T4. Не задан — ключа нет. */
  tier?: string;
  triggers: string[];
  allowedTools: string[];
  modelEffort?: string;
  maxTokens?: number;
  /** Есть реализация в реестре SKILLS: код побеждает `executor: llm`. */
  hasCode: boolean;
  problems: string[];
}

/**
 * Паспорта навыков → строки каталога. Чистая функция: `hasCode` приходит
 * снаружи (реестр SKILLS), чтобы каталог не тянул рантайм навыков.
 */
export function catalogFromMetas(
  metas: readonly SkillMeta[],
  hasCode: (name: string) => boolean,
): CatalogSkill[] {
  return metas.map((m) => ({
    agent: m.agent,
    skill: m.name,
    description: m.description,
    executor: m.executor,
    ...(m.requiresApproval !== undefined ? { tier: m.requiresApproval } : {}),
    triggers: m.triggers,
    allowedTools: m.allowedTools,
    ...(m.modelEffort !== undefined ? { modelEffort: m.modelEffort } : {}),
    ...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
    hasCode: hasCode(m.name),
    problems: m.problems,
  }));
}
