import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { agent, agentSkillCatalog, auditLog, task } from "@mydon/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { settingValue } from "../system/settings";
import { TasksService, type ModelEffort } from "../tasks/tasks.service";

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
  constructor(
    @Inject(DB) private readonly db: Db,
    /** Запуск навыка — обычная задача агенту, а не отдельный путь исполнения (R-SD-2). */
    private readonly tasks: TasksService,
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
        })
        .returning();

      await tx.insert(auditLog).values({
        actorKind: "human",
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

    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(agent)
        .set(values)
        .where(eq(agent.id, before.id))
        .returning();

      await tx.insert(auditLog).values({
        actorKind: "human",
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
        actorKind: "human",
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
   */
  async skillDeck(): Promise<SkillDeck> {
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
        business: agent.business,
        autonomyDefault: agent.autonomyDefault,
        agentSkills: agent.skills,
        schedule: agent.schedule,
      })
      .from(agentSkillCatalog)
      .leftJoin(
        agent,
        and(eq(agent.name, agentSkillCatalog.agentName), isNull(agent.archivedAt)),
      )
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
      const status = asAgentStatus(row.agentStatus);
      const skills = stringList(row.agentSkills);
      const crons = (Array.isArray(row.schedule) ? row.schedule : [])
        .filter(
          (item): item is { cron: string; skill: string } =>
            item !== null &&
            typeof item === "object" &&
            !Array.isArray(item) &&
            (item as Record<string, unknown>).skill === row.skill &&
            typeof (item as Record<string, unknown>).cron === "string",
        )
        .map((item) => item.cron);
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
        // приписываем ему автономии, которой никто не давал.
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
      items,
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

    const card = await this.byName(name);
    if (card.status !== "active" || card.archivedAt !== null) {
      throw new ConflictException(`Агент "${name}" выключен — включи его в карточке`);
    }
    if (!stringList(card.skills).includes(skill)) {
      throw new ConflictException(`Навык "${skill}" не закреплён за агентом "${name}"`);
    }

    const actor = (input.actor ?? "").trim() || "owner";
    const text = (input.input ?? "").trim();
    const title =
      text.length > 0
        ? `Навык ${skill}: ${text.slice(0, RUN_TITLE_INPUT_LIMIT)}`
        : `Навык ${skill}: запуск из deck`;

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
      actorKind: "human",
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
