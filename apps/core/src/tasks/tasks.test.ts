import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  agent,
  agentTaskLlmJob,
  approval,
  auditLog,
  event,
  outboxDelivery,
  task,
  taskAgentExecution,
  TASK_SOURCE_DAY_PREDICATE,
  taskComment,
} from "@mydon/db";
import {
  AGENT_ROUTE_UNAVAILABLE_BACKOFF_MS,
  durableTaskInputHash,
  isAssignedTaskSql,
  TasksService,
} from "./tasks.service";
import { AGENT_SCHEDULE_SOURCE } from "./agent-schedule";
import { PARITY_ISSUE_SOURCE } from "../ourvend/parity-issue-identity";
import { VENDING_LOW_STOCK_ISSUE_SOURCE } from "../vending/low-stock-issue-identity";

type Row = Record<string, unknown>;
const MANAGED_OPERATIONAL_SOURCES = [PARITY_ISSUE_SOURCE, VENDING_LOW_STOCK_ISSUE_SOURCE] as const;

interface StubOpts {
  existing?: Row;
  updateResult?: Row;
  selectResult?: Row[];
  /** true — уникальный индекс отсёк вставку: задача на этот день уже есть. */
  insertConflict?: boolean;
  /** Куда складывать вставленные строки — чтобы проверить журнал аудита. */
  inserted?: Row[];
  /**
   * Очередь ответов select по порядку вызовов — для сценариев с несколькими
   * выборками подряд (хук ТО: план → «сегодня уже отмечено?»). Не задана —
   * работает прежний одиночный selectResult/existing.
   */
  selects?: Row[][];
  /** Куда складывать аргумент `onConflictDoNothing` — иначе фикс регрессирует так же незаметно. */
  conflicts?: { target?: unknown; where?: unknown }[];
  /** Патч и CAS-предикат UPDATE — для проверки durable claim. */
  updates?: { patch: Row; condition: unknown }[];
  /** Captured SELECT predicates for SQL-level assertions. */
  selectConditions?: unknown[];
}

/**
 * Заглушка БД. Поддерживает ровно те цепочки Drizzle, которыми пользуется
 * сервис: select().from().where()[.limit()], update().set().where().returning(),
 * insert().values()[.onConflictDoNothing()].returning() и голый await у вставки.
 */
function stubDb(opts: StubOpts) {
  const queue = opts.selects ? [...opts.selects] : null;
  const rowsOf = () =>
    queue ? (queue.shift() ?? []) : (opts.selectResult ?? (opts.existing ? [opts.existing] : []));

  // where() и awaitable, и с .limit() — сервис использует оба варианта.
  // Ответ мемоизируется на цепочку: и await, и .limit() видят ОДИН элемент
  // очереди, иначе каждая цепочка съедала бы два.
  const whereChain = (condition?: unknown) => {
    if (condition !== undefined) opts.selectConditions?.push(condition);
    let memo: Row[] | null = null;
    const result = async () => (memo ??= rowsOf());
    return Object.assign(result(), { limit: result, for: result });
  };

  const insert = () => ({
    values: (v: unknown) => {
      const row = { id: "t1", ...(v as Row) };
      opts.inserted?.push(row);
      const returning = async () => (opts.insertConflict ? [] : [row]);
      return {
        onConflictDoNothing: (cfg?: { target?: unknown; where?: unknown }) => {
          opts.conflicts?.push({ target: cfg?.target, where: cfg?.where });
          return { returning };
        },
        returning,
        // `await db.insert(x).values(y)` без returning — запись в журнал.
        then: (res: (v: unknown) => unknown) => Promise.resolve([row]).then(res),
      };
    },
  });

  const tx = {
    select: () => ({ from: () => ({ where: whereChain }) }),
    update: () => ({
      set: (patch: Row) => ({
        where: (condition: unknown) => {
          opts.updates?.push({ patch, condition });
          return { returning: async () => (opts.updateResult ? [opts.updateResult] : []) };
        },
      }),
    }),
    insert,
  };
  return {
    select: tx.select,
    insert,
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
  } as never;
}

/**
 * MaintenanceService нужен сервису задач только ради хука «закрыл задачу ТО».
 * В этих тестах source задач не maint:* — хук до createLog не доходит, а если
 * дойдёт (регресс), заглушка уронит тест громко, а не молча съест вызов.
 */
const stubMaintenance = {
  createLog: async () => {
    throw new Error("createLog вызван вне сценария ТО — регресс хука");
  },
} as never;

const makeTasks = (db: never, llmLedger?: never) =>
  new TasksService(db, stubMaintenance, llmLedger);

/** Stateful unique-index fixture for durable cron occurrence materialization. */
function agentScheduleDb(overrides: Partial<Row> = {}) {
  const configuredAgent: Row = {
    id: "agent-1",
    name: "coach-agent",
    status: "active",
    archivedAt: null,
    skills: ["coach-review"],
    schedule: [{ skill: "coach-review", cron: "0 10 * * 1" }],
    ...overrides,
  };
  let storedTask: Row | undefined;
  const audits: Row[] = [];
  const tx = {
    select: () => ({
      from: (tableRef: unknown) => ({
        where: () => ({
          limit: async () =>
            tableRef === agent ? [configuredAgent] : storedTask === undefined ? [] : [storedTask],
        }),
      }),
    }),
    insert: (tableRef: unknown) => ({
      values: (value: Row) => {
        if (tableRef === task) {
          const returning = async () => {
            if (storedTask !== undefined) return [];
            storedTask = { id: "scheduled-task-1", ...value };
            return [storedTask];
          };
          return {
            onConflictDoNothing: () => ({ returning }),
          };
        }
        audits.push(value);
        return {
          then: (resolve: (rows: Row[]) => unknown) => Promise.resolve([value]).then(resolve),
        };
      },
    }),
  };
  return {
    db: {
      transaction: async <T>(callback: (value: typeof tx) => Promise<T>): Promise<T> =>
        callback(tx),
    } as never,
    audits,
    get task(): Row | undefined {
      return storedTask;
    },
    mutateTask(patch: Row): void {
      if (storedTask === undefined) throw new Error("scheduled task was not created");
      Object.assign(storedTask, patch);
    },
  };
}

interface AgentRunDbState {
  task: Row;
  execution?: Row;
  jobs: Row[];
  approvals: Row[];
  events: Row[];
  deliveries: Row[];
  audits: Row[];
  comments: Row[];
  actionCount?: number;
  advisoryLocks: unknown[];
  lockOrder: string[];
}

