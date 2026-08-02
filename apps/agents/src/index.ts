import path from "node:path";
import { config as loadEnv } from "dotenv";
import { Cron } from "croner";
import { TZ } from "@mydon/shared";
import { AgentsCoreClient } from "./core-client";
import { autonomyThreshold } from "./policy";
import { loadAgents, type AgentDefinition } from "./registry";
import { runSkill } from "./runner";
import { desiredJobs, jobKey } from "./schedule";
import { loadSkillMeta, skillTierFloors } from "./skill-loader";
import { hasSkill } from "./skills";
import { runAgentTasks } from "./task-worker";

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
  const core = new AgentsCoreClient(coreUrl, 10_000, process.env.SERVICE_TOKEN ?? "");
  const threshold = autonomyThreshold();

  // Минимальные тиры навыков (frontmatter `requires-approval`). Файлы навыков —
  // часть образа и в рантайме не меняются, поэтому читаем один раз. Ключ — имя
  // навыка, поэтому карта годится и для агентов из базы (у них нет каталога).
  const skillFloors = skillTierFloors(loadSkillMeta(AGENTS_DIR));

  const { agents: fromFiles, errors } = loadAgents(AGENTS_DIR);
  for (const e of errors) {
    console.warn(`Паспорт "${e.dir}" пропущен: ${e.reason}`);
  }

  // Источник истины — база Core: только там правки владельца из карточки агента
  // переживают обновление системы. Файлы-паспорта служат начальным сидом.
  //
  // Контекст: контейнеры поднимаются одновременно, и Core обычно ещё не готов,
  // когда агенты уже стартовали. Раньше мы один раз падали на файлы и больше
  // не пробовали — правки владельца в карточках не действовали до рестарта
  // (найдено ревизией 2026-07-30). Теперь пробуем несколько раз при старте
  // и перечитываем базу по расписанию.
  let agents = fromFiles;
  let fromCoreOk = false;

  async function loadFromCore(): Promise<AgentDefinition[] | null> {
    try {
      const seed = await core.seedAgents(fromFiles.map(toPassport));
      if (seed.seeded > 0) {
        console.log(`Паспорта перенесены в базу: заведено ${seed.seeded}, уже было ${seed.skipped}.`);
      }
      return (await core.listAgents()).map(fromCore);
    } catch {
      return null;
    }
  }

  // До 10 попыток с паузой 6 секунд — минута ожидания покрывает запуск Core
  // вместе с миграциями базы.
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const loaded = await loadFromCore();
    if (loaded !== null) {
      agents = loaded;
      fromCoreOk = true;
      console.log("Настройки агентов прочитаны из базы (карточка агента — источник истины).");
      break;
    }
    if (attempt === 1) console.warn("Core пока не отвечает — ждём и пробуем снова…");
    if (attempt === 10) {
      console.warn(
        "Core не ответил за минуту — работаю по паспортам-файлам. " +
          "Настройки из карточек агентов подхватятся при следующей перечитке.",
      );
    } else {
      await new Promise((r) => setTimeout(r, 6000));
    }
  }

  console.log(
    `MYDON Agents: паспортов ${agents.length}, активных ${agents.filter((a) => a.status === "active").length}, ` +
      `порог автономии ${threshold}${threshold === "T0" ? " (всё через согласование)" : ""}.`,
  );

  if (process.env.AGENTS_SCHEDULES_PAUSED === "1") {
    console.log("AGENTS_SCHEDULES_PAUSED=1 — расписания не запускаются. Ожидаю снятия паузы.");
    // Не выходим: иначе Docker с restart-политикой поднимал бы контейнер по кругу.
    await idle();
    return;
  }

  // Запущенные cron-задания по ключу «агент навык расписание». Перечитка
  // настроек примиряет этот набор с желаемым: снятые/изменённые — гасим,
  // новые — заводим. Раньше набор считался ОДИН раз, и правки владельца в
  // карточке (пауза агента, новое расписание) не действовали до перезапуска.
  const cronJobs = new Map<string, Cron>();
  let lastNotWired = "";

  function reconcileSchedules(): void {
    const { jobs, notWired } = desiredJobs(agents, hasSkill);
    const want = new Set(jobs.map(jobKey));

    // Гасим то, чего в желаемом наборе больше нет.
    for (const [key, job] of cronJobs) {
      if (!want.has(key)) {
        job.stop();
        cronJobs.delete(key);
      }
    }

    // Заводим недостающее. Колбэк ищет агента по имени в момент срабатывания —
    // так он видит СВЕЖИЕ настройки (статус, автономию), а не снимок на старте.
    for (const j of jobs) {
      const key = jobKey(j);
      if (cronJobs.has(key)) continue;
      try {
        const job = new Cron(j.cron, { timezone: TZ, name: `${j.agent}:${j.skill}` }, () => {
          void (async () => {
            const current = agents.find((a) => a.name === j.agent && a.status === "active");
            if (!current) return; // агента отключили — расписание догаснет на след. перечитке
            try {
              const result = await runSkill(current, j.skill, core, threshold, skillFloors.get(j.skill));
              console.log(`[${result.agent}/${result.skill}] ${result.outcome} — ${result.reason}`);
            } catch (err) {
              console.error(`[${j.agent}/${j.skill}] сбой:`, err);
            }
          })();
        });
        cronJobs.set(key, job);
      } catch (err) {
        console.warn(
          `Расписание "${j.cron}" агента ${j.agent} не принято: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    const nw = notWired.join(", ");
    if (nw !== lastNotWired) {
      lastNotWired = nw;
      if (nw.length > 0) console.log(`Навыки без реализации (не планируются): ${nw}.`);
    }
  }

  /**
   * Задачи, поручённые агентам владельцем. Проверяем регулярно: владелец
   * ставит задачу в панели и вправе ждать, что агент займётся ею сам,
   * не дожидаясь своего расписания. Список активных берём СВЕЖИЙ на каждый
   * проход — не снимок на старте.
   */
  async function pollAgentTasks(): Promise<void> {
    for (const agent of agents.filter((a) => a.status === "active")) {
      try {
        const results = await runAgentTasks(agent, core, threshold, skillFloors);
        for (const r of results) {
          console.log(`[${agent.name}] задача ${r.taskId.slice(0, 8)} → ${r.outcome}: ${r.note}`);
        }
      } catch (err) {
        console.error(`[${agent.name}] задачи не обработаны:`, err);
      }
    }
  }

  // Перечитка настроек раз в 10 минут: правки владельца в карточке агента
  // начинают действовать сами, без перезапуска контейнера. Заодно это лечит
  // случай «Core поднялся позже нас». После перечитки — примиряем расписания.
  setInterval(
    () => {
      void (async () => {
        const loaded = await loadFromCore();
        if (loaded === null) return;
        const changed = JSON.stringify(loaded) !== JSON.stringify(agents);
        agents = loaded;
        if (!fromCoreOk) {
          fromCoreOk = true;
          console.log("Связь с Core появилась — настройки агентов взяты из базы.");
        } else if (changed) {
          console.log("Настройки агентов обновлены из базы.");
        }
        if (changed) reconcileSchedules();
      })();
    },
    10 * 60_000,
  ).unref();

  reconcileSchedules();

  const taskEveryMs = Number(process.env.AGENT_TASK_INTERVAL_MS ?? 5 * 60_000);
  setInterval(() => {
    void pollAgentTasks().catch((err: unknown) => console.error("Задачи агентов:", err));
  }, taskEveryMs).unref();
  void pollAgentTasks(); // первый проход сразу при старте

  console.log(`Запланировано заданий: ${cronJobs.size} (часовой пояс ${TZ}).`);
  // Держим процесс живым всегда: расписания могут появиться после перечитки,
  // задачи опрашиваются по таймеру — выходить на «сейчас заданий нет» нельзя.
  await idle();
}

main().catch((err: unknown) => {
  console.error("Агенты остановлены:", err instanceof Error ? err.message : err);
  process.exit(1);
});
