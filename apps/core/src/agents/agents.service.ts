import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { agent, agentRun, agentSkillCatalog, auditLog, task } from "@mydon/db";
import { TZ, agentWorkPaused, actorKindOf } from "@mydon/shared";
import { and, asc, eq, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { snapshotFreshness } from "../routines/board";
import { RunsService } from "../routines/runs.service";
import { settingValue } from "../system/settings";
import { SystemService } from "../system/system.service";
import { AGENT_SCHEDULE_SOURCE } from "../tasks/agent-schedule";
import { TasksService, isAssignedTaskSql, type ModelEffort } from "../tasks/tasks.service";
import {
  computeAgentState,
  type AgentState,
  type ClaimedTaskLite,
  type LastRunLite,
} from "./agent-state";

type AgentRow = typeof agent.$inferSelect;

/** Тиры автономии по возрастанию строгости: порядок нужен порогу одноимённых навыков. */
export const AGENT_TIERS = ["T0", "T1", "T2", "T3", "T4"] as const;
export type Tier = (typeof AGENT_TIERS)[number];

/** Статусы карточки агента. `draft` — агент есть в файлах, но карточки в базе нет. */
export const AGENT_STATUSES = ["active", "paused", "draft", "deprecated"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** Источник задач, созданных кнопкой «Запустить» в панели навыков (R-SD-2). */
export const SKILLS_DECK_SOURCE = "skills-deck";

/** Строка каталога — ровно то, что прочитано из файла навыка (R-SD-1). */
export interface CatalogSkillInput {
  agent: string;
  skill: string;
  description: string;
  executor: "code" | "llm";
  tier?: Tier;
  triggers: string[];
  allowedTools: string[];
  modelEffort?: string;
  maxTokens?: number;
  hasCode: boolean;
  problems: string[];
}

/** Последний запуск навыка — факт из задач, отдельного журнала запусков нет (R-SD-7). */
export interface SkillLastRun {
  taskId: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  blockedReason: string | null;
  resultNote: string | null;
}

export interface SkillDeckItem extends CatalogSkillInput {
  agentStatus: AgentStatus;
  business: string;
  autonomyDefault: Tier;
  /** Навык закреплён за агентом в карточке — только такой запускается. */
  enabled: boolean;
  crons: string[];
  /** Самый строгий тир среди одноимённых навыков; NULL — тира нет ни у кого. */
  tierFloor: Tier | null;
  /** Сколько агентов несут навык с этим именем (себя включая): 1 — уникальный. */
  duplicates: number;
  lastRun: SkillLastRun | null;
}

export interface SkillDeck {
  syncedAt: string | null;
  /** Цепочка моделей — глобальная настройка, только показ (R-SD-4). */
  models: { primary: string | null; fallbacks: string[] };
  items: SkillDeckItem[];
}

export interface RunSkillInput {
  input?: string;
  modelEffort?: ModelEffort;
  actor?: string;
}

/** Строка сетки агентов: состояние словами плюс то, из чего оно выведено (R-A2-1). */
export interface AgentStatusRow {
  name: string;
  business: string;
  /** Паспортный статус карточки — это НЕ занятость, показывается отдельно. */
  passportStatus: string;
  state: AgentState;
  reason: string;
  since?: string;
  taskId?: string;
  skill?: string;
  lastRun?: { at: string; outcome: string; skipReason: string | null; reason: string };
  /**
   * Сколько ПОРУЧЕННЫХ задач этого агента ждут в очереди (`todo`, без claim и
   * без затыка) — ревью Ф-1.
   *
   * Задача в `todo` не попадает ни в одно правило состояния: claim'а у неё нет,
   * затыка нет, — и агент с ожидающей задачей выглядел «молчит: последний
   * прогон — выполнено · N ч назад». Под `AGENTS_TASKS_PAUSED=1` она лежит там
   * до снятия паузы (на проде так лежит «Навык parts-audit: запуск из deck» от
   * 05.09), а строка парка «новые порученные задачи никто не возьмёт» спорила
   * с плиткой этого агента — и читатель верит плитке. Числом, а не состоянием:
   * ожидание задачи занятостью не является. Отсутствует, когда очередь пуста.
   */
  queuedAssigned?: number;
}

/** Снимок рантайма агентов глазами сетки: когда отчитался и какие паузы применил. */
export interface AgentsRuntimeView {
  /** Момент последнего снимка расписаний (ISO); `null` — рантайм не отчитывался. */
  reportedAt: string | null;
  /** Возраст снимка в секундах тем же правилом, что доска рутин; `null` — снимка нет. */
  ageSec: number | null;
  /** Снимок старше порога доски: что рантайм применил СЕЙЧАС, неизвестно. */
  stale: boolean;
  /** Паузы, действовавшие у рантайма на момент снимка; `null` — снимка нет. */
  paused: { schedules: boolean; tasks: boolean } | null;
  /** Конфиг и снимок расходятся хотя бы по одному тумблеру: рантайм ещё не подхватил правку. */
  lagging: boolean;
  /**
   * Снимок не ПРОЧИТАЛСЯ (отказ базы), а не «рантайм не отчитывался» (ревью
   * M-2): у первого причина в журнале Core, у второго — в контейнере агентов,
   * и панель обязана различать их словами, а не молчать про «сходится».
   */
  readFailed: boolean;
}

export interface AgentsStatusView {
  tz: typeof TZ;
  now: string;
  paused: { schedules: boolean; tasks: boolean };
  /**
   * Что рантайм агентов ПРИМЕНИЛ на деле — против намерения в `paused`
   * (перепроверка прода, Д-3). Тумблеры выше читаются из конфига в ту же
   * секунду, а слой агентов перечитывает настройки своим тиком и кладёт
   * действующие у себя паузы в снимок расписаний. Без сверки экран показывал
   * тринадцать «молчит» над worker'ом, который ещё не взял ни одной задачи, и
   * «на паузе» над worker'ом, который ещё claim'ит.
   */
  runtime: AgentsRuntimeView;
  agents: AgentStatusRow[];
}

/** Сырая строка «последнего прогона агента»: имена колонок приходят из SQL как есть. */
interface AgentLastRunRaw {
  agent_name: string;
  started_at: Date | string;
  outcome: string;
  skip_reason: string | null;
  reason: string;
}

/** Сырая строка «последнего запуска»: имена колонок приходят из SQL как есть. */
interface LastRunRaw {
  owner_ref: string | null;
  agent_skill: string | null;
  task_id: string;
  status: string;
  created_at: Date | string;
  completed_at: Date | string | null;
  blocked_reason: string | null;
  result_note: string | null;
}

/** Каталог пишется пачками: 40 навыков в одном insert — норма, 1000 — уже риск. */
const CATALOG_INSERT_CHUNK = 100;

/** Заголовок задачи из deck показывает вход, но не превращается в простыню. */
const RUN_TITLE_INPUT_LIMIT = 60;

function isoOf(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Отметка времени из сырого SQL: postgres-js отдаёт `Date`, но чинить строку дешевле, чем упасть. */
function dateOf(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asTier(value: unknown): Tier | null {
  return typeof value === "string" && (AGENT_TIERS as readonly string[]).includes(value)
    ? (value as Tier)
    : null;
}

function asAgentStatus(value: unknown): AgentStatus | null {
  return typeof value === "string" && (AGENT_STATUSES as readonly string[]).includes(value)
    ? (value as AgentStatus)
    : null;
}

export interface AgentScheduleItem {
  cron: string;
  skill: string;
}

export interface WebSourceItem {
  name: string;
  url: string;
}

export interface UpsertAgentInput {
  name: string;
  business?: string;
  status?: string;
  description?: string | null;
  mission?: string | null;
  nonGoals?: string[];
  autonomyDefault?: "T0" | "T1" | "T2" | "T3" | "T4";
  skills?: string[];
  schedule?: AgentScheduleItem[];
  budgetPerDayUsd?: number | null;
  /** Что делать при исчерпании бюджета: pause | downgrade | ask. */
  budgetOnExceeded?: string | null;
  /** Сайты, разрешённые агенту для чтения. */
  webSources?: WebSourceItem[];
  /** Навыки, всегда идущие через согласование (break-glass). */
  breakGlass?: string[];
  /** Публичные Telegram-каналы идей. */
  ideaChannels?: string[];
  /** Страницы знаний в контексте агента: пути внутри apps/agents/shared (R-LS-10). */
  kbPages?: string[];
  /**
   * Хуки паспорта (волна R, R-R-4): { preRun: [{kind,…}], postRun: [{kind}] }.
   * Core их только хранит — состав проверяет рантайм (check:passports), потому
   * что список реализаций хуков живёт вместе с исполнителем, а не в базе.
   */
  hooks?: Record<string, unknown>;
}

/**
 * Настройки агентов — карточка агента в панели (запрос владельца).
 *
 * Почему в базе, а не в файлах: паспорта лежат внутри Docker-образа, и любая
 * правка владельца слетала бы при следующем обновлении. Файлы остаются
 * НАЧАЛЬНЫМ сидом — первый запуск переносит их сюда, дальше источник истины здесь.
 *
 * Удаление — архивация: журнал и согласования ссылаются на агента по имени,
 * и стирание строки оставило бы историю без объяснения, кто её создал.
 */
@Injectable()
export class AgentsService {
  private readonly logger = new Logger(AgentsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    /** Запуск навыка — обычная задача агенту, а не отдельный путь исполнения (R-SD-2). */
    private readonly tasks: TasksService,
    /**
     * Паузы системы для сетки состояний (Р-2): берём ДЕЙСТВУЮЩЕЕ значение
     * тумблера (база > env > дефолт), как доска рутин. Читать строку из
     * `system_config` напрямую нельзя — у `AGENTS_TASKS_PAUSED` дефолт «1», и
     * отсутствие записи означало бы «работаем», хотя задачи выключены.
     */
    private readonly system: SystemService,
    /**
     * Снимок расписаний — ради сверки НАМЕРЕНИЯ (тумблеры в конфиге) с тем,
     * что рантайм агентов применил (`snapshot.payload.paused`, Д-3).
     */
    private readonly runs: RunsService,
  ) {}

  /** Список агентов. По умолчанию без архивных — их не должно быть в работе. */
  list(opts: { includeArchived?: boolean } = {}): Promise<AgentRow[]> {
    return this.db
      .select()
      .from(agent)
      .where(opts.includeArchived ? undefined : isNull(agent.archivedAt))
      .orderBy(asc(agent.name));
  }

  async byName(name: string): Promise<AgentRow> {
    const [row] = await this.db.select().from(agent).where(eq(agent.name, name)).limit(1);
    if (!row) throw new NotFoundException(`Агент "${name}" не найден`);
    return row;
  }

  /** Заведение агента. Имя уникально: по нему агент связан с журналом. */
  async create(input: UpsertAgentInput, actorRef = "owner"): Promise<AgentRow> {
    const [existing] = await this.db
      .select({ id: agent.id })
      .from(agent)
      .where(eq(agent.name, input.name))
      .limit(1);
    if (existing) throw new ConflictException(`Агент с именем "${input.name}" уже есть`);

    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(agent)
        .values({
          name: input.name,
          business: input.business ?? "shared",
          // Новый агент заводится ВЫКЛЮЧЕННЫМ: включать — осознанное действие.
          status: input.status ?? "paused",
          description: input.description ?? null,
          mission: input.mission ?? null,
          nonGoals: input.nonGoals ?? [],
          autonomyDefault: input.autonomyDefault ?? "T1",
          skills: input.skills ?? [],
          schedule: input.schedule ?? [],
          budgetPerDayUsd: input.budgetPerDayUsd?.toString() ?? null,
          budgetOnExceeded: input.budgetOnExceeded ?? null,
          webSources: input.webSources ?? [],
          breakGlass: input.breakGlass ?? [],
          ideaChannels: input.ideaChannels ?? [],
          kbPages: input.kbPages ?? [],
          hooks: input.hooks ?? {},
        })
        .returning();

      await tx.insert(auditLog).values({
        actorKind: actorKindOf(actorRef),
        actorRef,
        action: "agent.create",
        target: created.name,
        after: created,
      });
      return created;
    });
  }

  /** Изменение настроек. В журнал пишем «до» и «после» — видно, что менялось. */
  async update(name: string, patch: Partial<UpsertAgentInput>, actorRef = "owner"): Promise<AgentRow> {
    const before = await this.byName(name);

    const values: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.business !== undefined) values.business = patch.business;
    if (patch.status !== undefined) values.status = patch.status;
    if (patch.description !== undefined) values.description = patch.description;
    if (patch.mission !== undefined) values.mission = patch.mission;
    if (patch.nonGoals !== undefined) values.nonGoals = patch.nonGoals;
    if (patch.autonomyDefault !== undefined) values.autonomyDefault = patch.autonomyDefault;
    if (patch.skills !== undefined) values.skills = patch.skills;
    if (patch.schedule !== undefined) values.schedule = patch.schedule;
    if (patch.budgetPerDayUsd !== undefined) {
      values.budgetPerDayUsd = patch.budgetPerDayUsd === null ? null : String(patch.budgetPerDayUsd);
    }
    if (patch.budgetOnExceeded !== undefined) values.budgetOnExceeded = patch.budgetOnExceeded;
    if (patch.webSources !== undefined) values.webSources = patch.webSources;
    if (patch.breakGlass !== undefined) values.breakGlass = patch.breakGlass;
    if (patch.ideaChannels !== undefined) values.ideaChannels = patch.ideaChannels;
    if (patch.kbPages !== undefined) values.kbPages = patch.kbPages;
    if (patch.hooks !== undefined) values.hooks = patch.hooks;

    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(agent)
        .set(values)
        .where(eq(agent.id, before.id))
        .returning();

      await tx.insert(auditLog).values({
        actorKind: actorKindOf(actorRef),
        actorRef,
        action: "agent.update",
        target: name,
        before,
        after: updated,
      });
      return updated;
    });
  }

  /**
   * Удаление = архивация. Агент уходит из работы, история остаётся целой.
   * Освобождаем имя (переименовываем в name#archived-<время>), чтобы владелец
   * мог завести агента с тем же именем заново, не теряя старую историю.
   */
  async archive(name: string, actorRef = "owner"): Promise<AgentRow> {
    const before = await this.byName(name);
    if (before.archivedAt !== null) return before; // уже в архиве — повтор безопасен

    const stamp = new Date();
    return this.db.transaction(async (tx) => {
      const [archived] = await tx
        .update(agent)
        .set({
          archivedAt: stamp,
          status: "deprecated",
          name: `${before.name}#archived-${stamp.getTime()}`,
          updatedAt: stamp,
        })
        .where(eq(agent.id, before.id))
        .returning();

      await tx.insert(auditLog).values({
        actorKind: actorKindOf(actorRef),
        actorRef,
        action: "agent.archive",
        target: before.name,
        before,
        after: archived,
      });
      return archived;
    });
  }

  /**
   * Перенос паспортов-файлов в базу при первом запуске.
   * Идемпотентно: существующих не трогаем — иначе обновление затирало бы
   * настройки, которые владелец поменял в карточке.
   */
  async seedIfEmpty(passports: UpsertAgentInput[]): Promise<{ seeded: number; skipped: number }> {
    let seeded = 0;
    let skipped = 0;
    for (const p of passports) {
      const [existing] = await this.db
        .select({ id: agent.id })
        .from(agent)
        .where(eq(agent.name, p.name))
        .limit(1);
      if (existing) {
        skipped += 1;
        continue;
      }
      await this.create(p, "system:seed");
      seeded += 1;
    }
    return { seeded, skipped };
  }

  /**
   * Состояние каждого агента словами (R-A2-1, решения Р-1 и Р-2).
   *
   * Четыре чтения и ни одного запроса в цикле: карточки, задачи в работе,
   * последние прогоны и тумблеры пауз. Правило состояния — в чистой функции
   * `computeAgentState`, чтобы «работает ли он сейчас» считалось в одном месте,
   * а не повторялось в панели третьей копией.
   */
  async statuses(options: { now?: Date; excludePersonal?: boolean } = {}): Promise<AgentsStatusView> {
    const now = options.now ?? new Date();
    const [rows, inFlight, lastRuns, config, снимок] = await Promise.all([
      // Архивных здесь нет по построению: `list()` их отсекает. Правило архива
      // в чистой функции — второй пояс на случай другого источника строк.
      this.list(),
      this.agentTasksInFlight(options.excludePersonal === true),
      this.lastRunPerAgent(),
      this.system.effective(),
      // Снимок — второстепенный сигнал: его отказ не должен ронять состояние
      // всей сетки. Но отказ ЧТЕНИЯ — не «снимка нет» (ревью M-2): первый
      // уходит в ответ флагом и в журнал причиной, второй — честное «рантайм
      // не отчитывался».
      this.runs.snapshot().then(
        (value) => ({ ok: true as const, value }),
        (e: unknown) => {
          this.logger.warn(`снимок расписаний не прочитан: ${e instanceof Error ? e.message : String(e)}`);
          return { ok: false as const };
        },
      ),
    ]);
    // `value` — действующее значение тумблера; поле `effective` есть только у
    // источника учёта, у пауз его нет (прецедент — `BoardService.board`).
    //
    // ПРАВИЛО ЧТЕНИЯ — ОБЩЕЕ (`agentWorkPaused` из `@mydon/shared`, C-6): те же
    // тумблеры читают рантайм агентов и доска рутин. Раньше здесь стояло своё
    // сравнение без `trim()`, и `" 0 "` рисовал паузу при работающих агентах.
    // Отказ в сторону паузы (ключа нет / значение не «0») живёт внутри общей
    // функции: у обоих тумблеров дефолт в `config-spec` равен «1».
    const flag = (key: string): boolean => agentWorkPaused(config.find((i) => i.key === key)?.value);
    const paused = { schedules: flag("AGENTS_SCHEDULES_PAUSED"), tasks: flag("AGENTS_TASKS_PAUSED") };

    const agents = rows.map((row): AgentStatusRow => {
      const lastRun = lastRuns.get(row.name) ?? null;
      const очередь = inFlight.queued.get(row.name) ?? 0;
      const verdict = computeAgentState({
        passportStatus: row.status,
        archivedAt: row.archivedAt,
        claimedTasks: inFlight.claimed.get(row.name) ?? [],
        lastRun,
        paused,
        now,
        // Лиза одна на систему: своя константа здесь разошлась бы с предикатом
        // `claimAgentRun`, и экран показывал бы работу там, где задача свободна.
        leaseMs: TasksService.AGENT_RUN_LEASE_MS,
      });
      return {
        name: row.name,
        business: row.business,
        passportStatus: row.status,
        state: verdict.state,
        reason: verdict.reason,
        ...(verdict.since !== undefined ? { since: verdict.since.toISOString() } : {}),
        ...(verdict.taskId !== undefined ? { taskId: verdict.taskId } : {}),
        ...(verdict.skill !== undefined ? { skill: verdict.skill } : {}),
        // Ноль не печатаем: «в очереди 0» — не вопрос владельца (то же правило,
        // что у сводки сетки).
        ...(очередь > 0 ? { queuedAssigned: очередь } : {}),
        ...(lastRun !== null
          ? {
              lastRun: {
                at: lastRun.at.toISOString(),
                outcome: lastRun.outcome,
                skipReason: lastRun.skipReason,
                reason: lastRun.reason,
              },
            }
          : {}),
      };
    });

    return { tz: TZ, now: now.toISOString(), paused, runtime: сверкаСРантаймом(paused, снимок, now), agents };
  }

  /**
   * Задачи агентов, о которых есть что сказать, — ОДНОЙ выборкой на всех.
   *
   * Берём не только `in_progress` (там живёт claim), но и остановленные Core:
   * при блокировке исполнения Core возвращает задачу в `todo` и снимает claim
   * (`tasks.service.ts`, release с `shouldBlock`), поэтому по одному
   * `in_progress` затык агента не был бы виден вовсе. Закрытые задачи
   * отсекаем: снятая блокировка на `done` — история, а не состояние.
   *
   * `excludePersonal` — тот же гейт owner-видимости, что у `GET /tasks`
   * (R-P5-7b): при включённом ужесточении и не-owner запросе личные задачи из
   * состояния уходят. Флаг выключен (дефолт) — выдача не меняется.
   */
  private async agentTasksInFlight(
    excludePersonal: boolean,
  ): Promise<{ claimed: Map<string, ClaimedTaskLite[]>; queued: Map<string, number> }> {
    const rows = await this.db
      .select({
        id: task.id,
        ownerRef: task.ownerRef,
        skill: task.agentSkill,
        source: task.source,
        status: task.status,
        claimedAt: task.agentRunClaimedAt,
        blockedAt: task.agentExecutionBlockedAt,
        blockedReason: task.agentExecutionBlockedReason,
      })
      .from(task)
      .where(
        and(
          eq(task.ownerKind, "agent"),
          notInArray(task.status, ["done", "cancelled"]),
          or(
            eq(task.status, "in_progress"),
            isNotNull(task.agentExecutionBlockedAt),
            // ОЖИДАЮЩИЕ ПОРУЧЕННЫЕ — ТЕМ ЖЕ ЗАПРОСОМ (ревью Ф-1): своя выборка
            // ради одного числа добавила бы третий поход к той же таблице.
            // Предикат очереди — общий с рантаймом (`isAssignedTaskSql`), иначе
            // «в очереди N» считало бы cron-задачи, которых пауза не касается.
            and(eq(task.status, "todo"), isAssignedTaskSql()),
          ),
          // `is distinct from`, а не `<> 'personal'`: `task.domain` бывает NULL,
          // и обычное сравнение выбросило бы задачи без направления совсем.
          ...(excludePersonal ? [sql`${task.domain} is distinct from 'personal'`] : []),
        ),
      );

    const byAgent = new Map<string, ClaimedTaskLite[]>();
    const queued = new Map<string, number>();
    for (const row of rows) {
      if (row.ownerRef === null) continue; // задача агента без исполнителя — не его состояние
      // Ждёт в очереди: `todo` без claim и без затыка. Затык Core тоже
      // возвращает задачу в `todo` (`tasks.service.ts`, release с
      // `shouldBlock`), поэтому одного статуса мало — различает отметка.
      if (row.status === "todo" && row.claimedAt === null && row.blockedAt === null) {
        queued.set(row.ownerRef, (queued.get(row.ownerRef) ?? 0) + 1);
        continue;
      }
      const list = byAgent.get(row.ownerRef) ?? [];
      list.push({
        id: row.id,
        skill: row.skill,
        // Кто подхватит оборванную задачу — очередь расписаний или worker
        // порученных: то же различие, что у `isAssignedTaskSql()` (M-1).
        scheduled: row.source === AGENT_SCHEDULE_SOURCE,
        claimedAt: row.claimedAt,
        blockedAt: row.blockedAt,
        blockedReason: row.blockedReason,
      });
      byAgent.set(row.ownerRef, list);
    }
    return { claimed: byAgent, queued };
  }

  /**
   * Последний прогон КАЖДОГО агента — одной выборкой (`distinct on`, как
   * `lastRunsBySkill` выше и `RunsService.lastPerJob`). Здесь именно на агента,
   * а не на пару агент+навык: карточке нужен один ответ «что было в прошлый раз».
   */
  private async lastRunPerAgent(): Promise<Map<string, LastRunLite>> {
    const raw = (await this.db.execute(sql`
      select distinct on (${agentRun.agentName})
        ${agentRun.agentName} as agent_name,
        ${agentRun.startedAt} as started_at,
        ${agentRun.outcome} as outcome,
        ${agentRun.skipReason} as skip_reason,
        ${agentRun.reason} as reason
      from ${agentRun}
      order by ${agentRun.agentName}, ${agentRun.startedAt} desc
    `)) as unknown as AgentLastRunRaw[];

    const byAgent = new Map<string, LastRunLite>();
    for (const row of raw) {
      byAgent.set(row.agent_name, {
        at: dateOf(row.started_at),
        outcome: row.outcome,
        skipReason: row.skip_reason,
        reason: row.reason,
      });
    }
    return byAgent;
  }

  /** Агенты, готовые к работе: включённые и не в архиве. */
  active(): Promise<AgentRow[]> {
    return this.db
      .select()
      .from(agent)
      .where(and(eq(agent.status, "active"), isNull(agent.archivedAt)))
      .orderBy(asc(agent.name));
  }

  /**
   * Полная перезапись каталога навыков (R-SD-1).
   *
   * Источник истины о навыке — его `.md` внутри образа агентов; база лишь
   * зеркало. Поэтому не upsert, а «стереть всё → записать всё» одной
   * транзакцией: удалённый из файлов навык обязан исчезнуть из панели, иначе
   * владелец жал бы «Запустить» у навыка, которого больше нет.
   */
  async syncSkillCatalog(
    items: CatalogSkillInput[],
    actorRef = "agents",
  ): Promise<{ count: number; syncedAt: string }> {
    // Дубль пары (агент, навык) упёрся бы в первичный ключ и вернулся агентам
    // безымянной 400-кой из драйвера. Называем виновника сами: каталог собирают
    // из файлов, и «какой именно навык задвоился» — единственное, что помогает.
    const seen = new Set<string>();
    for (const item of items) {
      const key = `${item.agent}/${item.skill}`;
      if (seen.has(key)) throw new BadRequestException(`Дубль в каталоге: ${key}`);
      seen.add(key);
    }

    const syncedAt = new Date();
    const values = items.map((item) => ({
      agentName: item.agent,
      skill: item.skill,
      description: item.description,
      executor: item.executor,
      tier: item.tier ?? null,
      triggers: item.triggers,
      allowedTools: item.allowedTools,
      modelEffort: item.modelEffort ?? null,
      maxTokens: item.maxTokens ?? null,
      hasCode: item.hasCode,
      problems: item.problems,
      syncedAt,
    }));

    return this.db.transaction(async (tx) => {
      await tx.delete(agentSkillCatalog);
      for (let from = 0; from < values.length; from += CATALOG_INSERT_CHUNK) {
        await tx.insert(agentSkillCatalog).values(values.slice(from, from + CATALOG_INSERT_CHUNK));
      }
      await tx.insert(auditLog).values({
        actorKind: "agent",
        actorRef,
        action: "agent.skill_catalog.synced",
        target: "agent_skill_catalog",
        after: { count: values.length, syncedAt: syncedAt.toISOString() },
      });
      return { count: values.length, syncedAt: syncedAt.toISOString() };
    });
  }

  /**
   * Витрина навыков для панели: каталог из файлов + карточка агента из базы.
   *
   * LEFT JOIN, а не INNER: агент может быть в файлах и ещё не в базе — такой
   * показывается как `draft` и не запускается, вместо того чтобы молча
   * пропасть из списка.
   *
   * `filter.agent` сужает ТОЛЬКО показ: отбор идёт по собранной деке, а не в
   * запросе. `duplicates` и `tierFloor` считаются по одноимённым навыкам ВСЕХ
   * агентов — отфильтруй в SQL, и сосед с T3 исчез бы из подсчёта, а навык
   * показался бы как T1, то есть «можно без согласования». Тир нельзя
   * понижать фильтром показа.
   */
  async skillDeck(filter: { agent?: string } = {}): Promise<SkillDeck> {
    const rows = await this.db
      .select({
        agentName: agentSkillCatalog.agentName,
        skill: agentSkillCatalog.skill,
        description: agentSkillCatalog.description,
        executor: agentSkillCatalog.executor,
        tier: agentSkillCatalog.tier,
        triggers: agentSkillCatalog.triggers,
        allowedTools: agentSkillCatalog.allowedTools,
        modelEffort: agentSkillCatalog.modelEffort,
        maxTokens: agentSkillCatalog.maxTokens,
        hasCode: agentSkillCatalog.hasCode,
        problems: agentSkillCatalog.problems,
        syncedAt: agentSkillCatalog.syncedAt,
        agentStatus: agent.status,
        agentArchivedAt: agent.archivedAt,
        business: agent.business,
        autonomyDefault: agent.autonomyDefault,
        agentSkills: agent.skills,
        schedule: agent.schedule,
      })
      .from(agentSkillCatalog)
      // Архивных НЕ отсекаем в JOIN: без карточки такой агент выглядел бы как
      // «ещё не заведён» (draft), хотя его убрали из работы осознанно. Ниже он
      // отдаётся как deprecated и не запускается.
      .leftJoin(agent, eq(agent.name, agentSkillCatalog.agentName))
      .orderBy(asc(agentSkillCatalog.agentName), asc(agentSkillCatalog.skill));

    const [lastRuns, primaryRaw, fallbackRaw] = await Promise.all([
      this.lastRunsBySkill(),
      settingValue(this.db, "LLM_MODEL"),
      settingValue(this.db, "LLM_FALLBACK_MODELS"),
    ]);

    // Одноимённые навыки у разных агентов: порог берём по самому строгому —
    // иначе слабый агент выполнил бы без согласования то, что у соседа T3.
    const sameName = new Map<string, { count: number; tierFloor: Tier | null }>();
    for (const row of rows) {
      const seen = sameName.get(row.skill) ?? { count: 0, tierFloor: null };
      const tier = asTier(row.tier);
      sameName.set(row.skill, {
        count: seen.count + 1,
        tierFloor:
          tier === null
            ? seen.tierFloor
            : seen.tierFloor === null || AGENT_TIERS.indexOf(tier) > AGENT_TIERS.indexOf(seen.tierFloor)
              ? tier
              : seen.tierFloor,
      });
    }

    // Когда каталог переписан: агенты ставят одно время всем строкам, но
    // берём максимум — так значение не соврёт, даже если синк шёл частями.
    const syncedAt = rows.reduce<Date | null>(
      (latest, row) => (latest === null || row.syncedAt > latest ? row.syncedAt : latest),
      null,
    );

    const items: SkillDeckItem[] = rows.map((row) => {
      const tier = asTier(row.tier);
      // Известное ограничение: archive() переименовывает строку агента в
      // «<имя>#archived-<ts>», поэтому джойн deck по имени её не находит и такой
      // навык показывается как draft («карточки нет»). Ветка ниже срабатывает
      // только при мягкой архивации (archived_at проставлен без переименования) —
      // это осознанно, а не баг.
      const archived = Boolean(row.agentArchivedAt);
      const status = archived ? "deprecated" : asAgentStatus(row.agentStatus);
      const skills = archived ? [] : stringList(row.agentSkills);
      const scheduled = (Array.isArray(row.schedule) ? row.schedule : [])
        .filter(
          (item): item is { cron: string; skill: string } =>
            item !== null &&
            typeof item === "object" &&
            !Array.isArray(item) &&
            (item as Record<string, unknown>).skill === row.skill &&
            typeof (item as Record<string, unknown>).cron === "string",
        )
        .map((item) => item.cron);
      // Убранный из работы агент по расписанию не ходит: строки могли остаться в
      // карточке, но показать их значило бы пообещать запуск, которого не будет.
      const crons = archived ? [] : scheduled;
      const duplicates = sameName.get(row.skill)!;
      return {
        agent: row.agentName,
        skill: row.skill,
        description: row.description,
        // Колонка — свободный текст (каталог без FK и без enum); значение уже
        // проверено на записи, здесь просто не пускаем мусор в тип панели.
        executor: row.executor === "llm" ? "llm" : "code",
        ...(tier !== null ? { tier } : {}),
        triggers: stringList(row.triggers),
        allowedTools: stringList(row.allowedTools),
        ...(row.modelEffort !== null ? { modelEffort: row.modelEffort } : {}),
        ...(row.maxTokens !== null ? { maxTokens: row.maxTokens } : {}),
        hasCode: row.hasCode,
        problems: stringList(row.problems),
        // Карточки нет — агент ещё не заведён: показываем как черновик и не
        // приписываем ему автономии, которой никто не давал. Архивный —
        // deprecated с пустыми навыками: запускать нечего.
        agentStatus: status ?? "draft",
        business: row.business ?? "shared",
        autonomyDefault: asTier(row.autonomyDefault) ?? "T0",
        enabled: skills.includes(row.skill),
        crons,
        tierFloor: duplicates.tierFloor,
        duplicates: duplicates.count,
        lastRun: lastRuns.get(`${row.agentName}\u0000${row.skill}`) ?? null,
      };
    });

    const primary = primaryRaw.trim();
    return {
      syncedAt: syncedAt === null ? null : syncedAt.toISOString(),
      models: {
        primary: primary.length > 0 ? primary : null,
        fallbacks: fallbackRaw
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      },
      items: filter.agent ? items.filter((item) => item.agent === filter.agent) : items,
    };
  }

  /**
   * Последняя задача каждой пары «агент + навык».
   *
   * `distinct on` вместо группировки с подзапросом: индекс
   * `task_agent_skill_idx` (owner_ref, agent_skill, created_at desc) отдаёт
   * первую строку каждой группы без сортировки всей таблицы задач.
   */
  private async lastRunsBySkill(): Promise<Map<string, SkillLastRun>> {
    const raw = (await this.db.execute(sql`
      select distinct on (${task.ownerRef}, ${task.agentSkill})
        ${task.ownerRef} as owner_ref,
        ${task.agentSkill} as agent_skill,
        ${task.id} as task_id,
        ${task.status} as status,
        ${task.createdAt} as created_at,
        ${task.completedAt} as completed_at,
        ${task.agentExecutionBlockedReason} as blocked_reason,
        ${task.resultNote} as result_note
      from ${task}
      where ${task.ownerKind} = 'agent' and ${task.agentSkill} is not null
      order by ${task.ownerRef}, ${task.agentSkill}, ${task.createdAt} desc
    `)) as unknown as LastRunRaw[];

    const byKey = new Map<string, SkillLastRun>();
    for (const row of raw) {
      if (row.owner_ref === null || row.agent_skill === null) continue;
      byKey.set(`${row.owner_ref}\u0000${row.agent_skill}`, {
        taskId: row.task_id,
        status: row.status,
        createdAt: isoOf(row.created_at)!,
        completedAt: isoOf(row.completed_at),
        blockedReason: row.blocked_reason,
        resultNote: row.result_note,
      });
    }
    return byKey;
  }

  /**
   * Запуск навыка из панели (R-SD-2): создаём обычную задачу агенту.
   *
   * Ни тиры, ни бюджеты, ни break-glass здесь не обходятся — дальше тот же
   * путь «task-worker → runner → policy → approval». Пауза агента уважается
   * сразу (R-SD-6): выключенный агент не должен получать работу из панели,
   * даже если worker всё равно её не возьмёт.
   */
  async runSkill(name: string, skill: string, input: RunSkillInput): Promise<{ taskId: string }> {
    const [catalogRow] = await this.db
      .select()
      .from(agentSkillCatalog)
      .where(and(eq(agentSkillCatalog.agentName, name), eq(agentSkillCatalog.skill, skill)))
      .limit(1);
    if (!catalogRow) {
      throw new NotFoundException(
        `Навык "${skill}" не найден в каталоге агента "${name}" — перезапусти агентов, они перепишут каталог`,
      );
    }
    // Файл навыка обещает код, а кода в реестре агентов нет: запускать нечего.
    // Раньше задача создавалась, worker не находил реализации и УГАДЫВАЛ навык
    // по заголовку — владелец получал результат другого навыка под нажатым
    // именем. Отказ здесь дешевле и честнее (решение Р-6).
    if (catalogRow.executor === "code" && catalogRow.hasCode === false) {
      throw new ConflictException(`Навык "${skill}" ещё не реализован — запуск невозможен`);
    }

    const card = await this.byName(name);
    if (card.status !== "active" || card.archivedAt !== null) {
      throw new ConflictException(`Агент "${name}" выключен — включи его в карточке`);
    }
    if (!stringList(card.skills).includes(skill)) {
      throw new ConflictException(`Навык "${skill}" не закреплён за агентом "${name}"`);
    }

    const actor = (input.actor ?? "").trim() || "owner";
    const text = (input.input ?? "").trim();
    // Заголовок — одна строка в списке задач: переносы и двойные пробелы из
    // textarea схлопываем, а описание сохраняет вход как есть.
    const head = text.replace(/\s+/g, " ").trim().slice(0, RUN_TITLE_INPUT_LIMIT);
    const title =
      head.length > 0 ? `Навык ${skill}: ${head}` : `Навык ${skill}: запуск из deck`;

    const created = await this.tasks.create(
      {
        title,
        ...(text.length > 0 ? { description: text } : {}),
        ownerKind: "agent",
        ownerRef: name,
        source: SKILLS_DECK_SOURCE,
        agentSkill: skill,
        ...(input.modelEffort ? { runOptions: { modelEffort: input.modelEffort } } : {}),
        createdBy: actor,
      },
      actor,
    );

    // Отдельной записью после создания: задача уже поставлена, и падение
    // журнала не должно её отменять. Само создание задачи свой след
    // (`task.create`) уже оставило той же транзакцией.
    await this.db.insert(auditLog).values({
      actorKind: actorKindOf(actor),
      actorRef: actor,
      action: "agent.skill.run",
      target: `${name}/${skill}`,
      after: {
        taskId: created.id,
        skill,
        ...(input.modelEffort ? { modelEffort: input.modelEffort } : {}),
      },
    });
    return { taskId: created.id };
  }
}