/** Минимальная stateful БД для checkpoint/commit: таблицы различаются по identity. */
function agentRunDb(state: AgentRunDbState) {
  let sequence = 0;
  const nextId = (prefix: string) => `${prefix}-${++sequence}`;
  const resultChain = (rows: Row[], lockName?: string) => {
    const result = async () => rows;
    const forUpdate = async () => {
      if (lockName) state.lockOrder.push(lockName);
      return rows;
    };
    return Object.assign(result(), { limit: result, for: forUpdate });
  };
  const rowsFor = (tableRef: unknown): Row[] => {
    if (tableRef === task) return [state.task];
    if (tableRef === taskAgentExecution) return state.execution ? [state.execution] : [];
    if (tableRef === agentTaskLlmJob) return state.jobs;
    if (tableRef === event) {
      return [
        {
          count:
            state.actionCount ?? state.events.filter((row) => row.type === "agent.action").length,
        },
      ];
    }
    return [];
  };
  const tx = {
    select: (_selection?: unknown) => ({
      from: (tableRef: unknown) => ({
        where: () =>
          resultChain(
            rowsFor(tableRef),
            tableRef === task
              ? "task"
              : tableRef === taskAgentExecution
                ? "execution"
                : tableRef === agentTaskLlmJob
                  ? "jobs"
                  : undefined,
          ),
      }),
    }),
    update: (tableRef: unknown) => ({
      set: (patch: Row) => ({
        where: () => ({
          returning: async () => {
            if (tableRef === task) {
              Object.assign(state.task, patch);
              return [{ ...state.task }];
            }
            if (tableRef === taskAgentExecution && state.execution) {
              Object.assign(state.execution, patch);
              return [{ ...state.execution }];
            }
            if (tableRef === agentTaskLlmJob && state.jobs[0]) {
              Object.assign(state.jobs[0], patch);
              return [{ ...state.jobs[0] }];
            }
            return [];
          },
          then: (resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) => {
            const apply = async () => {
              if (tableRef === task) {
                Object.assign(state.task, patch);
                return [{ ...state.task }];
              }
              if (tableRef === taskAgentExecution && state.execution) {
                Object.assign(state.execution, patch);
                return [{ ...state.execution }];
              }
              if (tableRef === agentTaskLlmJob && state.jobs[0]) {
                Object.assign(state.jobs[0], patch);
                return [{ ...state.jobs[0] }];
              }
              return [];
            };
            return apply().then(resolve, reject);
          },
        }),
      }),
    }),
    insert: (tableRef: unknown) => ({
      values: (input: Row | Row[]) => {
        const values = Array.isArray(input) ? input : [input];
        const created = values.map((value) => {
          if (tableRef === taskAgentExecution) {
            const row = {
              id: nextId("execution"),
              status: "ready",
              outcomePayload: null,
              outcomeHash: null,
              approvalId: null,
              committedAt: null,
              abandonedAt: null,
              abandonReason: null,
              createdAt: new Date("2026-08-29T10:16:00.000Z"),
              updatedAt: new Date("2026-08-29T10:16:00.000Z"),
              ...value,
            };
            state.execution = row;
            return row;
          }
          if (tableRef === approval) {
            const row = { id: nextId("approval"), decision: "pending", ...value };
            state.approvals.push(row);
            return row;
          }
          if (tableRef === event) {
            const row = { id: nextId("event"), ...value };
            state.events.push(row);
            return row;
          }
          if (tableRef === outboxDelivery) {
            const row = { id: nextId("delivery"), ...value };
            state.deliveries.push(row);
            return row;
          }
          if (tableRef === auditLog) {
            const row = { id: nextId("audit"), ...value };
            state.audits.push(row);
            return row;
          }
          if (tableRef === taskComment) {
            const row = { id: nextId("comment"), ...value };
            state.comments.push(row);
            return row;
          }
          return { id: nextId("row"), ...value };
        });
        const returning = async () => created;
        return {
          returning,
          then: (resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
            returning().then(resolve, reject),
        };
      },
    }),
    execute: async (query: unknown) => {
      state.advisoryLocks.push(query);
      return [];
    },
  };
  return {
    transaction: async <T>(callback: (value: typeof tx) => Promise<T>): Promise<T> => callback(tx),
  } as never;
}

const AGENT_TASK_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_RUN_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ATTEMPT_ID = "44444444-4444-4444-8444-444444444444";
const AGENT_NOW = new Date("2026-08-29T10:15:00.000Z");

function agentRunState(): AgentRunDbState {
  return {
    task: {
      id: AGENT_TASK_ID,
      title: "Проверить дебиторку",
      description: "Показать просроченные платежи",
      ownerKind: "agent",
      ownerRef: "receivables",
      domain: "vendhub",
      entityId: null,
      status: "in_progress",
      agentRunId: AGENT_RUN_ID,
      agentExecutionAttemptId: AGENT_ATTEMPT_ID,
      agentExecutionRetryAt: null,
      agentExecutionBlockedAt: null,
      agentExecutionBlockedReason: null,
      agentRunGeneration: 1,
      agentRunClaimedAt: AGENT_NOW,
      priority: "normal",
      due: null,
      source: null,
      createdBy: "owner",
      resultNote: null,
      quality: null,
      completedAt: null,
    },
    approvals: [],
    jobs: [],
    events: [],
    deliveries: [],
    audits: [],
    comments: [],
    advisoryLocks: [],
    lockOrder: [],
  };
}

describe("Задачи", () => {
  it("создаётся вместе с записью в журнал", async () => {
    const s = makeTasks(stubDb({}));
    const t = await s.create({ title: "Снять показания", ownerKind: "human" });
    assert.equal(t.id, "t1");
  });

  it("повторное «Готово» не ошибка — возвращает ту же задачу", async () => {
    // UPDATE ничего не вернул (статус уже такой), строка существует
    const s = makeTasks(stubDb({ existing: { id: "t1", status: "done" } }));
    const t = await s.setStatus("t1", "done");
    assert.equal(t.status, "done");
  });

  it("сообщает, что задачи нет", async () => {
    const s = makeTasks(stubDb({}));
    await assert.rejects(() => s.setStatus("нет", "done"), /не найдена/);
  });

  it("жизненный цикл managed operational task нельзя подменить ручным статусом", async () => {
    for (const source of MANAGED_OPERATIONAL_SOURCES) {
      const openId = `${source}-open`;
      const open = makeTasks(
        stubDb({
          existing: {
            id: openId,
            source,
            status: "todo",
          },
        }),
      );
      await assert.rejects(
        () => open.setStatus(openId, "done"),
        /автоматически после повторной проверки/,
      );
      await assert.rejects(
        () => open.setStatus(openId, "cancelled"),
        /автоматически после повторной проверки/,
      );

      const resolvedId = `${source}-resolved`;
      const resolved = makeTasks(
        stubDb({
          existing: {
            id: resolvedId,
            source,
            status: "done",
          },
        }),
      );
      await assert.rejects(
        () => resolved.setStatus(resolvedId, "todo"),
        /автоматически после повторной проверки/,
      );
    }
  });

  it("повторяющаяся задача не дублируется в тот же день", async () => {
    // Дубль отсекает БД (частичный уникальный индекс task_source_key), а не
    // предварительный select: два тика монитора в одну секунду проходили
    // проверку оба и создавали две задачи.
    const s = makeTasks(stubDb({ insertConflict: true }));
    const again = await s.ensureForDay({
      title: "Инвентаризация",
      ownerKind: "human",
      source: "recurring:inventory",
      dayKey: "2026-07-28",
    });
    assert.equal(again, null, "иначе владелец получал бы по три одинаковых задачи в день");
  });

  it("в новый день задача заводится заново", async () => {
    const inserted: Row[] = [];
    const s = makeTasks(stubDb({ inserted }));
    const created = await s.ensureForDay({
      title: "Инвентаризация",
      ownerKind: "human",
      source: "recurring:inventory",
      dayKey: "2026-07-29",
    });
    assert.ok(created, "на новый день задача должна появиться");
    assert.match(String(created?.source), /2026-07-29/);
    assert.ok(
      inserted.some((r) => r.action === "task.create"),
      "создание должно оставлять след в журнале аудита",
    );
  });

  it("проигранная гонка не пишет в журнал аудита", async () => {
    const inserted: Row[] = [];
    await makeTasks(stubDb({ insertConflict: true, inserted })).ensureForDay({
      title: "Инвентаризация",
      ownerKind: "human",
      source: "recurring:inventory",
      dayKey: "2026-07-28",
    });
    assert.ok(
      !inserted.some((r) => r.action === "task.create"),
      "иначе журнал показывал бы созданные задачи, которых нет",
    );
  });

  it("объект работы сохраняется вместе с задачей", async () => {
    const inserted: Row[] = [];
    const s = makeTasks(stubDb({ inserted }));
    await s.create({
      title: "Помыть миксер",
      ownerKind: "human",
      entityId: "33333333-3333-4333-8333-333333333333",
    });
    assert.equal(inserted[0]?.entityId, "33333333-3333-4333-8333-333333333333");
  });
});

describe("Durable cron occurrence tasks", () => {
  const occurrence = {
    agentName: "coach-agent",
    skill: "coach-review",
    cron: "0 10 * * 1",
    scheduledAt: new Date("2026-08-31T05:00:00.000Z"),
  };
  const observedAt = new Date("2026-08-31T05:00:30.000Z");

  it("два ensure дают одну задачу, server-derived bounded key и exact replay", async () => {
    const fixture = agentScheduleDb();
    const service = makeTasks(fixture.db);
    const first = await service.ensureAgentSchedule(occurrence, observedAt);
    const replay = await service.ensureAgentSchedule(occurrence, observedAt);

    assert.equal(first.created, true);
    assert.equal(first.replay, false);
    assert.deepEqual(replay, { ...first, created: false, replay: true });
    assert.match(first.clientKey, /^agent-schedule:v1:[0-9a-f]{64}$/);
    assert.ok(first.clientKey.length <= 128);
    assert.equal(fixture.task?.source, AGENT_SCHEDULE_SOURCE);
    assert.equal(fixture.task?.ownerRef, "coach-agent");
    assert.equal((fixture.task?.due as Date).toISOString(), occurrence.scheduledAt.toISOString());
    assert.equal(
      fixture.audits.filter((row) => row.action === "task.agent_schedule.materialized").length,
      1,
      "exact replay must not duplicate the materialization audit",
    );
  });

  it("не принимает тот же ключ после изменения immutable payload", async () => {
    const fixture = agentScheduleDb();
    const service = makeTasks(fixture.db);
    await service.ensureAgentSchedule(occurrence, observedAt);
    fixture.mutateTask({ description: "tampered" });
    await assert.rejects(service.ensureAgentSchedule(occurrence, observedAt), /immutable payload/);
  });

  it("проверяет active agent, owned skill и exact configured cron", async () => {
    await assert.rejects(
      makeTasks(agentScheduleDb({ status: "paused" }).db).ensureAgentSchedule(
        occurrence,
        observedAt,
      ),
      /не активен/,
    );
    await assert.rejects(
      makeTasks(agentScheduleDb({ skills: ["morning-digest"] }).db).ensureAgentSchedule(
        occurrence,
        observedAt,
      ),
      /не закреплён/,
    );
    await assert.rejects(
      makeTasks(agentScheduleDb({ schedule: [] }).db).ensureAgentSchedule(occurrence, observedAt),
      /не активно/,
    );
  });

  it("отбивает off-grid, слишком старый и будущий occurrence", async () => {
    const service = makeTasks(agentScheduleDb().db);
    await assert.rejects(
      service.ensureAgentSchedule(
        { ...occurrence, scheduledAt: new Date("2026-08-31T05:01:00.000Z") },
        observedAt,
      ),
      /не является текущим fire time/,
    );
    await assert.rejects(
      service.ensureAgentSchedule(occurrence, new Date("2026-08-31T05:16:00.001Z")),
      /не является текущим fire time/,
    );
    await assert.rejects(
      service.ensureAgentSchedule(occurrence, new Date("2026-08-31T04:58:59.999Z")),
      /не является текущим fire time/,
    );
  });

  it("generic create не может подделать системную очередь расписаний", async () => {
    await assert.rejects(
      makeTasks(stubDb({})).create({
        title: "Обойти паузу",
        ownerKind: "agent",
        ownerRef: "coach-agent",
        source: AGENT_SCHEDULE_SOURCE,
      }),
      /зарезервирован/,
    );
  });

  it("generic create не может подделать managed operational issue", async () => {
    for (const source of MANAGED_OPERATIONAL_SOURCES) {
      await assert.rejects(
        makeTasks(stubDb({})).create({
          title: "Ложная операционная проблема",
          ownerKind: "human",
          source,
        }),
        /зарезервирован/,
      );
    }
  });

  it("generic create не может занять предсказуемый managed operational clientKey", async () => {
    for (const source of MANAGED_OPERATIONAL_SOURCES) {
      await assert.rejects(
        makeTasks(stubDb({})).create({
          title: "DoS системной задачи",
          ownerKind: "human",
          source: "manual",
          clientKey: `${source}:${"0".repeat(64)}`,
        }),
        /clientKey.*зарезервирован/,
      );
    }
  });

  it("assigned predicate оставляет NULL source, но отсекает system occurrences", () => {
    const { sql: text, params } = new PgDialect().sqlToQuery(isAssignedTaskSql());
    assert.match(text, /"source" is null/);
    assert.match(text, /"source" <> \$1/);
    assert.deepEqual(params, [AGENT_SCHEDULE_SOURCE]);
  });
});

describe("Дедуп задач на день держится ЧАСТИЧНЫМ индексом (R-G-2)", () => {
  it("вставка называет и колонку, и ПРЕДИКАТ индекса — иначе Postgres отвечает 42P10", async () => {
    // Без `where` drizzle печатает `on conflict ("source") do nothing`, и
    // частичный индекс `task_source_key` из такой спецификации не выводится.
    // Прод 26.08: задач от монитора 0 за всё время при 19 попытках в сутки.
    const conflicts: { target?: unknown; where?: unknown }[] = [];
    await makeTasks(stubDb({ conflicts })).ensureForDay({
      title: "Мойка миксера",
      ownerKind: "human",
      source: "maint:pl-1",
      dayKey: "2026-08-26",
    });
    assert.equal(conflicts.length, 1);
    assert.equal(
      conflicts[0]!.target,
      task.source,
      "конфликт объявлен по той же колонке, что индекс",
    );
    assert.equal(
      conflicts[0]!.where,
      TASK_SOURCE_DAY_PREDICATE,
      "предикат — ТО ЖЕ значение, что у индекса в схеме, а не его копия строкой",
    );
  });

  it("предикат рендерится литералом, без единого параметра", () => {
    // `index_predicate` в `ON CONFLICT` сравнивается с предикатом индекса, а
    // не исполняется как фильтр: `$1` вместо литерала снова дал бы 42P10.
    const { sql: текст, params } = new PgDialect().sqlToQuery(TASK_SOURCE_DAY_PREDICATE);
    assert.equal(текст, "source ~ ':[0-9]{4}-[0-9]{2}-[0-9]{2}$'");
    assert.deepEqual(params, [], "параметр в предикате ломает вывод частичного индекса");
  });
});

describe("Durable claim задачи агента", () => {
  const TASK = "11111111-1111-4111-8111-111111111111";
  const OLD_RUN = "22222222-2222-4222-8222-222222222222";
  const NEW_RUN = "33333333-3333-4333-8333-333333333333";
  const EXECUTION = "44444444-4444-4444-8444-444444444444";
  const NOW = new Date("2026-08-29T10:15:00.000Z");

  it("claim делает один атомарный UPDATE, выдаёт UUID и пускает stale lease через 15 минут", async () => {
    const updates: NonNullable<StubOpts["updates"]> = [];
    const inserted: Row[] = [];
    const claimedRow = {
      id: TASK,
      title: "Current claimed title",
      description: "Current claimed brief",
      domain: "globerent",
      ownerKind: "agent",
      ownerRef: "receivables",
      status: "in_progress",
      agentRunId: NEW_RUN,
      agentExecutionAttemptId: EXECUTION,
      agentRunGeneration: 8,
      agentRunClaimedAt: NOW,
    };
    const result = await makeTasks(
      stubDb({ updateResult: claimedRow, updates, inserted }),
    ).claimAgentRun(TASK, "receivables", NOW);

    assert.equal(result?.agentRunGeneration, 8);
    assert.equal(result?.agentExecutionAttemptId, EXECUTION);
    assert.deepEqual(result?.taskInput, {
      title: "Current claimed title",
      description: "Current claimed brief",
      domain: "globerent",
    });
    assert.equal(updates.length, 1, "claim не должен быть select-then-update");
    const patch = updates[0]!.patch;
    assert.equal(patch.status, "in_progress");
    assert.match(
      String(patch.agentRunId),
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    assert.equal(patch.agentRunClaimedAt, NOW);

    const attempt = new PgDialect().sqlToQuery(
      patch.agentExecutionAttemptId as Parameters<PgDialect["sqlToQuery"]>[0],
    );
    assert.match(attempt.sql, /coalesce\(.*agent_execution_attempt_id/);
    assert.ok(
      attempt.params.some(
        (value) =>
          typeof value === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
      ),
      "первая попытка получает UUID, stale takeover сохраняет существующий через coalesce",
    );

    const generation = new PgDialect().sqlToQuery(
      patch.agentRunGeneration as Parameters<PgDialect["sqlToQuery"]>[0],
    );
    assert.match(
      generation.sql,
      /agent_run_generation.*\+/,
      "generation инкрементируется в том же UPDATE",
    );

    const query = new PgDialect().sqlToQuery(
      updates[0]!.condition as Parameters<PgDialect["sqlToQuery"]>[0],
    );
    assert.match(query.sql, /agent_run_id.*is null/);
    assert.match(query.sql, /agent_execution_retry_at.*is null/);
    assert.match(query.sql, /agent_execution_retry_at.*<=/);
    assert.match(query.sql, /agent_execution_blocked_at.*is null/);
    assert.match(query.sql, /agent_run_claimed_at.*<=/);
    assert.match(query.sql, /source.*is null/);
    assert.ok(query.params.includes(AGENT_SCHEDULE_SOURCE));
    const staleCutoff = new Date(NOW.getTime() - 15 * 60_000).toISOString();
    assert.ok(
      query.params.some((value) =>
        value instanceof Date ? value.toISOString() === staleCutoff : value === staleCutoff,
      ),
      "stale cutoff ровно 15 минут",
    );
    assert.ok(inserted.some((row) => row.action === "task.agent_run.claimed"));
  });

  it("scheduled claim требует системный source и уже наступивший due", async () => {
    const updates: NonNullable<StubOpts["updates"]> = [];
    const claimedRow = {
      id: TASK,
      title: "По расписанию: coach-review",
      description: "Системный запуск навыка coach-review",
      domain: null,
      ownerKind: "agent",
      ownerRef: "coach-agent",
      status: "in_progress",
      source: AGENT_SCHEDULE_SOURCE,
      due: NOW,
      agentRunId: NEW_RUN,
      agentExecutionAttemptId: EXECUTION,
      agentRunGeneration: 1,
      agentRunClaimedAt: NOW,
    };

    await makeTasks(stubDb({ updateResult: claimedRow, updates })).claimAgentRun(
      TASK,
      "coach-agent",
      NOW,
      "scheduled",
    );
    const query = new PgDialect().sqlToQuery(
      updates[0]!.condition as Parameters<PgDialect["sqlToQuery"]>[0],
    );
    assert.match(query.sql, /source.*=/);
    assert.match(query.sql, /due.*<=/);
    assert.ok(query.params.includes(AGENT_SCHEDULE_SOURCE));
  });

  it("claim долговечно блокирует malformed stored execution", async () => {
    const updates: NonNullable<StubOpts["updates"]> = [];
    const claimedRow = {
      id: TASK,
      ownerKind: "agent",
      ownerRef: "receivables",
      status: "in_progress",
      agentRunId: NEW_RUN,
      agentExecutionAttemptId: EXECUTION,
      agentRunGeneration: 8,
      agentRunClaimedAt: NOW,
    };
    await assert.rejects(
      () =>
        makeTasks(
          stubDb({
            updateResult: claimedRow,
            updates,
            selects: [
              [
                {
                  id: "execution-1",
                  executionAttemptId: EXECUTION,
                  executionPlan: null,
                },
              ],
            ],
          }),
        ).claimAgentRun(TASK, "receivables", NOW),
      /cannot be resumed safely/,
    );
    assert.equal(updates.length, 2);
    assert.equal(updates[1]?.patch.status, "todo");
    assert.equal(updates[1]?.patch.agentRunId, null);
    assert.equal(updates[1]?.patch.agentExecutionBlockedAt, NOW);
  });

  it("из двух concurrent claim только один получает runId", async () => {
    let available = true;
    const inserted: Row[] = [];
    const tx = {
      update: () => ({
        set: (patch: Row) => ({
          where: () => ({
            returning: async () => {
              if (!available) return [];
              available = false;
              return [
                {
                  id: TASK,
                  ownerKind: "agent",
                  ownerRef: "receivables",
                  status: "in_progress",
                  ...patch,
                  agentRunGeneration: 1,
                },
              ];
            },
          }),
        }),
      }),
      insert: () => ({
        values: async (value: Row) => {
          inserted.push(value);
          return [];
        },
      }),
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [] }),
        }),
      }),
    };
    const db = {
      transaction: async <T>(callback: (value: typeof tx) => Promise<T>): Promise<T> =>
        callback(tx),
    } as never;
    const service = makeTasks(db);
    const claims = await Promise.all([
      service.claimAgentRun(TASK, "receivables", NOW),
      service.claimAgentRun(TASK, "receivables", NOW),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(inserted.filter((row) => row.action === "task.agent_run.claimed").length, 1);
  });

  it("heartbeat продлевает только активный runId", async () => {
    const renewedAt = new Date("2026-08-29T10:20:00.000Z");
    const current: Row = {
      id: TASK,
      ownerKind: "agent",
      ownerRef: "receivables",
      status: "in_progress",
      agentRunId: NEW_RUN,
      agentRunClaimedAt: NOW,
    };
    const db = {
      update: () => ({
        set: (patch: Row) => ({
          where: (condition: unknown) => {
            const query = new PgDialect().sqlToQuery(
              condition as Parameters<PgDialect["sqlToQuery"]>[0],
            );
            const expected = query.params.find((value) => value === OLD_RUN || value === NEW_RUN);
            return {
              returning: async () => {
                if (expected !== current.agentRunId) return [];
                Object.assign(current, patch);
                return [{ id: TASK }];
              },
            };
          },
        }),
      }),
    } as never;
    const service = makeTasks(db);
    assert.equal(await service.heartbeatAgentRun(TASK, "receivables", OLD_RUN, renewedAt), false);
    assert.equal(current.agentRunClaimedAt, NOW);
    assert.equal(await service.heartbeatAgentRun(TASK, "receivables", NEW_RUN, renewedAt), true);
    assert.equal(current.agentRunClaimedAt, renewedAt, "живой длинный run не станет stale");
  });

  it("release сравнивает runId: старый worker не снимает lease новой generation", async () => {
    const current: Row = {
      id: TASK,
      ownerKind: "agent",
      ownerRef: "receivables",
      status: "in_progress",
      agentRunId: NEW_RUN,
      agentExecutionAttemptId: EXECUTION,
      agentRunGeneration: 2,
      agentRunClaimedAt: NOW,
    };
    const inserted: Row[] = [];
    const conditions: unknown[] = [];
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({ for: async () => [{ ...current }] }),
        }),
      }),
      update: () => ({
        set: (patch: Row) => ({
          where: (condition: unknown) => {
            conditions.push(condition);
            const query = new PgDialect().sqlToQuery(
              condition as Parameters<PgDialect["sqlToQuery"]>[0],
            );
            const expectedRunId = query.params.find(
              (value) => value === OLD_RUN || value === NEW_RUN,
            );
            return {
              returning: async () => {
                if (expectedRunId !== current.agentRunId) return [];
                Object.assign(current, patch);
                return [{ ...current }];
              },
            };
          },
        }),
      }),
      insert: () => ({
        values: async (value: Row) => {
          inserted.push(value);
          return [];
        },
      }),
    };
    const db = {
      transaction: async <T>(callback: (value: typeof tx) => Promise<T>): Promise<T> =>
        callback(tx),
    } as never;
    const service = makeTasks(db);

    assert.equal(await service.releaseAgentRun(TASK, "receivables", OLD_RUN, EXECUTION), null);
    assert.equal(current.agentRunId, NEW_RUN, "старый runId не изменил строку");
    const released = await service.releaseAgentRun(TASK, "receivables", NEW_RUN, EXECUTION);
    assert.equal(released?.agentRunId, null);
    assert.equal(released?.status, "todo");
    assert.equal(current.agentRunGeneration, 2, "release не обнуляет generation");
    assert.equal(
      current.agentExecutionAttemptId,
      EXECUTION,
      "automatic release сохраняет денежную попытку против double dispatch",
    );
    assert.equal(inserted.filter((row) => row.action === "task.agent_run.released").length, 1);

    const releaseQuery = new PgDialect().sqlToQuery(
      conditions[0] as Parameters<PgDialect["sqlToQuery"]>[0],
    );
    assert.match(releaseQuery.sql, /agent_run_id/);
    assert.ok(releaseQuery.params.includes(NEW_RUN));
  });

  it("budget denial безопасно ротирует attempt только с новых ташкентских суток", async () => {
    const updates: NonNullable<StubOpts["updates"]> = [];
    const selectConditions: unknown[] = [];
    await makeTasks(
      stubDb({
        selects: [
          [
            {
              id: TASK,
              ownerKind: "agent",
              ownerRef: "receivables",
              status: "in_progress",
              agentRunId: NEW_RUN,
              agentExecutionAttemptId: EXECUTION,
            },
          ],
          [],
          [],
        ],
        updateResult: {
          id: TASK,
          status: "todo",
          agentRunId: null,
          agentExecutionAttemptId: null,
          agentExecutionRetryAt: new Date("2026-08-29T19:00:00.000Z"),
        },
        updates,
        selectConditions,
      }),
    ).releaseAgentRun(TASK, "receivables", NEW_RUN, EXECUTION, "budget_denied", undefined, NOW);

    const patch = updates[0]!.patch;
    assert.equal(patch.agentExecutionAttemptId, null);
    assert.equal(
      (patch.agentExecutionRetryAt as Date).toISOString(),
      "2026-08-29T19:00:00.000Z",
      "полночь 30 августа в Ташкенте = 19:00Z 29 августа",
    );
    const spendProbe = selectConditions
      .map((condition) =>
        new PgDialect().sqlToQuery(condition as Parameters<PgDialect["sqlToQuery"]>[0]),
      )
      .find((query) => query.params.includes("denied"));
    assert.ok(spendProbe);
    assert.ok(spendProbe.params.includes("denied"));
    assert.ok(spendProbe.params.includes("released"));
  });

  it("route unavailable до /start сохраняет attempt и даёт минутный auto-retry", async () => {
    const state = agentRunState();

    const released = await makeTasks(agentRunDb(state)).releaseAgentRun(
      AGENT_TASK_ID,
      "receivables",
      AGENT_RUN_ID,
      AGENT_ATTEMPT_ID,
      "route_unavailable",
      "find-solution:rank is not configured",
      AGENT_NOW,
    );

    assert.equal(released?.status, "todo");
    assert.equal(released?.agentRunId, null);
    assert.equal(released?.agentExecutionAttemptId, AGENT_ATTEMPT_ID);
    assert.equal(released?.agentExecutionBlockedAt, null);
    assert.equal(released?.agentExecutionBlockedReason, null);
    assert.equal(
      (released?.agentExecutionRetryAt as Date).toISOString(),
      new Date(AGENT_NOW.getTime() + AGENT_ROUTE_UNAVAILABLE_BACKOFF_MS).toISOString(),
    );
    assert.equal(state.execution, undefined, "release не создаёт empty execution");
  });

  it("route unavailable после durable /start fail-closed блокирует без rotation", async () => {
    const state = agentRunState();
    state.execution = {
      id: "execution-1",
      taskId: AGENT_TASK_ID,
      executionAttemptId: AGENT_ATTEMPT_ID,
      agentName: "receivables",
      skill: "find-solution",
      status: "active",
      taskInputHash: durableTaskInputHash(state.task as never),
    };
    state.jobs.push({
      id: "job-1",
      status: "succeeded",
      taskAgentExecutionId: "execution-1",
    });

    const released = await makeTasks(agentRunDb(state)).releaseAgentRun(
      AGENT_TASK_ID,
      "receivables",
      AGENT_RUN_ID,
      AGENT_ATTEMPT_ID,
      "route_unavailable",
      "stale worker claimed the route was off",
      AGENT_NOW,
    );

    assert.equal(released?.agentExecutionAttemptId, AGENT_ATTEMPT_ID);
    assert.equal(released?.agentExecutionRetryAt, null);
    assert.equal(released?.agentExecutionBlockedAt, AGENT_NOW);
    assert.equal(
      released?.agentExecutionBlockedReason,
      "route_unavailable: release rejected after durable execution start; owner retry required",
    );
    assert.equal(state.execution.status, "active");
    assert.equal(state.jobs[0]?.status, "succeeded");
  });

  it("budget denial после начатого reserve блокирует, а не ротирует execution", async () => {
    const updates: NonNullable<StubOpts["updates"]> = [];
    await makeTasks(
      stubDb({
        selects: [
          [
            {
              id: TASK,
              ownerKind: "agent",
              ownerRef: "receivables",
              status: "in_progress",
              agentRunId: NEW_RUN,
              agentExecutionAttemptId: EXECUTION,
            },
          ],
          [],
          [{ id: "spend-1" }],
        ],
        updateResult: { id: TASK, status: "todo", agentExecutionAttemptId: EXECUTION },
        updates,
      }),
    ).releaseAgentRun(
      TASK,
      "receivables",
      NEW_RUN,
      EXECUTION,
      "budget_denied",
      "второй reserve отклонён",
      NOW,
    );

    const patch = updates[0]!.patch;
    assert.equal("agentExecutionAttemptId" in patch, false, "начатый execution не вращается");
    assert.equal(patch.agentExecutionBlockedAt, NOW);
    assert.equal(patch.agentExecutionBlockedReason, "второй reserve отклонён");
  });

  it("unsupported атомарно снимает lease и блокирует claim до owner retry", async () => {
    const updates: NonNullable<StubOpts["updates"]> = [];
    await makeTasks(
      stubDb({
        selects: [
          [
            {
              id: TASK,
              ownerKind: "agent",
              ownerRef: "receivables",
              status: "in_progress",
              agentRunId: NEW_RUN,
              agentExecutionAttemptId: EXECUTION,
            },
          ],
          [],
        ],
        updateResult: { id: TASK, status: "todo", agentExecutionAttemptId: EXECUTION },
        updates,
      }),
    ).releaseAgentRun(
      TASK,
      "receivables",
      NEW_RUN,
      EXECUTION,
      "unsupported",
      "нет подходящего навыка",
      NOW,
    );

    const patch = updates[0]!.patch;
    assert.equal(patch.status, "todo");
    assert.equal(patch.agentRunId, null);
    assert.equal(patch.agentRunClaimedAt, null);
    assert.equal(
      "agentExecutionAttemptId" in patch,
      false,
      "attempt очищает только owner-only retry",
    );
    assert.equal(patch.agentExecutionBlockedAt, NOW);
    assert.equal(patch.agentExecutionBlockedReason, "нет подходящего навыка");
  });

  it("lost complete response не блокирует уже terminal job и сохраняет attempt", async () => {
    const state = agentRunState();
    state.execution = {
      id: "execution-1",
      taskId: AGENT_TASK_ID,
      executionAttemptId: AGENT_ATTEMPT_ID,
      agentName: "receivables",
      skill: "watch-receivables",
      status: "active",
      taskInputHash: durableTaskInputHash(state.task as never),
    };
    state.jobs.push({ id: "job-1", status: "succeeded", taskAgentExecutionId: "execution-1" });

    const released = await makeTasks(agentRunDb(state)).releaseAgentRun(
      AGENT_TASK_ID,
      "receivables",
      AGENT_RUN_ID,
      AGENT_ATTEMPT_ID,
      "execution_unknown",
      "оба HTTP-ответа complete потеряны",
      AGENT_NOW,
    );
    assert.equal(released?.agentExecutionAttemptId, AGENT_ATTEMPT_ID);
    assert.equal(released?.agentExecutionBlockedAt, null);
    assert.equal(state.execution.status, "active");
    assert.equal(state.jobs[0]?.status, "succeeded");
  });

  it("workflow change блокирует даже terminal job, owner retry ротирует attempt", async () => {
    const state = agentRunState();
    state.execution = {
      id: "execution-1",
      taskId: AGENT_TASK_ID,
      executionAttemptId: AGENT_ATTEMPT_ID,
      agentName: "receivables",
      skill: "watch-receivables",
      status: "active",
      taskInputHash: durableTaskInputHash(state.task as never),
    };
    state.jobs.push({ id: "job-1", status: "succeeded", taskAgentExecutionId: "execution-1" });

    const released = await makeTasks(agentRunDb(state)).releaseAgentRun(
      AGENT_TASK_ID,
      "receivables",
      AGENT_RUN_ID,
      AGENT_ATTEMPT_ID,
      "workflow_changed",
      "endpoint route changed",
      AGENT_NOW,
    );
    assert.equal(released?.agentExecutionAttemptId, AGENT_ATTEMPT_ID);
    assert.equal(released?.agentExecutionBlockedAt, AGENT_NOW);
    assert.equal(released?.agentExecutionBlockedReason, "workflow_changed: endpoint route changed");
    assert.equal(state.execution.status, "active");

    await makeTasks(agentRunDb(state)).retryBlockedAgentExecution(AGENT_TASK_ID);
    assert.equal(state.execution.status, "abandoned");
    assert.equal(state.task.agentExecutionAttemptId, null);
    assert.equal(state.task.agentExecutionBlockedAt, null);
  });

  it("denial второго durable step сохраняет result первого и attempt до новых суток", async () => {
    const state = agentRunState();
    state.execution = {
      id: "execution-1",
      taskId: AGENT_TASK_ID,
      executionAttemptId: AGENT_ATTEMPT_ID,
      agentName: "receivables",
      skill: "watch-receivables",
      status: "active",
      taskInputHash: durableTaskInputHash(state.task as never),
    };
    state.jobs.push(
      { id: "job-1", status: "succeeded", taskAgentExecutionId: "execution-1" },
      { id: "job-2", status: "waiting_budget", taskAgentExecutionId: "execution-1" },
    );

    const released = await makeTasks(agentRunDb(state)).releaseAgentRun(
      AGENT_TASK_ID,
      "receivables",
      AGENT_RUN_ID,
      AGENT_ATTEMPT_ID,
      "budget_denied",
      undefined,
      AGENT_NOW,
    );
    assert.equal(released?.agentExecutionAttemptId, AGENT_ATTEMPT_ID);
    assert.equal(released?.agentExecutionBlockedAt, null);
    assert.equal(
      (released?.agentExecutionRetryAt as Date).toISOString(),
      "2026-08-29T19:00:00.000Z",
    );
    assert.equal(state.jobs[0]?.status, "succeeded");
  });

  it("owner retry не abandons живой dispatch; после deadline фиксирует unknown", async () => {
    const future = agentRunState();
    future.task.status = "todo";
    future.task.agentRunId = null;
    future.task.agentRunClaimedAt = null;
    future.task.agentExecutionBlockedAt = AGENT_NOW;
    future.execution = {
      id: "execution-1",
      taskId: AGENT_TASK_ID,
      executionAttemptId: AGENT_ATTEMPT_ID,
      agentName: "receivables",
      skill: "watch-receivables",
      status: "active",
      taskInputHash: durableTaskInputHash(future.task as never),
    };
    future.jobs.push({
      id: "job-1",
      status: "dispatching",
      taskAgentExecutionId: "execution-1",
      dispatchDeadlineAt: new Date("2099-01-01T00:00:00.000Z"),
    });
    await assert.rejects(
      () => makeTasks(agentRunDb(future)).retryBlockedAgentExecution(AGENT_TASK_ID),
      /still in flight/,
    );
    assert.equal(future.execution.status, "active");
    assert.equal(future.jobs[0]?.status, "dispatching");

    future.jobs[0]!.dispatchDeadlineAt = new Date("2000-01-01T00:00:00.000Z");
    await makeTasks(agentRunDb(future)).retryBlockedAgentExecution(AGENT_TASK_ID);
    assert.equal(future.jobs[0]?.status, "unknown");
    assert.equal(future.jobs[0]?.requestPayload, null);
    assert.equal(future.execution.status, "abandoned");
    assert.equal(future.task.agentExecutionAttemptId, null);
  });

  it("owner retry снимает block без checkpoint и только тогда разрешает новый attempt", async () => {
    const updates: NonNullable<StubOpts["updates"]> = [];
    const inserted: Row[] = [];
    const updated = await makeTasks(
      stubDb({
        selects: [
          [
            {
              id: TASK,
              ownerKind: "agent",
              status: "todo",
              agentExecutionAttemptId: EXECUTION,
              agentExecutionBlockedAt: NOW,
            },
          ],
          [],
        ],
        updateResult: {
          id: TASK,
          ownerKind: "agent",
          status: "todo",
          agentExecutionAttemptId: null,
          agentExecutionBlockedAt: null,
        },
        updates,
        inserted,
      }),
    ).retryBlockedAgentExecution(TASK);

    assert.equal(updated.agentExecutionAttemptId, null);
    assert.equal(updates[0]!.patch.agentExecutionBlockedAt, null);
    assert.equal(updates.length, 1, "без checkpoint нечего abandon-ить");
    assert.ok(inserted.some((row) => row.action === "task.agent_execution.retry"));
  });

  it("старая generation не может закрыть задачу после stale takeover", async () => {
    const updates: NonNullable<StubOpts["updates"]> = [];
    const service = makeTasks(
      stubDb({
        existing: { id: TASK, status: "in_progress", agentRunId: NEW_RUN },
        updates,
      }),
    );
    await assert.rejects(
      () => service.setStatus(TASK, "done", "agent:receivables", "готово", OLD_RUN),
      /заменён новой generation/,
    );
    assert.equal(updates.length, 0, "stale generation отсекается под task lock до UPDATE");
  });
});

