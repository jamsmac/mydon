import path from "node:path";
import { config as loadEnv } from "dotenv";
import { Cron } from "croner";
import { TZ } from "@mydon/shared";
import { AgentsCoreClient } from "./core-client";
import { autonomyThreshold } from "./policy";
import { loadAgents } from "./registry";
import { runSkill } from "./runner";

loadEnv({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

const AGENTS_DIR = path.resolve(__dirname, "../agents");

/**
 * MYDON Agents — исполнительный слой.
 * Агенты не действуют напрямую: пишут события и создают запросы на согласование в Core.
 * Расписание — в часовом поясе Asia/Tashkent (правило ТЗ для всех cron).
 */
async function main(): Promise<void> {
  const coreUrl = process.env.CORE_API_URL ?? "http://127.0.0.1:3001";
  const core = new AgentsCoreClient(coreUrl);
  const threshold = autonomyThreshold();

  const { agents, errors } = loadAgents(AGENTS_DIR);
  for (const e of errors) {
    console.warn(`Паспорт "${e.dir}" пропущен: ${e.reason}`);
  }

  const active = agents.filter((a) => a.status === "active");
  console.log(
    `MYDON Agents: паспортов ${agents.length}, активных ${active.length}, ` +
      `порог автономии ${threshold}${threshold === "T0" ? " (всё через согласование)" : ""}.`,
  );

  if (process.env.AGENTS_SCHEDULES_PAUSED === "1") {
    console.log("AGENTS_SCHEDULES_PAUSED=1 — расписания не запускаются.");
    return;
  }

  let jobs = 0;
  for (const agent of active) {
    for (const item of agent.schedule) {
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
  if (jobs === 0) console.log("Активных расписаний нет — процесс завершает работу.");
}

main().catch((err: unknown) => {
  console.error("Агенты остановлены:", err instanceof Error ? err.message : err);
  process.exit(1);
});
