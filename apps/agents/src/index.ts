import path from "node:path";
import { config as loadEnv } from "dotenv";
import { Cron } from "croner";
import { TZ } from "@mydon/shared";
import { AgentsCoreClient } from "./core-client";
import { autonomyThreshold } from "./policy";
import { loadAgents, type AgentDefinition } from "./registry";
import { runSkill } from "./runner";
import { hasSkill } from "./skills";

loadEnv({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

const AGENTS_DIR = path.resolve(__dirname, "../agents");

/** Паспорт-файл → тело для переноса в базу (начальный сид). */
function toPassport(a: AgentDefinition): Record<string, unknown> {
  return {
    name: a.name,
    business: a.business,
    status: a.status,
    ...(a.description !== undefined ? { description: a.description } : {}),
    autonomyDefault: a.autonomyDefault,
    skills: a.skills,
    schedule: a.schedule,
    ...(a.budgetPerDayUsd !== undefined ? { budgetPerDayUsd: a.budgetPerDayUsd } : {}),
  };
}

/** Настройки из базы → та же форма, что и у паспорта-файла. */
function fromCore(row: {
  name: string;
  business: string;
  status: string;
  description: string | null;
  autonomyDefault: "T0" | "T1" | "T2" | "T3" | "T4";
  skills: unknown;
  schedule: unknown;
  budgetPerDayUsd: string | null;
}): AgentDefinition {
  const schedule = Array.isArray(row.schedule)
    ? (row.schedule as { cron?: unknown; skill?: unknown }[])
        .filter((s) => typeof s?.cron === "string" && typeof s?.skill === "string")
        .map((s) => ({ cron: String(s.cron), skill: String(s.skill) }))
    : [];
  const budget = row.budgetPerDayUsd === null ? undefined : Number(row.budgetPerDayUsd);
  const status = ["active", "paused", "draft", "deprecated"].includes(row.status)
    ? (row.status as AgentDefinition["status"])
    : "draft";

  return {
    name: row.name,
    business: row.business,
    status,
    ...(row.description !== null ? { description: row.description } : {}),
    autonomyDefault: row.autonomyDefault,
    schedule,
    skills: Array.isArray(row.skills) ? row.skills.map(String) : [],
    ...(budget !== undefined && Number.isFinite(budget) ? { budgetPerDayUsd: budget } : {}),
    dir: "(из базы)",
  };
}

/**
 * Держит процесс живым, когда работать не с чем. Завершается по SIGTERM от Docker.
 *
 * Одного «зависшего» промиса НЕДОСТАТОЧНО: незавершённый промис не является
 * дескриптором цикла событий, и Node всё равно выходит. Нужен настоящий таймер
 * (намеренно без unref — именно он и удерживает процесс).
 */
function idle(): Promise<never> {
  return new Promise<never>(() => {
    setInterval(() => {}, 1 << 30);
  });
}

/**
 * MYDON Agents — исполнительный слой.
 * Агенты не действуют напрямую: пишут события и создают запросы на согласование в Core.
 * Расписание — в часовом поясе Asia/Tashkent (правило ТЗ для всех cron).
 */
async function main(): Promise<void> {
  const coreUrl = process.env.CORE_API_URL ?? "http://127.0.0.1:3001";
  const core = new AgentsCoreClient(coreUrl);
  const threshold = autonomyThreshold();

  const { agents: fromFiles, errors } = loadAgents(AGENTS_DIR);
  for (const e of errors) {
    console.warn(`Паспорт "${e.dir}" пропущен: ${e.reason}`);
  }

  // Источник истины — база Core: только там правки владельца из карточки агента
  // переживают обновление системы. Файлы-паспорта служат начальным сидом.
  // Core недоступен → работаем по файлам, чтобы агенты не встали совсем.
  let agents = fromFiles;
  try {
    const seed = await core.seedAgents(fromFiles.map(toPassport));
    if (seed.seeded > 0) {
      console.log(`Паспорта перенесены в базу: заведено ${seed.seeded}, уже было ${seed.skipped}.`);
    }
    agents = (await core.listAgents()).map(fromCore);
    console.log("Настройки агентов прочитаны из базы (карточка агента — источник истины).");
  } catch (err) {
    console.warn(
      "Core недоступен — работаю по паспортам-файлам: " +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  const active = agents.filter((a) => a.status === "active");
  console.log(
    `MYDON Agents: паспортов ${agents.length}, активных ${active.length}, ` +
      `порог автономии ${threshold}${threshold === "T0" ? " (всё через согласование)" : ""}.`,
  );

  if (process.env.AGENTS_SCHEDULES_PAUSED === "1") {
    console.log("AGENTS_SCHEDULES_PAUSED=1 — расписания не запускаются. Ожидаю снятия паузы.");
    // Не выходим: иначе Docker с restart-политикой поднимал бы контейнер по кругу.
    await idle();
  }

  let jobs = 0;
  const notWired: string[] = [];
  for (const agent of active) {
    for (const item of agent.schedule) {
      // Навык без реализации планировать бессмысленно: он всё равно вернёт
      // «не подключён». Говорим об этом один раз, а не по будильнику каждый день.
      if (!hasSkill(item.skill)) {
        notWired.push(`${agent.name}/${item.skill}`);
        continue;
      }
      try {
        new Cron(item.cron, { timezone: TZ, name: `${agent.name}:${item.skill}` }, () => {
          void (async () => {
            try {
              const result = await runSkill(agent, item.skill, core, threshold);
              console.log(`[${result.agent}/${result.skill}] ${result.outcome} — ${result.reason}`);
            } catch (err) {
              console.error(`[${agent.name}/${item.skill}] сбой:`, err);
            }
          })();
        });
        jobs += 1;
      } catch (err) {
        console.warn(
          `Расписание "${item.cron}" агента ${agent.name} не принято: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
  }

  console.log(`Запланировано заданий: ${jobs} (часовой пояс ${TZ}).`);
  if (notWired.length > 0) {
    console.log(`Навыки без реализации (не планируются): ${notWired.join(", ")}.`);
  }
  if (jobs === 0) {
    console.log("Активных расписаний нет — жду появления.");
    await idle();
  }
}

main().catch((err: unknown) => {
  console.error("Агенты остановлены:", err instanceof Error ? err.message : err);
  process.exit(1);
});
