import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { AutonomyTier } from "@mydon/shared";
import type { ModelReasoningEffort } from "./model-gateway";
import { maxTier } from "./policy";
import { toolTierFloor } from "./tools";

/**
 * Загрузчик навыков-паспортов (перенос паттерна Agent Skills из прототипа).
 *
 * Навыки MYDON лежат как `.md` с YAML-frontmatter (name, description,
 * allowed-tools, requires-approval) — этот формат уже принят в файлах и в
 * `_template`, но рантайм его НЕ ЧИТАЛ: тир навыка (`requires-approval`) и
 * список инструментов молча выбрасывались, а порог считался только по карточке
 * агента. Так навык draft-quote, помеченный «деньги → T3», при карточке агента
 * T1 мог бы исполниться ниже собственного объявленного уровня.
 *
 * Загрузчик читает frontmatter и отдаёт:
 *  • метаданные каждого навыка (для будущего LLM-пути и least-privilege по
 *    инструментам — пока только собираем, не применяем);
 *  • карту «имя навыка → минимальный тир» (floor) для мульти-источникового
 *    гейта: floor берётся как САМЫЙ СТРОГИЙ среди всех файлов с этим именем,
 *    поэтому не зависит от того, откуда пришёл агент (файл-паспорт или база).
 *
 * Нет frontmatter или он битый → навык не роняет остальные: name берётся из
 * имени файла, проблемы копятся в `problems` (их показывает check-passports).
 */

/** Метаданные навыка из frontmatter его `.md`. */
export interface SkillMeta {
  /** Имя навыка (frontmatter `name` или имя файла как запасной вариант). */
  name: string;
  /** Каталог агента, которому принадлежит файл навыка. */
  agent: string;
  /** Одна фраза для выбора навыка (progressive disclosure, уровень 1). */
  description: string;
  /** Разрешённые инструменты (least privilege) — собираем на будущее. */
  allowedTools: string[];
  /** Минимальный тир навыка: ниже него действие не исполняется без согласования. */
  requiresApproval?: AutonomyTier;
  /** Абсолютный путь к файлу навыка. */
  file: string;
  /**
   * Кто исполняет навык: `code` — функция из реестра SKILLS (как всегда было),
   * `llm` — общий исполнитель markdown-навыка (спека 2026-09-04-llm-skill-executor:
   * тело файла становится инструкцией модели, ответ — обычным Proposal).
   */
  executor: SkillExecutor;
  /** Регулярные выражения для подбора навыка по заголовку задачи (frontmatter `triggers`). */
  triggers: string[];
  /** Усилие рассуждения модели для `llm`-навыка (frontmatter `model-effort`). */
  modelEffort?: ModelReasoningEffort;
  /** Потолок токенов ответа для `llm`-навыка (frontmatter `max-tokens`). */
  maxTokens?: number;
  /** Тело файла без frontmatter — инструкция для `llm`-исполнителя. */
  body: string;
  /** Замечания к frontmatter (пусто = чисто). Поднимает check-passports. */
  problems: string[];
}

export type SkillExecutor = "code" | "llm";

const TIERS = new Set(["T0", "T1", "T2", "T3", "T4"]);
const EXECUTORS = new Set<SkillExecutor>(["code", "llm"]);
// Без `minimal`: провайдерный маршрут его отвергает, поэтому `model-effort:
// minimal` во frontmatter — замечание паспорта, а не рабочее значение.
const EFFORTS = new Set<ModelReasoningEffort>(["none", "low", "medium", "high", "xhigh", "max"]);

function asTier(value: unknown): AutonomyTier | undefined {
  const raw = typeof value === "string" ? value.trim().toUpperCase() : "";
  return TIERS.has(raw) ? (raw as AutonomyTier) : undefined;
}

/**
 * Отделяет YAML-frontmatter (`--- … ---` в самом начале файла) от тела.
 * Нет frontmatter или он не разобрался → `data` пустой, `body` — весь текст.
 * Сознательно не тянем зависимость gray-matter: разбор фронтматтера здесь
 * тривиален, а `yaml` уже в зависимостях пакета.
 */
export function splitFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { data: {}, body: text };
  let data: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(match[1]) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // Битый frontmatter считаем пустым — проблему поднимет валидатор ниже.
  }
  return { data, body: match[2] };
}

