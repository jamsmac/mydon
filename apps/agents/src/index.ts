import path from "node:path";
import { config as loadEnv } from "dotenv";
import { Cron } from "croner";
import { TZ } from "@mydon/shared";
import { budgetPosture } from "./budget";
import { coachPosture } from "./coach";
import { runCoffeeMonitor } from "./coffee-monitor";
import { runMaintenanceMonitor } from "./maintenance-monitor";
import { AgentsCoreClient } from "./core-client";
import { runGloberentMonitor } from "./globerent-monitor";
import { llmPosture, modelGatewayFromEnv } from "./model-gateway";
import { autonomyThreshold } from "./policy";
import { runOurvendAccounting } from "./ourvend-accounting";
import { ourvendConfigFromEnv, runOurvendSync } from "./ourvend-sync";
import { loadAgents, type AgentDefinition } from "./registry";
import { runSkill } from "./runner";
import { desiredJobs, jobKey } from "./schedule";
import { loadSkillMeta, skillTierFloors } from "./skill-loader";
import { hasSkill } from "./skills";
import { applySystemOverrides } from "./system-config";
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
    // Конфиг-поля навыков переносим в базу, иначе при загрузке из базы (источник
    // истины) они бы терялись: ингестор идей молчал бы, break-glass был бы пуст.
    ...(a.budgetOnExceeded !== undefined ? { budgetOnExceeded: a.budgetOnExceeded } : {}),
    ...(a.webSources !== undefined ? { webSources: a.webSources } : {}),
    ...(a.breakGlass !== undefined ? { breakGlass: a.breakGlass } : {}),
    ...(a.ideaChannels !== undefined ? { ideaChannels: a.ideaChannels } : {}),
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
  budgetOnExceeded: string | null;
  webSources: unknown;
  breakGlass: unknown;
  ideaChannels: unknown;
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

  // Конфиг-поля навыков из базы: без их переноса ингестор идей и read-sources
  // получали бы пусто (агенты грузятся из базы — источник истины).
  const webSources = Array.isArray(row.webSources)
    ? (row.webSources as { name?: unknown; url?: unknown }[])
        .filter((s) => typeof s?.name === "string" && typeof s?.url === "string")
        .map((s) => ({ name: String(s.name), url: String(s.url) }))
    : [];
  const breakGlass = Array.isArray(row.breakGlass)
    ? (row.breakGlass as unknown[]).filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];
  const ideaChannels = Array.isArray(row.ideaChannels)
    ? (row.ideaChannels as unknown[]).filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];
  const onExceeded =
    row.budgetOnExceeded === "pause" || row.budgetOnExceeded === "downgrade" || row.budgetOnExceeded === "ask"
      ? row.budgetOnExceeded
      : undefined;

  return {
    name: row.name,
    business: row.business,
    status,
    ...(row.description !== null ? { description: row.description } : {}),
    autonomyDefault: row.autonomyDefault,
    schedule,
    skills: Array.isArray(row.skills) ? row.skills.map(String) : [],
    ...(budget !== undefined && Number.isFinite(budget) ? { budgetPerDayUsd: budget } : {}),
    ...(onExceeded !== undefined ? { budgetOnExceeded: onExceeded } : {}),
    ...(webSources.length ? { webSources } : {}),
    ...(breakGlass.length ? { breakGlass } : {}),
    ...(ideaChannels.length ? { ideaChannels } : {}),
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

  // Порог автономии — не const: глобальный тумблер AGENT_AUTONOMY_MAX владелец
  // может менять из панели (оверлей ниже кладёт его в env), и перечитка обновит
  // порог без рестарта. Замыкания захватывают переменную, значит видят свежее.
  let threshold = autonomyThreshold();

  // Наложить глобальные тумблеры из Core (база важнее env) на окружение, чтобы
  // читатели мозга/памяти/бюджета/порога видели правку владельца из панели.
  async function refreshSystemConfig(): Promise<void> {
    await applySystemOverrides(core);
    threshold = autonomyThreshold();
  }

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
      // Тумблеры системы накладываем вместе с настройками агентов: обе правки
      // владельца живут в базе и подхватываются одной перечиткой.
      await refreshSystemConfig();
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
  console.log(`Бюджет: ${budgetPosture()}.`);
  console.log(`Модель: ${llmPosture()}.`);
  console.log(`${coachPosture(modelGatewayFromEnv() !== null)}.`);

  // Пауза расписаний — «живой» тумблер: владелец снимает её из панели (оверлей
  // кладёт значение в env), и перечитка включает расписания без рестарта. Раньше
  // проверка была разовой на старте и уводила процесс в вечный idle — снять
  // паузу можно было только перезапуском.
  const schedulesPaused = (): boolean => process.env.AGENTS_SCHEDULES_PAUSED === "1";
  let lastPaused = schedulesPaused();
  if (lastPaused) {
    console.log("AGENTS_SCHEDULES_PAUSED=1 — расписания на паузе. Слежу за снятием (панель/env).");
  }

  // Запущенные cron-задания по ключу «агент навык расписание». Перечитка
  // настроек примиряет этот набор с желаемым: снятые/изменённые — гасим,
  // новые — заводим. Раньше набор считался ОДИН раз, и правки владельца в
  // карточке (пауза агента, новое расписание) не действовали до перезапуска.
  const cronJobs = new Map<string, Cron>();
  let lastNotWired = "";

  function reconcileSchedules(): void {
    // На паузе желаемый набор пуст: гасим все задания и ничего не заводим.
    if (schedulesPaused()) {
      for (const [key, job] of cronJobs) {
        job.stop();
        cronJobs.delete(key);
      }
      return;
    }

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
    if (schedulesPaused()) return; // на паузе агент не берёт и поручённые задачи (как раньше)
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
        const loaded = await loadFromCore(); // заодно накладывает свежие тумблеры системы
        if (loaded === null) return;
        const changed = JSON.stringify(loaded) !== JSON.stringify(agents);
        agents = loaded;
        if (!fromCoreOk) {
          fromCoreOk = true;
          console.log("Связь с Core появилась — настройки агентов взяты из базы.");
        } else if (changed) {
          console.log("Настройки агентов обновлены из базы.");
        }
        // Пауза — «живой» тумблер: реагируем на её смену, даже если карточки не менялись.
        const pausedNow = schedulesPaused();
        const pauseFlipped = pausedNow !== lastPaused;
        if (pauseFlipped) {
          lastPaused = pausedNow;
          console.log(pausedNow ? "Расписания поставлены на паузу." : "Пауза снята — включаю расписания.");
        }
        if (changed || pauseFlipped) reconcileSchedules();
      })();
    },
    10 * 60_000,
  ).unref();

  reconcileSchedules();

  // Сбор вендинга (ourvend:sync): отдельное расписание, не привязанное к
  // агентам-навыкам. Включается, когда заданы OURVEND_ACCOUNT/PASSWORD; иначе
  // молчит (экран «Автоматы» покажет подсказку задать учётку). Часовой пояс —
  // Ташкент, как и все cron. OURVEND_SYNC_CRON="off" выключает сбор явно.
  const vendingConfig = ourvendConfigFromEnv();
  const vendingCron = process.env.OURVEND_SYNC_CRON ?? "0 */3 * * *";
  if (vendingConfig && vendingCron.toLowerCase() !== "off") {
    try {
      new Cron(vendingCron, { timezone: TZ, name: "ourvend:sync" }, () => {
        void (async () => {
          try {
            const r = await runOurvendSync(core, vendingConfig);
            console.log(
              `[ourvend:sync] ${r.status} — автоматов ${r.machinesOk}/${r.machinesTotal}, слотов ${r.slots}, продаж ${r.productSales}, ${r.durationMs} мс` +
                (r.error ? ` — ${r.error}` : ""),
            );
          } catch (err) {
            console.error("[ourvend:sync] сбой:", err);
          }
        })();
      });
      console.log(`Сбор вендинга (ourvend:sync) включён: "${vendingCron}" (${TZ}).`);
    } catch (err) {
      console.warn(`Расписание сбора вендинга "${vendingCron}" не принято: ` + (err instanceof Error ? err.message : String(err)));
    }
  } else if (!vendingConfig) {
    console.log("Сбор вендинга выключен: не заданы OURVEND_ACCOUNT/OURVEND_PASSWORD.");
  }

  // Учётный снапшот OurVend (ourvend:accounting, П2 поглощения mydon-stock):
  // суточные продажи с догоном до 14 дней + утренний снимок остатков.
  // 08:05 — ПОСЛЕ съёма stock (07:50): паритет сверяет одинаковые сутки.
  // Та же учётка, что у ourvend:sync; "off" выключает явно.
  const accountingCron = process.env.OURVEND_ACCOUNTING_CRON || "5 8 * * *";
  if (vendingConfig && accountingCron.toLowerCase() !== "off") {
    try {
      new Cron(accountingCron, { timezone: TZ, name: "ourvend:accounting" }, () => {
        void (async () => {
          try {
            const r = await runOurvendAccounting(core, vendingConfig);
            console.log(
              `[ourvend:accounting] ${r.status} — автоматов ${r.machinesOk}/${r.machinesTotal}, ` +
                `дней продаж ${r.saleDays} (строк ${r.saleRows}), остатков ${r.stockRows}, ${r.durationMs} мс` +
                (r.error ? ` — ${r.error}` : ""),
            );
          } catch (err) {
            console.error("[ourvend:accounting] сбой:", err);
          }
        })();
      });
      console.log(`Учётный снапшот OurVend (ourvend:accounting) включён: "${accountingCron}" (${TZ}).`);
    } catch (err) {
      console.warn(
        `Расписание учётного снапшота "${accountingCron}" не принято: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  // Мониторинг кофе-бункеров (monitor-coffee-bunkers, T0): не требует внешней
  // учётки — читает уже посчитанные Core недолив/сверку. По умолчанию раз в
  // сутки к утреннему брифингу; COFFEE_MONITOR_CRON="off" выключает явно.
  const coffeeMonitorCron = process.env.COFFEE_MONITOR_CRON ?? "0 7 * * *";
  if (coffeeMonitorCron.toLowerCase() !== "off") {
    try {
      new Cron(coffeeMonitorCron, { timezone: TZ, name: "coffee:monitor" }, () => {
        void (async () => {
          try {
            const r = await runCoffeeMonitor(core);
            console.log(
              `[coffee:monitor] недолив ${r.underfillEvents}, расхождение ${r.anomalyEvents}` +
                (r.errors.length ? ` — ошибки: ${r.errors.join("; ")}` : ""),
            );
          } catch (err) {
            console.error("[coffee:monitor] сбой:", err);
          }
        })();
      });
      console.log(`Мониторинг кофе-бункеров (coffee:monitor) включён: "${coffeeMonitorCron}" (${TZ}).`);
    } catch (err) {
      console.warn(`Расписание мониторинга кофе-бункеров "${coffeeMonitorCron}" не принято: ` + (err instanceof Error ? err.message : String(err)));
    }
  }

  // Монитор инвариантов конвейера GLOBERENT (T0, наследник pipeline-monitor
  // PROMACH): единица в ИМ-74/ИМ-40 без номера ГТД, оплаченный договор без
  // закрытия. Раз в сутки к утреннему брифингу; GLOBERENT_MONITOR_CRON="off"
  // Графики обслуживания. 06:00 — ДО дайджеста сотрудникам (07:00) и до
  // брифинга владельца (07:30): к моменту рассылки задачи уже должны стоять,
  // иначе человек узнает о работе на сутки позже, чем система о ней знает.
  const maintCron = process.env.MAINTENANCE_MONITOR_CRON ?? "0 6 * * *";
  if (maintCron.toLowerCase() !== "off") {
    try {
      new Cron(maintCron, { timezone: TZ, name: "maintenance:monitor" }, () => {
        void (async () => {
          try {
            const r = await runMaintenanceMonitor(core);
            console.log(
              `[maintenance:monitor] задач ${r.tasks}, просрочек ${r.overdue}, невзятых ${r.unclaimed}` +
                (r.errors.length ? ` — ошибки: ${r.errors.join("; ")}` : ""),
            );
          } catch (err) {
            console.error("[maintenance:monitor] сбой:", err);
          }
        })();
      });
      console.log(`Монитор графиков обслуживания: ${maintCron} (${TZ}).`);
    } catch (err) {
      console.error(`Расписание монитора графиков не принято (${maintCron}):`, err);
    }
  }

  // выключает явно.
  const grMonitorCron = process.env.GLOBERENT_MONITOR_CRON ?? "10 7 * * *";
  if (grMonitorCron.toLowerCase() !== "off") {
    try {
      new Cron(grMonitorCron, { timezone: TZ, name: "globerent:monitor" }, () => {
        void (async () => {
          try {
            const r = await runGloberentMonitor(core);
            console.log(
              `[globerent:monitor] без ГТД ${r.unitsNoGtd}, оплачен-не-закрыт ${r.contractsPaidUnclosed}` +
                (r.errors.length ? ` — ошибки: ${r.errors.join("; ")}` : ""),
            );
          } catch (err) {
            console.error("[globerent:monitor] сбой:", err);
          }
        })();
      });
      console.log(`Монитор конвейера GLOBERENT (globerent:monitor) включён: "${grMonitorCron}" (${TZ}).`);
    } catch (err) {
      console.warn(`Расписание монитора GLOBERENT "${grMonitorCron}" не принято: ` + (err instanceof Error ? err.message : String(err)));
    }
  }

  // Автокурс ЦБ РУз (fx:refresh): раз в день дёргаем Core, тот сам ходит в
  // cbu.uz. Ручной курс, заданный владельцем сегодня, Core не перекрывает —
  // правило «manual override главнее» живёт в finance.math Core, не здесь.
  // FX_REFRESH_CRON="off" выключает явно. Часовой пояс — Ташкент, как все cron.
  const fxRefreshCron = process.env.FX_REFRESH_CRON ?? "5 9 * * *";
  if (fxRefreshCron.toLowerCase() !== "off") {
    try {
      new Cron(fxRefreshCron, { timezone: TZ, name: "fx:refresh" }, () => {
        void (async () => {
          try {
            const r = await core.refreshFx();
            const skipped = r.skipped.map((s) => `${s.currency} — ${s.reason}`).join(", ");
            console.log(
              `[fx:refresh] обновлено: ${r.updated.join(", ") || "ничего"}` +
                (skipped ? `; пропущено: ${skipped}` : ""),
            );
          } catch (err) {
            console.error("[fx:refresh] сбой:", err);
          }
        })();
      });
      console.log(`Автокурс ЦБ РУз (fx:refresh) включён: "${fxRefreshCron}" (${TZ}).`);
    } catch (err) {
      console.warn(`Расписание автокурса "${fxRefreshCron}" не принято: ` + (err instanceof Error ? err.message : String(err)));
    }
  }

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