describe("Terminal task cleanup durable LLM jobs", () => {
  function withActiveExecution(state: AgentRunDbState): void {
    state.execution = {
      id: "execution-terminal-cleanup",
      taskId: AGENT_TASK_ID,
      executionAttemptId: AGENT_ATTEMPT_ID,
      agentName: "receivables",
      skill: "watch-receivables",
      status: "active",
      taskInputHash: durableTaskInputHash(state.task as never),
    };
  }

  it("ready reserve releases once, clears payload, and follows task->execution->jobs->ledger", async () => {
    const state = agentRunState();
    withActiveExecution(state);
    state.jobs.push({
      id: "job-ready",
      status: "ready",
      taskAgentExecutionId: state.execution!.id,
      spendId: "spend-ready",
      requestPayload: { messages: [{ role: "user", content: "sensitive" }] },
    });
    const releases: Row[] = [];
    const ledger = {
      releaseInTx: async (_tx: unknown, id: string, dto: Row, options: Row) => {
        state.lockOrder.push("ledger");
        releases.push({ id, dto, options });
        return { status: "released", replay: false };
      },
    } as never;
    const service = makeTasks(agentRunDb(state), ledger);

    await service.setStatus(AGENT_TASK_ID, "done");
    await service.setStatus(AGENT_TASK_ID, "done");

    assert.equal(state.task.status, "done");
    assert.equal(state.jobs[0]?.status, "cancelled");
    assert.equal(state.jobs[0]?.requestPayload, null);
    assert.equal(releases.length, 1, "idempotent repeat не снимает резерв дважды");
    assert.deepEqual(releases[0]?.options, { allowTaskJobSpend: true });
    assert.deepEqual(state.lockOrder, [
      "task",
      "execution",
      "jobs",
      "ledger",
      "task",
      "execution",
      "jobs",
    ]);
    assert.equal(state.audits.filter((row) => row.action === "task.done").length, 1);
  });

  it("waiting_budget cancels and clears payload without touching ledger", async () => {
    const state = agentRunState();
    withActiveExecution(state);
    state.jobs.push({
      id: "job-waiting",
      status: "waiting_budget",
      taskAgentExecutionId: state.execution!.id,
      spendId: null,
      requestPayload: { prompt: "sensitive" },
    });
    const ledger = {
      releaseInTx: async () => {
        throw new Error("waiting_budget must not release ledger spend");
      },
    } as never;

    await makeTasks(agentRunDb(state), ledger).setStatus(AGENT_TASK_ID, "cancelled");

    assert.equal(state.task.status, "cancelled");
    assert.equal(state.jobs[0]?.status, "cancelled");
    assert.equal(state.jobs[0]?.requestPayload, null);
    assert.deepEqual(state.lockOrder, ["task", "execution", "jobs"]);
  });

  it("dispatching evidence remains untouched when task becomes terminal", async () => {
    const state = agentRunState();
    withActiveExecution(state);
    const payload = { prompt: "already sent" };
    state.jobs.push({
      id: "job-dispatching",
      status: "dispatching",
      taskAgentExecutionId: state.execution!.id,
      spendId: "spend-dispatching",
      requestPayload: payload,
    });
    const ledger = {
      releaseInTx: async () => {
        throw new Error("dispatching spend must retain unknown-cost evidence");
      },
    } as never;

    await makeTasks(agentRunDb(state), ledger).setStatus(AGENT_TASK_ID, "done");

    assert.equal(state.task.status, "done");
    assert.equal(state.jobs[0]?.status, "dispatching");
    assert.equal(state.jobs[0]?.requestPayload, payload);
    assert.deepEqual(state.lockOrder, ["task", "execution", "jobs"]);
  });

  it("multiple ready jobs fail closed before release or terminal task mutation", async () => {
    const state = agentRunState();
    withActiveExecution(state);
    state.jobs.push(
      {
        id: "job-ready-1",
        status: "ready",
        taskAgentExecutionId: state.execution!.id,
        spendId: "spend-1",
        requestPayload: { prompt: "one" },
      },
      {
        id: "job-ready-2",
        status: "ready",
        taskAgentExecutionId: state.execution!.id,
        spendId: "spend-2",
        requestPayload: { prompt: "two" },
      },
    );
    let releaseCalls = 0;
    const ledger = {
      releaseInTx: async () => {
        releaseCalls += 1;
        return { status: "released", replay: false };
      },
    } as never;

    await assert.rejects(
      () => makeTasks(agentRunDb(state), ledger).setStatus(AGENT_TASK_ID, "cancelled"),
      /несколько ready LLM jobs/,
    );

    assert.equal(state.task.status, "in_progress");
    assert.deepEqual(
      state.jobs.map((job) => job.status),
      ["ready", "ready"],
    );
    assert.equal(releaseCalls, 0);
    assert.deepEqual(state.lockOrder, ["task", "execution", "jobs"]);
  });
});