/** Строит метаданные одного навыка и копит замечания к его frontmatter. */
function buildMeta(
  agent: string,
  filename: string,
  file: string,
  data: Record<string, unknown>,
  body = "",
): SkillMeta {
  const problems: string[] = [];
  const fallbackName = filename.replace(/\.md$/, "");

  const nameRaw = typeof data.name === "string" ? data.name.trim() : "";
  if (!nameRaw) problems.push("нет поля name во frontmatter");
  else if (nameRaw !== fallbackName) problems.push(`name «${nameRaw}» ≠ имени файла «${fallbackName}»`);
  const name = nameRaw || fallbackName;

  const description = typeof data.description === "string" ? data.description.trim() : "";
  if (!description) problems.push("нет описания (description) — модель не выберет навык");

  const toolsRaw = data["allowed-tools"] ?? data.allowedTools;
  if (toolsRaw !== undefined && !Array.isArray(toolsRaw)) problems.push("allowed-tools должен быть списком");
  const allowedTools = Array.isArray(toolsRaw) ? toolsRaw.map(String) : [];

  const approvalRaw = data["requires-approval"] ?? data.requiresApproval;
  const requiresApproval = asTier(approvalRaw);
  if (approvalRaw === undefined) problems.push("нет requires-approval — минимальный тир навыка не задан");
  else if (requiresApproval === undefined) problems.push(`неизвестный тир requires-approval «${String(approvalRaw)}»`);

  // Исполнитель: по умолчанию код (поведение как раньше). `llm` — исполняемый markdown.
  const executorRaw = data.executor;
  let executor: SkillExecutor = "code";
  if (executorRaw !== undefined) {
    const value = typeof executorRaw === "string" ? executorRaw.trim().toLowerCase() : "";
    if (EXECUTORS.has(value as SkillExecutor)) executor = value as SkillExecutor;
    else problems.push(`неизвестный executor «${String(executorRaw)}» — допустимы code | llm`);
  }
  if (executor === "llm" && requiresApproval === undefined) {
    problems.push("executor: llm без requires-approval — llm-навык обязан объявить минимальный тир");
  }

  // Триггеры подбора по заголовку задачи: регулярные выражения (без флагов).
  const triggersRaw = data.triggers;
  const triggers: string[] = [];
  if (triggersRaw !== undefined) {
    if (!Array.isArray(triggersRaw)) problems.push("triggers должен быть списком регулярных выражений");
    else {
      for (const t of triggersRaw) {
        const text = String(t);
        try {
          new RegExp(text, "iu");
          triggers.push(text);
        } catch {
          problems.push(`битая регулярка в triggers: «${text}»`);
        }
      }
    }
  }

  const effortRaw = data["model-effort"] ?? data.modelEffort;
  let modelEffort: ModelReasoningEffort | undefined;
  if (effortRaw !== undefined) {
    const value = typeof effortRaw === "string" ? effortRaw.trim().toLowerCase() : "";
    if (EFFORTS.has(value as ModelReasoningEffort)) modelEffort = value as ModelReasoningEffort;
    else problems.push(`неизвестный model-effort «${String(effortRaw)}»`);
  }

  const maxTokensRaw = data["max-tokens"] ?? data.maxTokens;
  let maxTokens: number | undefined;
  if (maxTokensRaw !== undefined) {
    const n = Number(maxTokensRaw);
    if (Number.isInteger(n) && n > 0) maxTokens = n;
    else problems.push(`max-tokens должен быть целым положительным числом, получено «${String(maxTokensRaw)}»`);
  }

  return {
    name,
    agent,
    description,
    allowedTools,
    requiresApproval,
    file,
    executor,
    triggers,
    ...(modelEffort !== undefined ? { modelEffort } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    body,
    problems,
  };
}

/**
 * Читает frontmatter всех навыков из каталога агентов.
 * `_template` и скрытые каталоги пропускаются — как и в registry/check-passports.
 */
export function loadSkillMeta(agentsDir: string): SkillMeta[] {
  const out: SkillMeta[] = [];
  if (!fs.existsSync(agentsDir)) return out;

  for (const agent of fs.readdirSync(agentsDir).sort()) {
    if (agent.startsWith("_") || agent.startsWith(".")) continue;
    const agentDir = path.join(agentsDir, agent);
    if (!fs.statSync(agentDir).isDirectory()) continue;

    const skillsDir = path.join(agentDir, "skills");
    if (!fs.existsSync(skillsDir) || !fs.statSync(skillsDir).isDirectory()) continue;

    for (const f of fs.readdirSync(skillsDir).sort()) {
      if (!f.endsWith(".md")) continue;
      const file = path.join(skillsDir, f);
      const { data, body } = splitFrontmatter(fs.readFileSync(file, "utf8"));
      out.push(buildMeta(agent, f, file, data, body));
    }
  }
  return out;
}

/**
 * Пол тира одного навыка: максимум из объявленного `requires-approval` и пола
 * по инструментам (`allowed-tools`). Так навык с `exec:`/`write` инструментом
 * не исполнится ниже соответствующего тира, даже если `requires-approval` мягче.
 * Ни того, ни другого нет → undefined (пол не задан).
 */
export function skillFloor(meta: SkillMeta): AutonomyTier | undefined {
  const toolFloor = meta.allowedTools.length ? toolTierFloor(meta.allowedTools) : undefined;
  if (meta.requiresApproval === undefined) return toolFloor;
  return toolFloor ? maxTier([meta.requiresApproval, toolFloor]) : meta.requiresApproval;
}

/**
 * Карта «имя навыка → минимальный тир (floor)».
 *
 * Один навык может встречаться у нескольких агентов (напр. business-brief у
 * globerent-ceo и vendhub-ceo). Берём САМЫЙ СТРОГИЙ пол: если хоть одна копия
 * строже (по тиру или по инструментам), floor поднимается для всех запусков.
 * Так гейт не зависит от каталога агента и работает и для агентов из базы.
 */
export function skillTierFloors(metas: SkillMeta[]): Map<string, AutonomyTier> {
  const floors = new Map<string, AutonomyTier>();
  for (const m of metas) {
    const floor = skillFloor(m);
    if (floor === undefined) continue;
    const current = floors.get(m.name);
    floors.set(m.name, current ? maxTier([current, floor]) : floor);
  }
  return floors;
}