/**
 * Намерение против факта: тумблеры конфига против пауз в снимке рантайма (Д-3).
 *
 * Свежесть снимка — правилом доски рутин (`snapshotFreshness`): протухший
 * снимок означает не «рантайм отстаёт на один тик», а «что он применил
 * сейчас, неизвестно», и панель обязана сказать это другими словами.
 * `lagging` считается и по протухшему снимку — последнее, что известно о
 * рантайме, всё равно расходится с конфигом; `stale` рядом уточняет, чему
 * верить.
 */
function сверкаСРантаймом(
  paused: { schedules: boolean; tasks: boolean },
  чтение: { ok: true; value: Awaited<ReturnType<RunsService["snapshot"]>> } | { ok: false },
  now: Date,
): AgentsRuntimeView {
  const нет = { reportedAt: null, ageSec: null, stale: false, paused: null, lagging: false };
  if (!чтение.ok) return { ...нет, readFailed: true };
  const снимок = чтение.value;
  if (снимок === null) return { ...нет, readFailed: false };
  const свежесть = snapshotFreshness(снимок.updatedAt, now);
  const применено = { schedules: снимок.payload.paused.schedules, tasks: снимок.payload.paused.tasks };
  return {
    reportedAt: снимок.updatedAt.toISOString(),
    ageSec: свежесть.ageSec,
    stale: свежесть.stale,
    paused: применено,
    lagging: применено.schedules !== paused.schedules || применено.tasks !== paused.tasks,
    readFailed: false,
  };
}