describe("Durable agent input snapshot", () => {
  const fence = {
    agentName: "receivables",
    runId: AGENT_RUN_ID,
    executionAttemptId: AGENT_ATTEMPT_ID,
  };
  const plan = { version: 1 as const, steps: [] };

  async function start(service: TasksService, state: AgentRunDbState, runId = AGENT_RUN_ID) {
    return service.startAgentRun(
      AGENT_TASK_ID,
      {
        ...fence,
        runId,
        claimedTaskInputHash: durableTaskInputHash(state.task as never),
        skill: "find-solution",
        workflowVersion: 1,
        plan,
      },
      AGENT_NOW,
    );
  }

  it("creates once and replays the exact canonical public JSON", async () => {
    const state = agentRunState();
    const service = makeTasks(agentRunDb(state));
    await start(service, state);

    const first = await service.ensureAgentRunInputSnapshot(
      AGENT_TASK_ID,
      {
        ...fence,
        kind: "solution-search-v1",
        payload: { coverage: { github: "ok" }, candidates: [{ id: "gh:one", stars: 12 }] },
      },
      AGENT_NOW,
    );
    const replay = await service.ensureAgentRunInputSnapshot(AGENT_TASK_ID, {
      ...fence,
      kind: " solution-search-v1 ",
      payload: { candidates: [{ stars: 12, id: "gh:one" }], coverage: { github: "ok" } },
    });

    assert.equal(first.replay, false);
    assert.equal(replay.replay, true);
    assert.equal(replay.snapshot.hash, first.snapshot.hash);
    assert.equal(state.execution?.inputSnapshotKind, "solution-search-v1");
    assert.deepEqual(state.execution?.inputSnapshotPayload, first.snapshot.payload);
    assert.match(String(state.execution?.inputSnapshotHash), /^[0-9a-f]{64}$/);
  });

  it("first write wins: another kind or payload gets 409 and cannot replace evidence", async () => {
    const state = agentRunState();
    const service = makeTasks(agentRunDb(state));
    await start(service, state);
    const original = await service.ensureAgentRunInputSnapshot(AGENT_TASK_ID, {
      ...fence,
      kind: "solution-search-v1",
      payload: { candidates: [{ id: "gh:one" }] },
    });

    await assert.rejects(
      () =>
        service.ensureAgentRunInputSnapshot(AGENT_TASK_ID, {
          ...fence,
          kind: "solution-search-v1",
          payload: { candidates: [{ id: "gh:two" }] },
        }),
      /другим input snapshot payload/,
    );
    await assert.rejects(
      () =>
        service.ensureAgentRunInputSnapshot(AGENT_TASK_ID, {
          ...fence,
          kind: "solution-search-v2",
          payload: original.snapshot.payload,
        }),
      /другим input snapshot payload/,
    );
    assert.equal(state.execution?.inputSnapshotHash, original.snapshot.hash);
  });

  it("task input drift blocks snapshot and releases the lease for owner retry", async () => {
    const state = agentRunState();
    const service = makeTasks(agentRunDb(state));
    await start(service, state);
    state.task.description = "Владелец изменил критерии поиска";

    await assert.rejects(
      () =>
        service.ensureAgentRunInputSnapshot(
          AGENT_TASK_ID,
          { ...fence, kind: "solution-search-v1", payload: { candidates: [] } },
          AGENT_NOW,
        ),
      /Task changed after execution start/,
    );
    assert.equal(state.task.status, "todo");
    assert.equal(state.task.agentRunId, null);
    assert.equal(state.task.agentExecutionBlockedAt, AGENT_NOW);
    assert.equal(state.execution?.inputSnapshotHash, undefined);
  });

  it("rejects oversized, non-plain and secret-bearing payloads before persistence", async () => {
    const state = agentRunState();
    const service = makeTasks(agentRunDb(state));
    await start(service, state);

    await assert.rejects(
      () =>
        service.ensureAgentRunInputSnapshot(AGENT_TASK_ID, {
          ...fence,
          kind: "solution-search-v1",
          payload: { body: "я".repeat(33_000) },
        }),
      /64 KiB/,
    );
    await assert.rejects(
      () =>
        service.ensureAgentRunInputSnapshot(AGENT_TASK_ID, {
          ...fence,
          kind: "solution-search-v1",
          payload: { requestHeaders: { authorization: "Bearer must-not-persist" } },
        }),
      /запрещённое поле/,
    );
    await assert.rejects(
      () =>
        service.ensureAgentRunInputSnapshot(AGENT_TASK_ID, {
          ...fence,
          kind: "solution-search-v1",
          payload: { apiToken: "must-not-persist" },
        }),
      /запрещённое поле/,
    );
    await assert.rejects(
      () =>
        service.ensureAgentRunInputSnapshot(AGENT_TASK_ID, {
          ...fence,
          kind: "solution-search-v1",
          payload: new Date() as never,
        }),
      /plain JSON object/,
    );
    assert.equal(state.execution?.inputSnapshotHash, undefined);
  });

  it("stale takeover reuses the stored snapshot with a new runId and no new write", async () => {
    const state = agentRunState();
    const service = makeTasks(agentRunDb(state));
    await start(service, state);
    const first = await service.ensureAgentRunInputSnapshot(AGENT_TASK_ID, {
      ...fence,
      kind: "solution-search-v1",
      payload: { candidates: [{ id: "gh:one", url: "https://github.com/acme/one" }] },
    });

    const takeoverRunId = "55555555-5555-4555-8555-555555555555";
    state.task.agentRunId = takeoverRunId;
    const resumed = await start(service, state, takeoverRunId);
    assert.equal(resumed.replay, true);
    assert.deepEqual(resumed.execution.inputSnapshot, first.snapshot);

    const replay = await service.ensureAgentRunInputSnapshot(AGENT_TASK_ID, {
      ...fence,
      runId: takeoverRunId,
      kind: first.snapshot.kind,
      payload: first.snapshot.payload,
    });
    assert.equal(replay.replay, true);
    assert.equal(replay.snapshot.hash, first.snapshot.hash);
  });

  it("find-solution cannot checkpoint without the required snapshot", async () => {
    const state = agentRunState();
    const service = makeTasks(agentRunDb(state));
    await start(service, state);

    await assert.rejects(
      () =>
        service.checkpointAgentRun(
          AGENT_TASK_ID,
          { ...fence, skill: "find-solution", kind: "no_signal" },
          AGENT_NOW,
        ),
      /consistent solution-search-v1 input snapshot/,
    );
    assert.equal(state.execution?.status, "active");
    assert.equal(state.execution?.checkpointPayload, null);
    assert.equal(state.execution?.checkpointHash, null);
    assert.equal(state.task.status, "todo");
  });

  it("find-solution checkpoints after the valid snapshot is durable", async () => {
    const state = agentRunState();
    const service = makeTasks(agentRunDb(state));
    await start(service, state);
    await service.ensureAgentRunInputSnapshot(AGENT_TASK_ID, {
      ...fence,
      kind: "solution-search-v1",
      payload: { candidates: [], coverage: { github: "failed" } },
    });

    const checkpoint = await service.checkpointAgentRun(
      AGENT_TASK_ID,
      { ...fence, skill: "find-solution", kind: "no_signal" },
      AGENT_NOW,
    );
    assert.equal(checkpoint.checkpointed, true);
    assert.equal(checkpoint.replay, false);
    assert.equal(state.execution?.status, "ready");
    assert.match(String(state.execution?.checkpointHash), /^[0-9a-f]{64}$/);
  });
});

