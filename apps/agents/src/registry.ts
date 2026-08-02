import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { AutonomyTier } from "@mydon/shared";
import { asBudgetStrategy, type BudgetStrategy } from "./budget";

/** Расписание запуска навыка агента. */
export interface AgentSchedule {
  cron: string;
  skill: string;
}

/** Паспорт агента: у агента нет своего кода, только описание (перенесено как есть). */
export interface AgentDefinition {
  name: string;
  business: string;
  status: "active" | "paused" | "draft" | "deprecated";
  description?: string;
  autonomyDefault: AutonomyTier;
  schedule: AgentSchedule[];
  skills: string[];
  budgetPerDayUsd?: number;
  /** Что делать при исчерпании бюджета (паспорт: budget.on_exceeded). */
  budgetOnExceeded?: BudgetStrategy;
  dir: string;
}

const TIERS = new Set(["T0", "T1", "T2", "T3", "T4"]);

function asTier(value: unknown): AutonomyTier {
  const raw = typeof value === "string" ? value.trim().toUpperCase() : "";
  return TIERS.has(raw) ? (raw as AutonomyTier) : "T0"; // неизвестное — самый строгий уровень
}

function asStatus(value: unknown): AgentDefinition["status"] {
  // В config.yaml после значения бывает комментарий — берём первое слово.
  const raw = typeof value === "string" ? value.split("#")[0].trim().toLowerCase() : "";
  if (raw === "active" || raw === "paused" || raw === "draft" || raw === "deprecated") return raw;
  return "draft";
}

/** Читает паспорта агентов из каталога. Битый паспорт не роняет остальные. */
export function loadAgents(agentsDir: string): {
  agents: AgentDefinition[];
  errors: { dir: string; reason: string }[];
} {
  const agents: AgentDefinition[] = [];
  const errors: { dir: string; reason: string }[] = [];

  if (!fs.existsSync(agentsDir)) {
    return { agents, errors: [{ dir: agentsDir, reason: "каталог агентов не найден" }] };
  }

  for (const name of fs.readdirSync(agentsDir).sort()) {
    if (name.startsWith("_") || name.startsWith(".")) continue; // _template — шаблон, не агент
    const dir = path.join(agentsDir, name);
    if (!fs.statSync(dir).isDirectory()) continue;

    const configPath = path.join(dir, "config.yaml");
    if (!fs.existsSync(configPath)) {
      errors.push({ dir: name, reason: "нет config.yaml" });
      continue;
    }

    try {
      const raw = parseYaml(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
      const schedule: AgentSchedule[] = Array.isArray(raw.schedule)
        ? (raw.schedule as Record<string, unknown>[])
            .filter((s) => typeof s?.cron === "string" && typeof s?.skill === "string")
            .map((s) => ({ cron: String(s.cron), skill: String(s.skill) }))
        : [];

      const budget = raw.budget as { per_day_usd?: unknown; on_exceeded?: unknown } | undefined;

      agents.push({
        name: typeof raw.name === "string" ? raw.name : name,
        business: typeof raw.business === "string" ? raw.business : "shared",
        status: asStatus(raw.status),
        ...(typeof raw.description === "string" ? { description: raw.description } : {}),
        autonomyDefault: asTier(raw.autonomy_default),
        schedule,
        skills: Array.isArray(raw.skills) ? raw.skills.map(String) : [],
        ...(typeof budget?.per_day_usd === "number" ? { budgetPerDayUsd: budget.per_day_usd } : {}),
        ...(budget?.on_exceeded !== undefined ? { budgetOnExceeded: asBudgetStrategy(budget.on_exceeded) } : {}),
        dir,
      });
    } catch (err) {
      errors.push({ dir: name, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { agents, errors };
}