describe("Durable checkpoint и atomic agent outcome", () => {
  const fence = {
    agentName: "receivables",
    runId: AGENT_RUN_ID,
    executionAttemptId: AGENT_ATTEMPT_ID,
  };

  it("task input hash видит изменение ненулевого срока", () => {
    const earlier = agentRunState().task;
    earlier.due = new Date("2026-08-30T09:00:00.000Z");
    const later = { ...earlier, due: new Date("2026-08-31T09:00:00.000Z") };
    assert.notEqual(durableTaskInputHash(earlier as never), durableTaskInputHash(later as never));
  });

  it("checkpoint каноничен: порядок facts не важен, другой payload даёт 409", async () => {
    const state = agentRunState();
    const service = makeTasks(agentRunDb(state));
    const first = await service.checkpointAgentRun(
      AGENT_TASK_ID,
      {
        ...fence,
        skill: "watch-receivables",
        kind: "proposal",
        action: "Напомнить об оплате",
        facts: { overdue: 3, amount: 1500 },
      },
      AGENT_NOW,
    );
    const replay = await service.checkpointAgentRun(AGENT_TASK_ID, {
      ...fence,
      skill: "watch-receivables",
      kind: "proposal",
      action: "Напомнить об оплате",
      facts: { amount: 1500, overdue: 3 },
    });
    assert.equal(first.replay, false);
    assert.equal(replay.replay, true);
    assert.equal(replay.checkpoint.checkpointHash, first.checkpoint.checkpointHash);
    await assert.rejects(
      () =>
        service.checkpointAgentRun(AGENT_TASK_ID, {
          ...fence,
          skill: "watch-receivables",
          kind: "proposal",
          action: "Уже другое действие",
        }),
      /другим checkpoint payload/,
    );
  });

  it("no_signal commit атомарно закрывает task, пишет agent.run и replay не зависит от runId", async () => {
    const state = agentRunState();
    const service = makeTasks(agentRunDb(state));
    await service.checkpointAgentRun(AGENT_TASK_ID, {
      ...fence,
      skill: "watch-receivables",
      kind: "no_signal",
    });
    const input = {
      ...fence,
      kind: "no_signal" as const,
      note: "Проверил — повода нет.",
    };
    const committed = await service.commitAgentRun(AGENT_TASK_ID, input, AGENT_NOW);
    assert.equal(committed.status, "done");
    assert.equal(state.task.status, "done");
    assert.equal(state.execution?.status, "committed");
    const runEvent = state.events.find((row) => row.type === "agent.run");
    assert.equal(
      runEvent?.clientKey,
      `task:${AGENT_TASK_ID}:execution:${AGENT_ATTEMPT_ID}:event:agent-run`,
    );
    assert.equal(
      state.events.some((row) => row.type === "agent.action"),
      false,
    );

    const replay = await service.commitAgentRun(AGENT_TASK_ID, {
      ...input,
      runId: "55555555-5555-4555-8555-555555555555",
    });
    assert.equal(replay.replay, true, "takeover generation не меняет identity outcome");
    await assert.rejects(
      () => service.commitAgentRun(AGENT_TASK_ID, { ...input, note: "Другой исход" }),
      /другой outcome payload/,
    );
  });

  it("изменение task input блокирует attempt и снимает lease без hot-loop", async () => {
    const state = agentRunState();
    const service = makeTasks(agentRunDb(state));
    await service.checkpointAgentRun(AGENT_TASK_ID, {
      ...fence,
      skill: "watch-receivables",
      kind: "no_signal",
    });
    state.task.title = "Владелец изменил задачу";
    const result = await service.commitAgentRun(
      AGENT_TASK_ID,
      { ...fence, kind: "no_signal", note: "Повода нет" },
      AGENT_NOW,
    );
    assert.equal(result.status, "blocked");
    assert.equal(state.task.status, "todo");
    assert.equal(state.task.agentRunId, null);
    assert.equal(state.task.agentExecutionBlockedAt, AGENT_NOW);
    assert.equal(state.execution?.status, "ready", "owner retry ещё может abandon checkpoint");
    assert.equal(state.events.length, 0, "business effects до решения владельца не применяются");
  });

  it("checkpoint долговечно блокирует drift canonical plan hash", async () => {
    const state = agentRunState();
    state.execution = {
      id: "execution-1",
      taskId: AGENT_TASK_ID,
      executionAttemptId: AGENT_ATTEMPT_ID,
      agentName: "receivables",
      skill: "watch-receivables",
      schemaVersion: 2,
      status: "active",
      taskInputHash: durableTaskInputHash(state.task as never),
      workflowVersion: 1,
      executionPlan: { version: 1, steps: [] },
      executionPlanHash: "0".repeat(64),
    };
    await assert.rejects(
      () =>
        makeTasks(agentRunDb(state)).checkpointAgentRun(
          AGENT_TASK_ID,
          { ...fence, skill: "watch-receivables", kind: "no_signal" },
          AGENT_NOW,
        ),
      /canonical hash is inconsistent/,
    );
    assert.equal(state.task.status, "todo");
    assert.equal(state.task.agentRunId, null);
    assert.equal(state.task.agentExecutionBlockedAt, AGENT_NOW);
  });

  it("cap проверяется под advisory lock и оставляет proposal checkpoint на завтра", async () => {
    const previous = process.env.AGENT_DAILY_ACTION_CAP;
    process.env.AGENT_DAILY_ACTION_CAP = "1";
    try {
      const state = agentRunState();
      state.actionCount = 1;
      const service = makeTasks(agentRunDb(state));
      const proposal = {
        ...fence,
        skill: "watch-receivables",
        kind: "proposal" as const,
        action: "Напомнить об оплате",
        facts: { overdue: 3 },
      };
      await service.checkpointAgentRun(AGENT_TASK_ID, proposal);
      const result = await service.commitAgentRun(
        AGENT_TASK_ID,
        {
          ...fence,
          kind: "approval_requested",
          note: "Вынес на решение",
          action: proposal.action,
          facts: proposal.facts,
          tier: "T1",
        },
        AGENT_NOW,
      );
      assert.equal(result.capped, true);
      assert.equal(result.retryAt, "2026-08-29T19:00:00.000Z");
      assert.equal(state.execution?.status, "ready");
      assert.equal(state.task.agentExecutionAttemptId, AGENT_ATTEMPT_ID);
      assert.equal(state.approvals.length, 0);
      assert.equal(state.events.length, 0);
      assert.equal(state.deliveries.length, 0);
      assert.equal(state.advisoryLocks.length, 1);
    } finally {
      if (previous === undefined) delete process.env.AGENT_DAILY_ACTION_CAP;
      else process.env.AGENT_DAILY_ACTION_CAP = previous;
    }
  });

  it("approval/action/memory/task/outbox/execution фиксируются одним commit со stable keys", async () => {
    const previous = process.env.AGENT_DAILY_ACTION_CAP;
    process.env.AGENT_DAILY_ACTION_CAP = "50";
    try {
      const state = agentRunState();
      state.actionCount = 0;
      const service = makeTasks(agentRunDb(state));
      const facts = {
        overdue: 3,
        api_token: "не должен попасть в Notion",
        apiToken: "camelCase API token",
        nested: { clientSecret: "nested camelCase secret", visible: "safe value" },
      };
      await service.checkpointAgentRun(AGENT_TASK_ID, {
        ...fence,
        skill: "watch-receivables",
        kind: "proposal",
        action: "Напомнить об оплате",
        facts,
        next: ["Проверить завтра"],
      });
      const result = await service.commitAgentRun(
        AGENT_TASK_ID,
        {
          ...fence,
          kind: "approval_requested",
          note: "Вынес на решение владельца",
          action: "Напомнить об оплате",
          facts,
          next: ["Проверить завтра"],
          tier: "T1",
          memorySignature: "sig-1",
        },
        AGENT_NOW,
      );
      assert.equal(result.committed, true);
      assert.equal(state.approvals.length, 1);
      assert.deepEqual(
        state.events.map((row) => row.type),
        ["agent.run", "approval.requested", "agent.action", "agent.memory:watch-receivables"],
      );
      assert.equal(state.deliveries[0]?.destination, "notion-report");
      assert.equal(
        state.deliveries[0]?.key,
        `task:${AGENT_TASK_ID}:execution:${AGENT_ATTEMPT_ID}:notion-report`,
      );
      const report = (state.deliveries[0]?.payload as { report?: { blocks?: unknown[] } })?.report;
      assert.ok(report);
      assert.doesNotMatch(JSON.stringify(report), /не должен попасть в Notion/);
      assert.doesNotMatch(JSON.stringify(report), /camelCase API token/);
      assert.doesNotMatch(JSON.stringify(report), /nested camelCase secret/);
      assert.match(JSON.stringify(report), /safe value/);
      assert.equal(state.execution?.approvalId, result.approvalId);
      assert.equal(state.execution?.status, "committed");
      assert.equal(state.task.resultNote, "Вынес на решение владельца");
      assert.equal(state.advisoryLocks.length, 1);
    } finally {
      if (previous === undefined) delete process.env.AGENT_DAILY_ACTION_CAP;
      else process.env.AGENT_DAILY_ACTION_CAP = previous;
    }
  });

  it("redo committed agent task блокирует reuse, owner retry даёт новый attempt, history immutable", async () => {
    const state = agentRunState();
    state.task.status = "done";
    state.task.agentRunId = null;
    state.task.resultNote = "Прошлый результат";
    state.execution = {
      id: "execution-committed",
      taskId: AGENT_TASK_ID,
      executionAttemptId: AGENT_ATTEMPT_ID,
      agentName: "receivables",
      skill: "watch-receivables",
      status: "committed",
    };
    const service = makeTasks(agentRunDb(state));
    await service.rate(AGENT_TASK_ID, "redo");
    assert.ok(state.task.agentExecutionBlockedAt instanceof Date);
    assert.equal(state.task.agentExecutionAttemptId, AGENT_ATTEMPT_ID);

    await service.retryBlockedAgentExecution(AGENT_TASK_ID);
    assert.equal(state.task.agentExecutionAttemptId, null);
    assert.equal(state.task.agentExecutionBlockedAt, null);
    assert.equal(state.execution.status, "committed", "историческую execution row не меняем");
  });
});

describe("Общий пул свободных задач", () => {
  const PERSON = "11111111-1111-4111-8111-111111111111";

  it("взять свободную задачу — исполнителем становится нажавший", async () => {
    const inserted: Row[] = [];
    const s = makeTasks(stubDb({ updateResult: { id: "t1", ownerRef: PERSON }, inserted }));
    const claimed = await s.claim("t1", PERSON);
    assert.equal(claimed?.ownerRef, PERSON);
    assert.ok(
      inserted.some((r) => r.action === "task.claimed"),
      "взятие задачи должно быть видно в журнале",
    );
  });

  it("второй нажавший получает null, а не ошибку и не чужую задачу", async () => {
    // UPDATE ... WHERE owner_ref IS NULL не вернул строк: успел другой.
    // Гонку разрешает БД — при двух техниках и одном дайджесте это обычное утро.
    const s = makeTasks(stubDb({ updateResult: undefined }));
    assert.equal(await s.claim("t1", PERSON), null);
  });

  it("вернуть в пул можно только свою задачу", async () => {
    const s = makeTasks(stubDb({ existing: { id: "t1", ownerRef: "чужой", status: "todo" } }));
    assert.equal(
      await s.release("t1", PERSON),
      null,
      "иначе один сотрудник снимает задачу с другого",
    );
  });

  it("возврат в пул снимает исполнителя и выводит из работы", async () => {
    const inserted: Row[] = [];
    const s = makeTasks(
      stubDb({
        existing: { id: "t1", ownerRef: PERSON, status: "in_progress" },
        updateResult: { id: "t1", ownerRef: null, status: "todo" },
        inserted,
      }),
    );
    const freed = await s.release("t1", PERSON);
    assert.equal(freed?.ownerRef, null);
    assert.equal(freed?.status, "todo", "брошенная задача не должна висеть «в работе»");
    assert.ok(inserted.some((r) => r.action === "task.released"));
  });

  it("несуществующую задачу вернуть нельзя — это ошибка, а не отказ", async () => {
    const s = makeTasks(stubDb({}));
    await assert.rejects(() => makeTasks(stubDb({})).release("нет", PERSON), /не найдена/);
    assert.ok(s);
  });
});

describe("Оценка сделанной задачи", () => {
  it("«переделать» возвращает задачу в работу и включает напоминания заново", async () => {
    const captured: Record<string, unknown>[] = [];
    const done = { id: "t1", status: "done", resultNote: "готово", quality: null };
    const tx = {
      select: () => ({ from: () => ({ where: async () => [done] }) }),
      update: () => ({
        set: (patch: Record<string, unknown>) => {
          captured.push(patch);
          return { where: () => ({ returning: async () => [{ ...done, ...patch }] }) };
        },
      }),
      insert: () => ({ values: async () => [] }),
    };
    const db = {
      transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
    } as never;

    const s = makeTasks(db);
    const updated = await s.rate("t1", "redo");
    assert.equal(updated.status, "in_progress");
    assert.equal(captured[0].completedAt, null, "время закрытия должно сброситься");
    assert.equal(captured[0].remindedAt, null, "напоминания должны включиться заново");
    assert.equal(captured[0].agentRunId, null, "redo должен дать новую generation");
    assert.equal(
      "agentExecutionAttemptId" in captured[0],
      false,
      "общий SERVICE_TOKEN redo не вращает оплачиваемую попытку",
    );
    assert.equal("agentExecutionRetryAt" in captured[0], false);
    assert.equal("agentExecutionBlockedAt" in captured[0], false);
    assert.equal("agentExecutionBlockedReason" in captured[0], false);
    assert.equal(captured[0].agentRunClaimedAt, null);
  });

  it("«отлично» не меняет статус — только отметка качества", async () => {
    const captured: Record<string, unknown>[] = [];
    const done = { id: "t1", status: "done", resultNote: "готово", quality: null };
    const tx = {
      select: () => ({ from: () => ({ where: async () => [done] }) }),
      update: () => ({
        set: (patch: Record<string, unknown>) => {
          captured.push(patch);
          return { where: () => ({ returning: async () => [{ ...done, ...patch }] }) };
        },
      }),
      insert: () => ({ values: async () => [] }),
    };
    const db = {
      transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
    } as never;

    const s = makeTasks(db);
    const updated = await s.rate("t1", "excellent");
    assert.equal(updated.status, "done");
    assert.equal(captured[0].quality, "excellent");
    assert.equal("completedAt" in captured[0], false, "время закрытия трогать нельзя");
  });

  it("несделанную задачу оценить нельзя — понятная ошибка", async () => {
    const open = { id: "t1", status: "in_progress" };
    const tx = {
      select: () => ({ from: () => ({ where: async () => [open] }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
      insert: () => ({ values: async () => [] }),
    };
    const db = {
      transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
    } as never;

    const s = makeTasks(db);
    await assert.rejects(() => s.rate("t1", "excellent"), /только сделанную/);
  });

  it("redo не переоткрывает уже закрытую managed operational task", async () => {
    for (const source of MANAGED_OPERATIONAL_SOURCES) {
      const id = `${source}-resolved`;
      const service = makeTasks(
        stubDb({
          existing: {
            id,
            source,
            status: "done",
            ownerKind: "human",
          },
        }),
      );
      await assert.rejects(
        () => service.rate(id, "redo"),
        /переоткроет Core, если проблема вернётся/,
      );
    }
  });
});

describe("Правка полей задачи (edit)", () => {
  function editStub(existing: Row) {
    const captured: Record<string, unknown>[] = [];
    const tx = {
      update: () => ({
        set: (p: Record<string, unknown>) => {
          captured.push(p);
          return { where: () => ({ returning: async () => [{ ...existing, ...p }] }) };
        },
      }),
      insert: () => ({ values: async () => [] }),
      select: () => ({ from: () => ({ where: async () => [existing] }) }),
    };
    const db = {
      // byId использует .limit(1) — where возвращает объект с limit.
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [existing] }) }) }),
      transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
    } as never;
    return { db, captured };
  }

  it("переназначает исполнителя и меняет приоритет — трогает только эти поля", async () => {
    const { db, captured } = editStub({
      id: "t1",
      ownerKind: "human",
      ownerRef: null,
      priority: "normal",
    });
    const t = await makeTasks(db).edit("t1", {
      ownerKind: "agent",
      ownerRef: "vendhub-ops",
      priority: "high",
    });
    assert.equal(t.ownerKind, "agent");
    assert.equal(captured[0].ownerRef, "vendhub-ops");
    assert.equal(captured[0].priority, "high");
    assert.equal("status" in captured[0], false, "статус правкой полей не трогаем");
    assert.equal(
      "agentExecutionAttemptId" in captured[0],
      false,
      "переназначение с общим SERVICE_TOKEN не вращает денежный attempt",
    );
    assert.equal("agentExecutionBlockedAt" in captured[0], false);
  });

  it("managed operational issue нельзя назначить LLM-агенту", async () => {
    for (const source of MANAGED_OPERATIONAL_SOURCES) {
      const id = `${source}-1`;
      const { db, captured } = editStub({
        id,
        source,
        ownerKind: "human",
        ownerRef: null,
      });

      await assert.rejects(
        () => makeTasks(db).edit(id, { ownerKind: "agent", ownerRef: "vendhub-ops" }),
        /нельзя назначить агенту/,
      );
      assert.equal(captured.length, 0, "ни owner, ни LLM attempt не меняются");
    }
  });

  it("переносит задачу в другое направление", async () => {
    const { db, captured } = editStub({
      id: "t1",
      domain: "vendhub",
      ownerKind: "human",
      ownerRef: null,
    });

    const updated = await makeTasks(db).edit("t1", { domain: "globerent" });

    assert.equal(updated.domain, "globerent");
    assert.equal(captured[0].domain, "globerent");
    assert.equal("ownerRef" in captured[0], false);
  });

  it("пустое описание/исполнитель → снятие (null)", async () => {
    const { db, captured } = editStub({ id: "t1" });
    await makeTasks(db).edit("t1", { description: "  ", ownerRef: "" });
    assert.equal(captured[0].description, null);
    assert.equal(captured[0].ownerRef, null);
  });

  it("переназначение не отдаёт новому агенту checkpoint старого", async () => {
    const attempt = "11111111-1111-4111-8111-111111111111";
    const { db, captured } = editStub({
      id: "t1",
      ownerKind: "agent",
      ownerRef: "old-agent",
      agentExecutionAttemptId: attempt,
    });

    await makeTasks(db).edit("t1", { ownerRef: "new-agent" });

    assert.equal(
      "agentExecutionAttemptId" in captured[0],
      false,
      "SERVICE_TOKEN не вращает attempt",
    );
    assert.ok(captured[0].agentExecutionBlockedAt instanceof Date);
    assert.match(String(captured[0].agentExecutionBlockedReason), /owner retry/);
    assert.equal(captured[0].agentRunId, null);
  });

  it("пустой заголовок отклоняется", async () => {
    const { db } = editStub({ id: "t1" });
    await assert.rejects(() => makeTasks(db).edit("t1", { title: "   " }), /пустым/);
  });

  it("пустой патч не трогает базу и возвращает задачу", async () => {
    const { db, captured } = editStub({ id: "t1", title: "Как есть" });
    const t = await makeTasks(db).edit("t1", {});
    assert.equal(t.id, "t1");
    assert.equal(captured.length, 0, "нечего менять — не пишем в журнал");
  });

  it("нет задачи → понятная ошибка", async () => {
    const tx = {
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
      insert: () => ({ values: async () => [] }),
      select: () => ({ from: () => ({ where: async () => [] }) }),
    };
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
      transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
    } as never;
    await assert.rejects(() => makeTasks(db).edit("нет", { priority: "high" }), /не найдена/);
  });
});

describe("Страховка: автомату вне эксплуатации задач не ставим", () => {
  const общее = {
    title: "Плановое ТО — Olma склад",
    ownerKind: "human" as const,
    source: "maint:plan-1",
    dayKey: "2026-11-04",
    entityId: "22222222-2222-4222-8222-222222222222",
  };

  it("автомат в ремонте задачу не получает", async () => {
    // Правило соблюдает монитор графиков, но POST /tasks/ensure-day открыт:
    // следующий источник повторяющихся задач обошёл бы его молча.
    const inserted: Row[] = [];
    const s = makeTasks(stubDb({ selectResult: [{ status: "repair" }], inserted }));
    const res = await s.ensureForDay(общее);
    assert.equal(res, null);
    assert.equal(inserted.length, 0, "ни задачи, ни записи в журнале");
  });

  it("автомат на складе — то же самое", async () => {
    const s = makeTasks(stubDb({ selectResult: [{ status: "warehouse" }] }));
    assert.equal(await s.ensureForDay(общее), null);
  });

  it("рабочий автомат задачу получает", async () => {
    const s = makeTasks(stubDb({ selectResult: [{ status: "in_service" }] }));
    assert.ok(await s.ensureForDay(общее));
  });

  it("объект без карточки автомата считается рабочим", async () => {
    // Признак заводился для парка, а не для всего реестра: техника,
    // помещения и договоры не должны молча остаться без задач.
    const s = makeTasks(stubDb({ selectResult: [] }));
    assert.ok(await s.ensureForDay(общее));
  });

  it("задача без объекта проверку не проходит вовсе", async () => {
    const s = makeTasks(stubDb({}));
    assert.ok(
      await s.ensureForDay({ title: "Инвентаризация", ownerKind: "human", dayKey: "2026-08-08" }),
    );
  });
});

describe("Хук «закрыл задачу ТО → факт в журнале обслуживания»", () => {
  const PLAN = "44444444-4444-4444-8444-444444444444";
  const ENTITY = "55555555-5555-4555-8555-555555555555";
  const план = { id: PLAN, entityId: ENTITY, kind: "cleaning", partKind: "mixer" };

  /** Maintenance-заглушка, записывающая вызовы createLog. */
  function maintSpy(calls: Row[]) {
    return {
      createLog: async (input: Row, tx: unknown) => {
        calls.push({ ...input, txPassed: tx !== undefined });
        return {};
      },
    } as never;
  }

  it("закрытие maint-задачи пишет факт с идемпотентным ключом в той же транзакции", async () => {
    const calls: Row[] = [];
    const s = new TasksService(
      stubDb({
        updateResult: {
          id: "t1",
          status: "done",
          source: `maint:${PLAN}:2026-08-01`,
          resultNote: "промыл",
          entityId: ENTITY,
        },
        // очередь: task lock → план найден → сегодня ещё не отмечено.
        selects: [[{ id: "t1", status: "in_progress", ownerKind: "human" }], [план], []],
      }),
      maintSpy(calls),
    );
    await s.setStatus("t1", "done", "person:x", "промыл");

    assert.equal(calls.length, 1, "факт обязан записаться");
    const call = calls[0]!;
    assert.equal(call.planId, PLAN);
    assert.equal(call.kind, "cleaning");
    assert.equal(call.partKind, "mixer");
    assert.equal(call.outcome, "done");
    assert.equal(call.clientKey, "task:t1", "ретрай закрытия не должен дать вторую запись");
    assert.equal(call.note, "промыл", "отчёт из задачи становится заметкой факта");
    assert.equal(call.txPassed, true, "факт и статус коммитятся вместе");
  });

  it("«Сделал» в Графиках уже нажат сегодня — второй записи нет", async () => {
    const calls: Row[] = [];
    const s = new TasksService(
      stubDb({
        updateResult: {
          id: "t1",
          status: "done",
          source: `maint:${PLAN}:2026-08-01`,
          resultNote: null,
        },
        selects: [
          [{ id: "t1", status: "in_progress", ownerKind: "human" }],
          [план],
          [{ id: "уже" }],
        ],
      }),
      maintSpy(calls),
    );
    await s.setStatus("t1", "done");
    assert.equal(calls.length, 0, "двойной счёт одного факта запрещён");
  });

  it("план удалён — закрытие задачи не падает и факт не пишется", async () => {
    const calls: Row[] = [];
    const s = new TasksService(
      stubDb({
        updateResult: {
          id: "t1",
          status: "done",
          source: `maint:${PLAN}:2026-08-01`,
          resultNote: null,
        },
        selects: [[{ id: "t1", status: "in_progress", ownerKind: "human" }], []],
      }),
      maintSpy(calls),
    );
    const t = await s.setStatus("t1", "done");
    assert.equal(t.status, "done");
    assert.equal(calls.length, 0);
  });

  it("обычная задача (source не maint:*) журнал обслуживания не трогает", async () => {
    // makeTasks с бросающей заглушкой: дойди хук до createLog — тест упал бы.
    const s = makeTasks(
      stubDb({
        existing: { id: "t1", status: "in_progress", ownerKind: "human" },
        updateResult: { id: "t1", status: "done", source: "manual", resultNote: null },
      }),
    );
    const t = await s.setStatus("t1", "done");
    assert.equal(t.status, "done");
  });
});

describe("Права актора на приёмку и назначение (П7, R-P7-12)", () => {
  const OPERATOR = "22222222-2222-4222-8222-222222222222";
  const MANAGER = "33333333-3333-4333-8333-333333333333";

  /**
   * Заглушка прав. `верхние` — очередь ответов на `db.select()` вне
   * транзакции: `edit()` сначала читает задачу, затем карточку актора.
   */
  function правовойStub(верхние: Row[][], задача: Row) {
    const очередь = [...верхние];
    const tx = {
      select: () => ({ from: () => ({ where: async () => [задача] }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [задача] }) }) }),
      insert: () => ({ values: async () => [] }),
    };
    return {
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => очередь.shift() ?? [] }) }),
      }),
      transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
    } as never;
  }

  it("оценка от оператора — 403, и текст объясняет, что чинится ролью", async () => {
    const db = правовойStub([[{ id: OPERATOR, roles: ["operator"], role: null, active: "yes" }]], {
      id: "t1",
      status: "done",
      quality: null,
      resultNote: "готово",
    });
    await assert.rejects(
      () => makeTasks(db).rate("t1", "redo", `person:${OPERATOR}`),
      /Это может менеджер/,
    );
  });

  it("оценка от менеджера проходит — роль из массива", async () => {
    const db = правовойStub([[{ id: MANAGER, roles: ["manager"], role: null, active: "yes" }]], {
      id: "t1",
      status: "done",
      quality: null,
      resultNote: "готово",
    });
    const t = await makeTasks(db).rate("t1", "accepted", `person:${MANAGER}`);
    assert.equal(t.id, "t1");
  });

  it("оценка от владельца проходит без похода в карточку", async () => {
    const db = правовойStub([], { id: "t1", status: "done", quality: null, resultNote: "готово" });
    assert.equal((await makeTasks(db).rate("t1", "excellent")).id, "t1");
  });

  it("уволенный менеджер прав не имеет — карточка осталась, доступ нет", async () => {
    const db = правовойStub([[{ id: MANAGER, roles: ["manager"], role: null, active: "no" }]], {
      id: "t1",
      status: "done",
      quality: null,
      resultNote: "готово",
    });
    await assert.rejects(
      () => makeTasks(db).rate("t1", "accepted", `person:${MANAGER}`),
      /Это может менеджер/,
    );
  });

  it("актор не в форме `person:<uuid>` отвергается, а не считается владельцем", async () => {
    const db = правовойStub([], { id: "t1", status: "done", quality: null, resultNote: "г" });
    await assert.rejects(
      () => makeTasks(db).rate("t1", "accepted", "менеджер"),
      /Это может менеджер/,
    );
  });

  it("правка срока прав назначения не требует, смена исполнителя — требует", async () => {
    const задача = {
      id: "t1",
      ownerKind: "human",
      ownerRef: OPERATOR,
      priority: "normal",
      due: null,
    };
    const срок = правовойStub([[задача]], задача);
    const t = await makeTasks(срок).edit(
      "t1",
      { due: new Date("2026-08-27T05:00:00Z") },
      `person:${OPERATOR}`,
    );
    assert.equal(t.id, "t1");

    const смена = правовойStub(
      [[задача], [{ id: OPERATOR, roles: ["operator"], role: null, active: "yes" }]],
      задача,
    );
    await assert.rejects(
      () => makeTasks(смена).edit("t1", { ownerRef: MANAGER }, `person:${OPERATOR}`),
      /Это может менеджер/,
    );
  });

  it("переназначение на того же человека права не требует — смены нет", async () => {
    const задача = { id: "t1", ownerKind: "human", ownerRef: OPERATOR, priority: "normal" };
    const db = правовойStub([[задача]], задача);
    assert.equal(
      (await makeTasks(db).edit("t1", { ownerRef: OPERATOR }, `person:${OPERATOR}`)).id,
      "t1",
    );
  });
});

describe("Приёмка работы менеджером (П7, R-P7-5/R-P7-6)", () => {
  const NOW = new Date("2026-08-26T10:00:00+05:00");

  function confirmationDb(row: Row, succeeds = true) {
    const patches: Row[] = [];
    const inserted: Row[] = [];
    const current = { ...row };
    const selectChain = () => {
      const result = async () => [current];
      return Object.assign(result(), { limit: result });
    };
    const tx = {
      select: () => ({ from: () => ({ where: selectChain }) }),
      update: () => ({
        set: (patch: Row) => {
          patches.push(patch);
          return {
            where: () => ({
              returning: async () => {
                if (!succeeds) return [];
                Object.assign(current, patch);
                return [current];
              },
            }),
          };
        },
      }),
      insert: () => ({
        values: async (value: Row) => {
          inserted.push(value);
          return [];
        },
      }),
    };
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
      transaction: async <T>(callback: (value: typeof tx) => Promise<T>): Promise<T> =>
        callback(tx),
    } as never;
    return { db, patches, inserted };
  }

  it("отказывает для незавершённой задачи", async () => {
    const { db } = confirmationDb({ id: "t1", status: "todo", quality: null, confirmedAt: null });
    await assert.rejects(() => makeTasks(db).confirm("t1", "owner", NOW), /только сделанную/);
  });

  it("не меняет status и ставит accepted только при отсутствии оценки", async () => {
    const blank = confirmationDb({
      id: "t1",
      title: "Пополнить Olma",
      ownerRef: "p1",
      status: "done",
      quality: null,
      confirmedAt: null,
    });
    const accepted = await makeTasks(blank.db).confirm("t1", "owner", NOW);
    assert.equal(accepted.status, "done");
    assert.equal("status" in blank.patches[0]!, false);
    assert.equal(blank.patches[0]!.quality, "accepted");
    assert.equal(blank.patches[0]!.confirmedAt, NOW);

    const rated = confirmationDb({
      id: "t2",
      title: "Проверить Olma",
      ownerRef: "p1",
      status: "done",
      quality: "excellent",
      confirmedAt: null,
    });
    await makeTasks(rated.db).confirm("t2", "owner", NOW);
    assert.equal("quality" in rated.patches[0]!, false, "excellent нельзя понижать до accepted");
  });

  it("успех пишет один аудит и одно событие task.confirmed", async () => {
    const fixture = confirmationDb({
      id: "t1",
      title: "Пополнить Olma",
      ownerRef: "p1",
      status: "done",
      quality: null,
      confirmedAt: null,
    });
    await makeTasks(fixture.db).confirm("t1", "owner", NOW);
    assert.ok(fixture.inserted.some((value) => value.action === "task.confirmed"));
    const eventRow = fixture.inserted.find((value) => value.type === "task.confirmed");
    assert.ok(eventRow);
    assert.equal((eventRow.payload as Row).title, "Пополнить Olma");
    assert.equal(eventRow.occurredAt, NOW);
  });

  it("повтор не пишет дубль и возвращает уже принятую строку", async () => {
    const fixture = confirmationDb(
      { id: "t1", status: "done", quality: "accepted", confirmedAt: "2026-08-26T04:00:00.000Z" },
      false,
    );
    const result = await makeTasks(fixture.db).confirm("t1", "owner", NOW);
    assert.equal(result.confirmedAt, "2026-08-26T04:00:00.000Z");
    assert.deepEqual(fixture.inserted, []);
  });
});

describe("Постраничные списки задач", () => {
  it("общий список передаёт limit/offset и имеет уникальный tie-breaker", async () => {
    let limit = 0;
    let offset = 0;
    let orderColumns = 0;
    const rows = [{ id: "t1" }, { id: "t2" }];
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: (...columns: unknown[]) => {
              orderColumns = columns.length;
              return {
                limit: (value: number) => {
                  limit = value;
                  return {
                    offset: async (valueOffset: number) => {
                      offset = valueOffset;
                      return rows;
                    },
                  };
                },
              };
            },
          }),
        }),
      }),
    } as never;

    const result = await makeTasks(db).list({ openOnly: true, limit: 40, offset: 80 });
    assert.deepEqual(result, rows);
    assert.equal(limit, 40);
    assert.equal(offset, 80);
    assert.equal(orderColumns, 4, "id — последний уникальный tie-breaker");
  });

  it("ограничен и строится по confirmed_at, старейшее первым", async () => {
    const conditions: unknown[] = [];
    let limit = 0;
    let offset = -1;
    let orderColumns = 0;
    const rows = [
      { id: "t1", completedAt: "2026-08-20T05:00:00.000Z" },
      { id: "t2", completedAt: "2026-08-25T05:00:00.000Z" },
    ];
    const db = {
      select: () => ({
        from: () => ({
          where: (condition: unknown) => {
            conditions.push(condition);
            return {
              orderBy: (...columns: unknown[]) => {
                orderColumns = columns.length;
                return {
                  limit: (value: number) => {
                    limit = value;
                    return {
                      offset: async (valueOffset: number) => {
                        offset = valueOffset;
                        return rows;
                      },
                    };
                  },
                };
              },
            };
          },
        }),
      }),
    } as never;
    const result = await makeTasks(db).awaitingConfirmation(25, 50);
    assert.deepEqual(
      result.map((row) => row.id),
      ["t1", "t2"],
    );
    assert.equal(limit, 25);
    assert.equal(offset, 50);
    assert.equal(orderColumns, 3, "completedAt + createdAt + id дают стабильный порядок");
    const query = new PgDialect().sqlToQuery(
      conditions[0] as Parameters<PgDialect["sqlToQuery"]>[0],
    );
    assert.match(query.sql, /confirmed_at/);
  });
});

describe("Отметка «тебе поручили» (П7, R-P7-10)", () => {
  const PERSON = "11111111-1111-4111-8111-111111111111";
  const ДРУГОЙ = "22222222-2222-4222-8222-222222222222";
  const СЕЙЧАС = new Date("2026-08-26T10:00:00+05:00");

  function editDb(existing: Row) {
    const captured: Row[] = [];
    const tx = {
      update: () => ({
        set: (patch: Row) => {
          captured.push(patch);
          return { where: () => ({ returning: async () => [{ ...existing, ...patch }] }) };
        },
      }),
      insert: () => ({ values: async () => [] }),
    };
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [existing] }) }) }),
      transaction: async <T>(callback: (value: typeof tx) => Promise<T>): Promise<T> =>
        callback(tx),
    } as never;
    return { db, captured };
  }

  it("созданное назначение оставляет отметку NULL по умолчанию", async () => {
    const inserted: Row[] = [];
    await makeTasks(stubDb({ inserted })).create({
      title: "Пополнить Olma",
      ownerKind: "human",
      ownerRef: PERSON,
    });
    assert.equal("assignNotifiedAt" in inserted[0]!, false, "NULL должен дать default схемы");
  });

  it("«взял сам» гасит пуш", async () => {
    const patches: Row[] = [];
    const tx = {
      update: () => ({
        set: (patch: Row) => {
          patches.push(patch);
          return { where: () => ({ returning: async () => [{ id: "t1", ownerRef: PERSON }] }) };
        },
      }),
      insert: () => ({ values: async () => [] }),
    };
    const db = {
      transaction: async <T>(callback: (value: typeof tx) => Promise<T>): Promise<T> =>
        callback(tx),
    } as never;
    await makeTasks(db).claim("t1", PERSON, СЕЙЧАС);
    assert.equal(patches[0]!.assignNotifiedAt, СЕЙЧАС);
  });

  it("возврат в пул возвращает отметку в NULL", async () => {
    const patches: Row[] = [];
    const before = { id: "t1", ownerRef: PERSON, status: "in_progress" };
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [before] }) }) }),
      update: () => ({
        set: (patch: Row) => {
          patches.push(patch);
          return { where: () => ({ returning: async () => [{ ...before, ...patch }] }) };
        },
      }),
      insert: () => ({ values: async () => [] }),
    };
    const db = {
      transaction: async <T>(callback: (value: typeof tx) => Promise<T>): Promise<T> =>
        callback(tx),
    } as never;
    await makeTasks(db).release("t1", PERSON);
    assert.equal(patches[0]!.assignNotifiedAt, null);
  });

  it("смена исполнителя сбрасывает отметку, правка срока и тот же исполнитель — нет", async () => {
    const existing = {
      id: "t1",
      ownerKind: "human",
      ownerRef: PERSON,
      priority: "normal",
      due: null,
    };
    const смена = editDb(existing);
    await makeTasks(смена.db).edit("t1", { ownerRef: ДРУГОЙ });
    assert.equal(смена.captured[0]!.assignNotifiedAt, null);

    const срок = editDb(existing);
    await makeTasks(срок.db).edit("t1", { due: new Date("2026-08-27T05:00:00Z") });
    assert.equal("assignNotifiedAt" in срок.captured[0]!, false);

    const тотЖе = editDb(existing);
    await makeTasks(тотЖе.db).edit("t1", { ownerRef: PERSON });
    assert.equal("assignNotifiedAt" in тотЖе.captured[0]!, false);
  });

  it("assign-unnotified спрашивает назначенные и незакрытые без отметки", async () => {
    const conditions: unknown[] = [];
    let limit = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: (condition: unknown) => {
            conditions.push(condition);
            return {
              limit: async (value: number) => {
                limit = value;
                return [{ id: "t1", ownerRef: PERSON }];
              },
            };
          },
        }),
      }),
    } as never;
    const rows = await makeTasks(db).assignUnnotified();
    assert.deepEqual(
      rows.map((row) => row.id),
      ["t1"],
    );
    assert.equal(limit, 50);
    const query = new PgDialect().sqlToQuery(
      conditions[0] as Parameters<PgDialect["sqlToQuery"]>[0],
    );
    assert.match(query.sql, /assign_notified_at/);
    assert.match(query.sql, /owner_ref/);
    assert.match(query.sql, /status/);
  });

  it("отметка сохраняет переданный момент", async () => {
    const patches: Row[] = [];
    const db = {
      update: () => ({
        set: (patch: Row) => {
          patches.push(patch);
          return { where: async () => [] };
        },
      }),
    } as never;
    await makeTasks(db).markAssignNotified("t1", СЕЙЧАС);
    assert.equal(patches[0]!.assignNotifiedAt, СЕЙЧАС);
  });
});
