import { createHash, randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  approval,
  auditLog,
  event,
  llmSpend,
  machineCard,
  maintenanceLog,
  maintenancePlan,
  outboxDelivery,
  person,
  task,
  taskAgentExecution,
  TASK_SOURCE_DAY_PREDICATE,
  taskComment,
} from "@mydon/db";
import {
  can,
  effectiveRoles,
  machineIsOperational,
  tashkentDay,
  tashkentDayStartOf,
  type Domain,
  type Permission,
} from "@mydon/shared";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { appConfig } from "../config";
import { DB, type Db } from "../db/db.module";
import { MaintenanceService, todayInTz } from "../maintenance/maintenance.service";

/** Транзакция Drizzle — та же, что даёт `db.transaction(async (tx) => …)`. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Источник авто-задачи ТО: `maint:<planId>:<YYYY-MM-DD>` (maintenance-monitor). */
const MAINT_SOURCE = /^maint:([0-9a-f][0-9a-f-]{34}[0-9a-f]):\d{4}-\d{2}-\d{2}$/;

type TaskRow = typeof task.$inferSelect;
type CommentRow = typeof taskComment.$inferSelect;
type TaskAgentExecutionRow = typeof taskAgentExecution.$inferSelect;
type Status = "todo" | "in_progress" | "done" | "cancelled";
type Priority = "low" | "normal" | "high" | "urgent";
type Tier = "T0" | "T1" | "T2" | "T3" | "T4";
type JsonObject = Record<string, unknown>;

export interface AgentRunFenceInput {
  agentName: string;
  runId: string;
  executionAttemptId: string;
}

export interface AgentRunCheckpointInput extends AgentRunFenceInput {
  skill: string;
  kind: "no_signal" | "proposal";
  action?: string;
  facts?: JsonObject;
  next?: string[];
}

export interface AgentRunCommitInput extends AgentRunFenceInput {
  kind: "no_signal" | "no_change" | "approval_requested" | "executed";
  note: string;
  action?: string;
  facts?: JsonObject;
  next?: string[];
  tier?: Tier;
  memorySignature?: string;
  executionDetail?: string;
}

export interface AgentCheckpointView {
  id: string;
  executionAttemptId: string;
  skill: string;
  kind: "no_signal" | "proposal";
  action?: string;
  facts?: JsonObject;
  next?: string[];
  taskInputHash: string;
  checkpointHash: string;
  createdAt: string;
}

export interface AgentRunCheckpointResult {
  checkpointed: true;
  replay: boolean;
  checkpoint: AgentCheckpointView;
}

export interface AgentRunCommitResult {
  committed: boolean;
  capped: boolean;
  replay: boolean;
  taskId: string;
  executionAttemptId: string;
  status: "done" | "todo" | "blocked";
  resultNote?: string;
  approvalId?: string;
  outboxDeliveryId?: string;
  retryAt?: string;
}

type ClaimedAgentRun = TaskRow & { agentCheckpoint: AgentCheckpointView | null };

/** JSON canonicalization for hashes and persisted replay payloads. */
function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new BadRequestException("JSON содержит нечисловое значение");
    return Object.is(value, -0) ? 0 : value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) {
        // Own data property keeps `__proto__` in canonical JSON without
        // mutating the prototype. A regular prototype is intentional:
        // Drizzle 0.45 cannot accept null-prototype objects in `.values()`.
        Object.defineProperty(result, key, {
          value: canonicalValue(source[key]),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
    return result;
  }
  throw new BadRequestException("JSON содержит неподдерживаемое значение");
}

function canonicalHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");
}

function jsonObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function normalizedOptionalText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizedNext(value: string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const normalized = value.map((item) => item.trim()).filter((item) => item.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function taskInputHash(row: TaskRow): string {
  return canonicalHash({
    schemaVersion: 1,
    id: row.id,
    title: row.title,
    description: row.description,
    ownerKind: row.ownerKind,
    ownerRef: row.ownerRef,
    domain: row.domain,
    entityId: row.entityId,
    priority: row.priority,
    due: row.due,
    source: row.source,
    createdBy: row.createdBy,
  });
}

function checkpointPayload(input: AgentRunCheckpointInput): JsonObject {
  const action = normalizedOptionalText(input.action);
  const next = normalizedNext(input.next);
  return canonicalValue({
    kind: input.kind,
    ...(action !== undefined ? { action } : {}),
    ...(input.facts !== undefined ? { facts: input.facts } : {}),
    ...(next !== undefined ? { next } : {}),
  }) as JsonObject;
}

function commitPayload(input: AgentRunCommitInput): JsonObject {
  const action = normalizedOptionalText(input.action);
  const next = normalizedNext(input.next);
  const memorySignature = normalizedOptionalText(input.memorySignature);
  const executionDetail = normalizedOptionalText(input.executionDetail);
  return canonicalValue({
    kind: input.kind,
    note: input.note.trim(),
    ...(action !== undefined ? { action } : {}),
    ...(input.facts !== undefined ? { facts: input.facts } : {}),
    ...(next !== undefined ? { next } : {}),
    ...(input.tier !== undefined ? { tier: input.tier } : {}),
    ...(memorySignature !== undefined ? { memorySignature } : {}),
    ...(executionDetail !== undefined ? { executionDetail } : {}),
  }) as JsonObject;
}

function checkpointView(row: TaskAgentExecutionRow): AgentCheckpointView {
  const payload = jsonObject(row.checkpointPayload);
  const kind = row.checkpointKind;
  if (kind !== "no_signal" && kind !== "proposal") {
    throw new Error(`Неизвестный checkpoint kind ${kind}`);
  }
  return {
    id: row.id,
    executionAttemptId: row.executionAttemptId,
    skill: row.skill,
    kind,
    ...(typeof payload.action === "string" ? { action: payload.action } : {}),
    ...(payload.facts !== undefined ? { facts: jsonObject(payload.facts) } : {}),
    ...(Array.isArray(payload.next)
      ? { next: payload.next.filter((item): item is string => typeof item === "string") }
      : {}),
    taskInputHash: row.taskInputHash,
    checkpointHash: row.checkpointHash,
    createdAt: row.createdAt.toISOString(),
  };
}

const SECRET_FACT_KEY =
  /(?:^|[_-])(token|secret|password|passphrase|authorization|cookie|api[_-]?key)(?:$|[_-])/i;

function redactReportSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactReportSecrets(item));
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      Object.defineProperty(result, key, {
        value: SECRET_FACT_KEY.test(key) ? "[REDACTED]" : redactReportSecrets(source[key]),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  }
  return value;
}

function reportFact(value: unknown): string {
  const safe = redactReportSecrets(value);
  if (typeof safe === "string") return safe;
  if (safe === null || typeof safe === "number" || typeof safe === "boolean") return String(safe);
  return JSON.stringify(canonicalValue(safe));
}

function notionReportPayload(
  execution: TaskAgentExecutionRow,
  outcomeKind: "approval_requested" | "executed",
  action: string,
  facts: JsonObject,
): JsonObject {
  const [year, month, day] = tashkentDay(execution.createdAt).split("-");
  const report = {
    title: `${action.slice(0, 80)} — ${day}.${month}.${year}`,
    author: execution.agentName,
    blocks: [
      { heading: "Что нашёл", paragraphs: [action] },
      {
        heading: "На чём это основано",
        bullets: Object.keys(facts)
          .sort()
          .filter((key) => !SECRET_FACT_KEY.test(key))
          .map((key) => `${key}: ${reportFact(facts[key])}`),
      },
      {
        paragraphs: [
          outcomeKind === "executed"
            ? `Навык: ${execution.skill}. Агент исполнил действие в пределах действующего порога автономии.`
            : `Навык: ${execution.skill}. Решение принимает владелец — агент только предлагает.`,
        ],
      },
    ],
  };
  return canonicalValue({ report }) as JsonObject;
}

export interface CreateTaskInput {
  title: string;
  ownerKind: "human" | "agent";
  ownerRef?: string;
  domain?: Domain;
  due?: Date;
  source?: string;
  description?: string;
  priority?: Priority;
  createdBy?: string;
  /** По какому объекту работа: автомат, точка, склад. */
  entityId?: string;
  /** Ключ идемпотентности от клиента: ретрай не даёт дубль-задачу. */
  clientKey?: string;
}

/** Сводка по исполнителю — «картина по людям» из контроля задач. */
export interface WorkloadRow {
  ownerKind: "human" | "agent";
  ownerRef: string | null;
  open: number;
  overdue: number;
  doneLast7d: number;
  /** Качество: сколько сделанных отмечено «отлично» и сколько вернулось на доработку. */
  excellent: number;
  redo: number;
  /** Дисциплина сроков: сделано в срок / сделано со сроком. */
  doneOnTime: number;
  doneWithDue: number;
}

/**
 * Задачи (ТЗ §7).
 *
 * Владелец — человек или агент: одна очередь на обоих, чтобы «кто это делает»
 * было видно в одном месте, а не в голове.
 *
 * Просроченные задачи попадают в утренний брифинг наравне с деньгами
 * и автоматами — иначе смысла заводить их в системе нет.
 */
@Injectable()
export class TasksService {
  /** Максимум строк на экране приёмки. */
  static readonly AWAITING_LIMIT = 100;
  /** После этого падение worker не блокирует задачу навсегда. */
  static readonly AGENT_RUN_LEASE_MS = 15 * 60_000;

  /** Актор с правами: панель ходит от владельца, бот — от карточки сотрудника. */
  private static readonly ACTOR_PERSON =
    /^person:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly maintenance: MaintenanceService,
  ) {}

  private async lockTask(tx: Tx, id: string): Promise<TaskRow> {
    const [row] = await tx.select().from(task).where(eq(task.id, id)).for("update");
    if (!row) throw new NotFoundException(`Задача ${id} не найдена`);
    return row;
  }

  private assertAgentRunFence(row: TaskRow, input: AgentRunFenceInput): void {
    const agentName = input.agentName.trim();
    if (
      row.ownerKind !== "agent" ||
      row.ownerRef !== agentName ||
      row.agentRunId !== input.runId ||
      row.agentExecutionAttemptId !== input.executionAttemptId ||
      row.status === "done" ||
      row.status === "cancelled"
    ) {
      throw new ConflictException("Прогон агента уже закрыт или заменён новой generation");
    }
  }

  private async lockExecution(
    tx: Tx,
    executionAttemptId: string,
  ): Promise<TaskAgentExecutionRow | undefined> {
    const [row] = await tx
      .select()
      .from(taskAgentExecution)
      .where(eq(taskAgentExecution.executionAttemptId, executionAttemptId))
      .for("update");
    return row;
  }

  /**
   * Проверяет право актора на действие, но не подменяет аутентификацию.
   * `actorRef` приходит от держателя SERVICE_TOKEN: это защита от промаха и
   * от доступной вручную кнопки, а не доверие произвольному внешнему клиенту.
   */
  private async assertCan(actorRef: string, perm: Permission): Promise<void> {
    if (actorRef === "owner") return;
    const denial = "Это может менеджер. Попроси владельца проставить роль.";
    const match = TasksService.ACTOR_PERSON.exec(actorRef);
    if (!match) throw new ForbiddenException(denial);
    const [actor] = await this.db
      .select({ roles: person.roles, role: person.role, active: person.active })
      .from(person)
      .where(eq(person.id, match[1]!))
      .limit(1);
    if (!actor || actor.active !== "yes" || !can(effectiveRoles(actor), perm)) {
      throw new ForbiddenException(denial);
    }
  }

  /** Создание вместе с записью в журнал — одной транзакцией. */
  async create(input: CreateTaskInput, actorRef = "system"): Promise<TaskRow> {
    return this.db.transaction(async (tx) => {
      // Пустая строка от клиента (нет активного человека под рукой) не должна
      // осесть в базе как «занятая» задача — те же правила, что у PATCH
      // (setStatus/edit, см. ниже): "" нормализуется в null.
      const ownerRef = (input.ownerRef ?? "").trim();
      const [created] = await tx
        .insert(task)
        // assignNotifiedAt остаётся NULL по умолчанию: если исполнитель задан,
        // это означает «пуш о назначении ещё положен».
        .values({
          title: input.title,
          description: input.description ?? null,
          ownerKind: input.ownerKind,
          ownerRef: ownerRef.length > 0 ? ownerRef : null,
          domain: input.domain ?? null,
          due: input.due ?? null,
          source: input.source ?? null,
          priority: input.priority ?? "normal",
          createdBy: input.createdBy ?? actorRef,
          entityId: input.entityId ?? null,
          clientKey: input.clientKey ?? null,
        })
        .onConflictDoNothing({ target: task.clientKey })
        .returning();

      // Повтор по clientKey: заявка уже создана первой попыткой — возвращаем
      // её же, без второй записи в журнал.
      if (!created) {
        const [existing] = await tx
          .select()
          .from(task)
          .where(eq(task.clientKey, input.clientKey!))
          .limit(1);
        if (!existing) {
          throw new Error("Повтор заявки ещё сохраняется — попробуй ещё раз");
        }
        return existing;
      }

      await tx.insert(auditLog).values({
        actorKind: "system",
        actorRef,
        action: "task.create",
        target: created.id,
        after: created,
      });
      return created;
    });
  }

  async list(
    filter: {
      status?: Status;
      domain?: Domain;
      ownerKind?: "human" | "agent";
      ownerRef?: string;
      openOnly?: boolean;
    } = {},
  ): Promise<TaskRow[]> {
    const conditions: SQL[] = [];
    if (filter.status) conditions.push(eq(task.status, filter.status));
    if (filter.domain) conditions.push(eq(task.domain, filter.domain));
    if (filter.ownerKind) conditions.push(eq(task.ownerKind, filter.ownerKind));
    if (filter.ownerRef) conditions.push(eq(task.ownerRef, filter.ownerRef));
    // «Открытые» — то, что реально в работе; закрытое не должно засорять список.
    if (filter.openOnly) {
      conditions.push(ne(task.status, "done"));
      conditions.push(ne(task.status, "cancelled"));
    }

    return (
      this.db
        .select()
        .from(task)
        .where(conditions.length ? and(...conditions) : undefined)
        // Сначала срочное и с ближайшим сроком: список читается сверху вниз.
        .orderBy(asc(task.due), desc(task.priority), asc(task.createdAt))
        .limit(300)
    );
  }

  async byId(id: string): Promise<TaskRow> {
    const [row] = await this.db.select().from(task).where(eq(task.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Задача ${id} не найдена`);
    return row;
  }

  /** Задачи одного исполнителя — то, что сотрудник видит в боте. */
  mine(ownerKind: "human" | "agent", ownerRef: string): Promise<TaskRow[]> {
    return this.list({ ownerKind, ownerRef, openOnly: true });
  }

  /**
   * Атомарно забрать одну назначенную агенту задачу в конкретный прогон.
   *
   * UPDATE с lease-предикатом — сама точка конкурентного выбора: при двух
   * worker PostgreSQL повторно проверит WHERE после row-lock, и второй получит
   * null, не дойдя до LLM. Протухший lease получает новый UUID и generation.
   */
  async claimAgentRun(
    id: string,
    agentName: string,
    now = new Date(),
  ): Promise<ClaimedAgentRun | null> {
    const runId = randomUUID();
    const executionAttemptId = randomUUID();
    const staleBefore = new Date(now.getTime() - TasksService.AGENT_RUN_LEASE_MS);
    return this.db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(task)
        .set({
          status: "in_progress",
          agentRunId: runId,
          agentExecutionAttemptId: sql`coalesce(${task.agentExecutionAttemptId}, ${executionAttemptId}::uuid)`,
          agentExecutionRetryAt: null,
          agentRunGeneration: sql`${task.agentRunGeneration} + 1`,
          agentRunClaimedAt: now,
        })
        .where(
          and(
            eq(task.id, id),
            eq(task.ownerKind, "agent"),
            eq(task.ownerRef, agentName),
            ne(task.status, "done"),
            ne(task.status, "cancelled"),
            isNull(task.agentExecutionBlockedAt),
            or(isNull(task.agentExecutionRetryAt), lte(task.agentExecutionRetryAt, now)),
            or(
              isNull(task.agentRunId),
              isNull(task.agentRunClaimedAt),
              lte(task.agentRunClaimedAt, staleBefore),
            ),
          ),
        )
        .returning();
      if (!claimed) return null;

      await tx.insert(auditLog).values({
        actorKind: "agent",
        actorRef: `agent:${agentName}`,
        action: "task.agent_run.claimed",
        target: id,
        after: claimed,
      });
      const [ready] = await tx
        .select()
        .from(taskAgentExecution)
        .where(
          and(
            eq(taskAgentExecution.taskId, id),
            eq(taskAgentExecution.executionAttemptId, claimed.agentExecutionAttemptId!),
            eq(taskAgentExecution.status, "ready"),
          ),
        )
        .limit(1);
      return { ...claimed, agentCheckpoint: ready ? checkpointView(ready) : null };
    });
  }

  /**
   * Durable граница сразу после результата навыка и до любых side effects.
   * runId только ограждает текущего worker; идентичность результата —
   * executionAttemptId + canonical checkpoint hash.
   */
  async checkpointAgentRun(
    id: string,
    input: AgentRunCheckpointInput,
    now = new Date(),
  ): Promise<AgentRunCheckpointResult> {
    const agentName = input.agentName.trim();
    const skill = input.skill.trim();
    if (skill.length === 0) throw new BadRequestException("skill не может быть пустым");
    const payload = checkpointPayload(input);
    if (input.kind === "proposal" && typeof payload.action !== "string") {
      throw new BadRequestException("proposal обязан содержать action");
    }
    if (typeof payload.action === "string" && payload.action.length > 512) {
      throw new BadRequestException("action не может быть длиннее 512 символов");
    }

    return this.db.transaction(async (tx) => {
      const lockedTask = await this.lockTask(tx, id);
      this.assertAgentRunFence(lockedTask, { ...input, agentName });
      const inputHash = taskInputHash(lockedTask);
      const hash = canonicalHash({
        schemaVersion: 1,
        taskId: id,
        executionAttemptId: input.executionAttemptId,
        agentName,
        skill,
        taskInputHash: inputHash,
        checkpoint: payload,
      });

      const existing = await this.lockExecution(tx, input.executionAttemptId);
      if (existing) {
        if (
          existing.taskId !== id ||
          existing.agentName !== agentName ||
          existing.checkpointHash !== hash
        ) {
          throw new ConflictException("executionAttemptId уже связан с другим checkpoint payload");
        }
        if (existing.status !== "ready") {
          throw new ConflictException(
            existing.status === "committed"
              ? "Результат этой попытки уже committed"
              : "Эта попытка была abandoned владельцем",
          );
        }
        return { checkpointed: true, replay: true, checkpoint: checkpointView(existing) };
      }

      const [created] = await tx
        .insert(taskAgentExecution)
        .values({
          taskId: id,
          executionAttemptId: input.executionAttemptId,
          agentName,
          skill,
          schemaVersion: 1,
          taskInputHash: inputHash,
          checkpointKind: input.kind,
          checkpointPayload: payload,
          checkpointHash: hash,
          status: "ready",
          updatedAt: now,
        })
        .returning();
      if (!created) throw new Error("Checkpoint не сохранился");
      return { checkpointed: true, replay: false, checkpoint: checkpointView(created) };
    });
  }

  private assertOutcomeMatchesCheckpoint(
    execution: TaskAgentExecutionRow,
    outcome: JsonObject,
  ): void {
    const checkpoint = jsonObject(execution.checkpointPayload);
    const outcomeKind = outcome.kind;
    if (execution.checkpointKind === "no_signal") {
      if (outcomeKind !== "no_signal") {
        throw new ConflictException("no_signal checkpoint нельзя commit как действие");
      }
      return;
    }
    if (execution.checkpointKind !== "proposal") {
      throw new ConflictException("Неизвестный kind сохранённого checkpoint");
    }
    if (
      outcomeKind !== "no_change" &&
      outcomeKind !== "approval_requested" &&
      outcomeKind !== "executed"
    ) {
      throw new ConflictException("proposal checkpoint нельзя commit как no_signal");
    }
    if (typeof outcome.action !== "string") {
      throw new BadRequestException("Результат proposal обязан содержать action");
    }
    const checkpointProposal = canonicalHash({
      action: checkpoint.action,
      ...(checkpoint.facts !== undefined ? { facts: checkpoint.facts } : {}),
      ...(checkpoint.next !== undefined ? { next: checkpoint.next } : {}),
    });
    const committedProposal = canonicalHash({
      action: outcome.action,
      ...(outcome.facts !== undefined ? { facts: outcome.facts } : {}),
      ...(outcome.next !== undefined ? { next: outcome.next } : {}),
    });
    if (checkpointProposal !== committedProposal) {
      throw new ConflictException("Commit payload не совпадает с durable checkpoint");
    }
    if (outcomeKind === "approval_requested" && outcome.tier === undefined) {
      throw new BadRequestException("approval_requested обязан содержать tier");
    }
  }

  private async actionCapReached(tx: Tx, agentName: string, now: Date): Promise<boolean> {
    const cap = appConfig.agentDailyActionCap;
    if (cap <= 0) return false;
    const day = tashkentDay(now);
    const dayStart = tashkentDayStartOf(now);
    const nextDay = new Date(dayStart.getTime() + 86_400_000);
    const lockKey = `agent-action-cap:${agentName}:${day}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    const [row] = await tx
      .select({ count: sql<number>`count(*)` })
      .from(event)
      .where(
        and(
          eq(event.source, `agent:${agentName}`),
          eq(event.type, "agent.action"),
          gte(event.occurredAt, dayStart),
          lt(event.occurredAt, nextDay),
        ),
      );
    return Number(row?.count ?? 0) >= cap;
  }

  private replayCommittedExecution(
    execution: TaskAgentExecutionRow,
    outcomeHash: string,
  ): AgentRunCommitResult {
    if (execution.outcomeHash !== outcomeHash) {
      throw new ConflictException("Committed execution уже имеет другой outcome payload");
    }
    const stored = jsonObject(execution.outcomePayload);
    const input = jsonObject(stored.input);
    const result = jsonObject(stored.result);
    if (typeof input.note !== "string") {
      throw new Error("Committed execution не содержит сохранённый resultNote");
    }
    return {
      committed: true,
      capped: false,
      replay: true,
      taskId: execution.taskId,
      executionAttemptId: execution.executionAttemptId,
      status: "done",
      resultNote: input.note,
      ...(execution.approvalId !== null ? { approvalId: execution.approvalId } : {}),
      ...(typeof result.outboxDeliveryId === "string"
        ? { outboxDeliveryId: result.outboxDeliveryId }
        : {}),
    };
  }

  /**
   * Единственная atomic commit-точка outcome: task, approval/events/memory,
   * maintenance hook и Notion outbox либо фиксируются все, либо ни один.
   */
  async commitAgentRun(
    id: string,
    input: AgentRunCommitInput,
    now = new Date(),
  ): Promise<AgentRunCommitResult> {
    const agentName = input.agentName.trim();
    const outcome = commitPayload(input);
    if (typeof outcome.note !== "string" || outcome.note.length === 0) {
      throw new BadRequestException("note не может быть пустым");
    }
    const resultNote = outcome.note;

    return this.db.transaction(async (tx) => {
      // Единый lock order для checkpoint/commit/retry: task → execution.
      const lockedTask = await this.lockTask(tx, id);
      const execution = await this.lockExecution(tx, input.executionAttemptId);
      if (!execution || execution.taskId !== id || execution.agentName !== agentName) {
        throw new ConflictException("Durable checkpoint этой попытки не найден");
      }

      const hash = canonicalHash({
        schemaVersion: 1,
        taskId: id,
        agentName,
        executionAttemptId: input.executionAttemptId,
        checkpointHash: execution.checkpointHash,
        outcome,
      });
      if (execution.status === "committed") {
        return this.replayCommittedExecution(execution, hash);
      }
      if (execution.status === "abandoned") {
        throw new ConflictException("Execution abandoned владельцем; нужен новый claim");
      }

      this.assertAgentRunFence(lockedTask, { ...input, agentName });
      if (execution.taskInputHash !== taskInputHash(lockedTask)) {
        const reason = "Задача изменилась после durable checkpoint; нужен owner retry";
        const [blocked] = await tx
          .update(task)
          .set({
            status: "todo",
            agentRunId: null,
            agentRunClaimedAt: null,
            agentExecutionRetryAt: null,
            agentExecutionBlockedAt: now,
            agentExecutionBlockedReason: reason,
          })
          .where(
            and(
              eq(task.id, id),
              eq(task.agentRunId, input.runId),
              eq(task.agentExecutionAttemptId, input.executionAttemptId),
              ne(task.status, "done"),
              ne(task.status, "cancelled"),
            ),
          )
          .returning();
        if (!blocked) throw new ConflictException("Lease потерян во время input-hash проверки");
        await tx.insert(auditLog).values({
          actorKind: "agent",
          actorRef: `agent:${agentName}`,
          action: "task.agent_execution.blocked",
          target: id,
          before: lockedTask,
          after: blocked,
        });
        return {
          committed: false,
          capped: false,
          replay: false,
          taskId: id,
          executionAttemptId: input.executionAttemptId,
          status: "blocked",
        };
      }
      this.assertOutcomeMatchesCheckpoint(execution, outcome);

      const actionOutcome = outcome.kind === "approval_requested" || outcome.kind === "executed";
      if (actionOutcome && (await this.actionCapReached(tx, agentName, now))) {
        const retryAt = new Date(tashkentDayStartOf(now).getTime() + 86_400_000);
        const [released] = await tx
          .update(task)
          .set({
            status: "todo",
            agentRunId: null,
            agentRunClaimedAt: null,
            agentExecutionRetryAt: retryAt,
            agentExecutionBlockedAt: null,
            agentExecutionBlockedReason: null,
          })
          .where(
            and(
              eq(task.id, id),
              eq(task.agentRunId, input.runId),
              eq(task.agentExecutionAttemptId, input.executionAttemptId),
              ne(task.status, "done"),
              ne(task.status, "cancelled"),
            ),
          )
          .returning();
        if (!released) throw new ConflictException("Lease потерян во время cap-check");
        await tx.insert(auditLog).values({
          actorKind: "agent",
          actorRef: `agent:${agentName}`,
          action: "task.agent_run.action_capped",
          target: id,
          before: lockedTask,
          after: released,
        });
        return {
          committed: false,
          capped: true,
          replay: false,
          taskId: id,
          executionAttemptId: input.executionAttemptId,
          status: "todo",
          retryAt: retryAt.toISOString(),
        };
      }

      const action = typeof outcome.action === "string" ? outcome.action : undefined;
      const facts = outcome.facts !== undefined ? jsonObject(outcome.facts) : {};
      const next = Array.isArray(outcome.next)
        ? outcome.next.filter((item): item is string => typeof item === "string")
        : undefined;
      const source = `agent:${agentName}`;
      const keyBase = `task:${id}:execution:${input.executionAttemptId}`;
      let approvalId: string | undefined;

      await tx.insert(event).values({
        source,
        type: "agent.run",
        payload: canonicalValue({
          taskId: id,
          executionAttemptId: input.executionAttemptId,
          skill: execution.skill,
          outcome: outcome.kind,
          ...(outcome.tier !== undefined ? { tier: outcome.tier } : {}),
        }),
        clientKey: `${keyBase}:event:agent-run`,
        occurredAt: now,
      });

      if (outcome.kind === "approval_requested") {
        const [createdApproval] = await tx
          .insert(approval)
          .values({
            agent: agentName,
            action: action!,
            tier: outcome.tier as Tier,
            payload: canonicalValue({
              taskId: id,
              executionAttemptId: input.executionAttemptId,
              skill: execution.skill,
              facts,
              ...(next !== undefined ? { next } : {}),
            }),
            clientKey: `${keyBase}:approval`,
          })
          .returning();
        if (!createdApproval) throw new Error("Approval не сохранился");
        approvalId = createdApproval.id;
        await tx.insert(event).values({
          source,
          type: "approval.requested",
          payload: { approvalId, action, tier: outcome.tier },
          clientKey: `${keyBase}:event:approval-requested`,
          occurredAt: now,
        });
        await tx.insert(auditLog).values({
          actorKind: "agent",
          actorRef: agentName,
          action: "approval.request",
          target: approvalId,
          after: createdApproval,
        });
      }

      if (actionOutcome) {
        await tx.insert(event).values({
          source,
          type: "agent.action",
          payload: canonicalValue({
            taskId: id,
            executionAttemptId: input.executionAttemptId,
            skill: execution.skill,
            action,
            ...(approvalId !== undefined ? { approvalId } : {}),
            ...(outcome.kind === "executed" ? { executed: true } : {}),
            ...(outcome.executionDetail !== undefined ? { verified: outcome.executionDetail } : {}),
          }),
          clientKey: `${keyBase}:event:agent-action`,
          occurredAt: now,
        });
        if (typeof outcome.memorySignature === "string") {
          await tx.insert(event).values({
            source,
            type: `agent.memory:${execution.skill}`,
            payload: { signature: outcome.memorySignature },
            clientKey: `${keyBase}:event:memory`,
            occurredAt: now,
          });
        }
      }

      let outboxDeliveryId: string | undefined;
      if (actionOutcome) {
        const payload = notionReportPayload(
          execution,
          outcome.kind as "approval_requested" | "executed",
          action!,
          facts,
        );
        const [delivery] = await tx
          .insert(outboxDelivery)
          .values({
            key: `${keyBase}:notion-report`,
            taskAgentExecutionId: execution.id,
            destination: "notion-report",
            payload,
            payloadHash: canonicalHash(payload),
            status: "pending",
          })
          .returning();
        if (!delivery) throw new Error("Notion outbox intent не сохранился");
        outboxDeliveryId = delivery.id;
      }

      const [closedTask] = await tx
        .update(task)
        .set({
          status: "done",
          resultNote,
          completedAt: now,
          closedBy: source,
          agentRunId: null,
          agentRunClaimedAt: null,
          agentExecutionRetryAt: null,
          agentExecutionBlockedAt: null,
          agentExecutionBlockedReason: null,
        })
        .where(
          and(
            eq(task.id, id),
            eq(task.agentRunId, input.runId),
            eq(task.agentExecutionAttemptId, input.executionAttemptId),
            ne(task.status, "done"),
            ne(task.status, "cancelled"),
          ),
        )
        .returning();
      if (!closedTask) throw new ConflictException("Lease потерян перед atomic commit");
      await tx.insert(auditLog).values({
        actorKind: "agent",
        actorRef: source,
        action: "task.done",
        target: id,
        before: lockedTask,
        after: closedTask,
      });
      await this.recordMaintenanceFact(tx, closedTask, source);

      const durableResult = {
        taskId: id,
        executionAttemptId: input.executionAttemptId,
        ...(approvalId !== undefined ? { approvalId } : {}),
        ...(outboxDeliveryId !== undefined ? { outboxDeliveryId } : {}),
      };
      const [committed] = await tx
        .update(taskAgentExecution)
        .set({
          status: "committed",
          outcomePayload: canonicalValue({ input: outcome, result: durableResult }),
          outcomeHash: hash,
          approvalId: approvalId ?? null,
          committedAt: now,
          updatedAt: now,
        })
        .where(and(eq(taskAgentExecution.id, execution.id), eq(taskAgentExecution.status, "ready")))
        .returning();
      if (!committed) throw new ConflictException("Checkpoint уже завершён другим commit");

      return {
        committed: true,
        capped: false,
        replay: false,
        taskId: id,
        executionAttemptId: input.executionAttemptId,
        status: "done",
        resultNote,
        ...(approvalId !== undefined ? { approvalId } : {}),
        ...(outboxDeliveryId !== undefined ? { outboxDeliveryId } : {}),
      };
    });
  }

  /**
   * Освободить только СВОЙ прогон. UUID в WHERE — CAS: worker старой
   * generation не может снять lease, который уже перехватил новый worker.
   */
  async releaseAgentRun(
    id: string,
    agentName: string,
    runId: string,
    executionAttemptId: string,
    reason?: "budget_denied" | "execution_unknown" | "action_capped" | "unsupported",
    detail?: string,
    now = new Date(),
  ): Promise<TaskRow | null> {
    return this.db.transaction(async (tx) => {
      const nextTashkentDay = new Date(tashkentDayStartOf(now).getTime() + 86_400_000);
      let safeBudgetRetry = false;
      if (reason === "budget_denied") {
        const prefix = `task:${id}:execution:${executionAttemptId}:%`;
        const [started] = await tx
          .select({ id: llmSpend.id })
          .from(llmSpend)
          .where(and(sql`${llmSpend.requestKey} like ${prefix}`, ne(llmSpend.status, "denied")))
          .limit(1);
        safeBudgetRetry = started === undefined;
      }
      const shouldBlock =
        reason === "execution_unknown" ||
        reason === "unsupported" ||
        (reason === "budget_denied" && !safeBudgetRetry);
      const blockedReason =
        detail?.trim().slice(0, 1000) ||
        (reason === "budget_denied"
          ? "budget denial после уже начатой metered-попытки"
          : reason === "unsupported"
            ? "у агента нет подходящего навыка; нужен owner retry"
            : "исход предыдущей metered-попытки неизвестен");
      const [released] = await tx
        .update(task)
        .set({
          status: "todo",
          agentRunId: null,
          agentRunClaimedAt: null,
          ...(reason === "budget_denied" && safeBudgetRetry
            ? {
                // Denial доказал, что provider dispatch не было. Новую
                // попытку разрешаем только после смены ledger-day, иначе
                // минутный poll плодил бы вечные denied rows.
                agentExecutionAttemptId: null,
                agentExecutionRetryAt: nextTashkentDay,
                agentExecutionBlockedAt: null,
                agentExecutionBlockedReason: null,
              }
            : {}),
          ...(reason === "action_capped"
            ? {
                // Outcome уже может лежать в durable checkpoint. Attempt не
                // вращаем: после полуночи claim вернёт тот же результат и не
                // вызовет provider повторно.
                agentExecutionRetryAt: nextTashkentDay,
                agentExecutionBlockedAt: null,
                agentExecutionBlockedReason: null,
              }
            : {}),
          ...(shouldBlock
            ? {
                agentExecutionBlockedAt: now,
                agentExecutionBlockedReason: blockedReason,
              }
            : {}),
        })
        .where(
          and(
            eq(task.id, id),
            eq(task.ownerKind, "agent"),
            eq(task.ownerRef, agentName),
            eq(task.agentRunId, runId),
            eq(task.agentExecutionAttemptId, executionAttemptId),
            ne(task.status, "done"),
            ne(task.status, "cancelled"),
          ),
        )
        .returning();
      if (!released) return null;

      await tx.insert(auditLog).values({
        actorKind: "agent",
        actorRef: `agent:${agentName}`,
        action: "task.agent_run.released",
        target: id,
        after: released,
      });
      return released;
    });
  }

  /**
   * Продлить lease только текущей generation. Без heartbeat длинный
   * LLM/embedding-прогон выглядел бы stale через 15 минут, хотя worker жив.
   */
  async heartbeatAgentRun(
    id: string,
    agentName: string,
    runId: string,
    now = new Date(),
  ): Promise<boolean> {
    const [renewed] = await this.db
      .update(task)
      .set({ agentRunClaimedAt: now })
      .where(
        and(
          eq(task.id, id),
          eq(task.ownerKind, "agent"),
          eq(task.ownerRef, agentName),
          eq(task.agentRunId, runId),
          ne(task.status, "done"),
          ne(task.status, "cancelled"),
        ),
      )
      .returning({ id: task.id });
    return renewed !== undefined;
  }

  /**
   * Явное решение владельца начать новую оплачиваемую попытку после replay.
   * Автоматика этого не делает: без durable result/outbox она не знает,
   * завершился ли прошлый provider call и был ли его ответ доставлен.
   */
  async retryBlockedAgentExecution(id: string): Promise<TaskRow> {
    return this.db.transaction(async (tx) => {
      const before = await this.lockTask(tx, id);
      if (
        before.ownerKind !== "agent" ||
        before.agentExecutionBlockedAt === null ||
        before.status === "done" ||
        before.status === "cancelled"
      ) {
        throw new ConflictException("У задачи нет заблокированной LLM-попытки для retry");
      }

      if (before.agentExecutionAttemptId !== null) {
        const execution = await this.lockExecution(tx, before.agentExecutionAttemptId);
        if (execution?.status === "ready") {
          const [abandoned] = await tx
            .update(taskAgentExecution)
            .set({
              status: "abandoned",
              abandonedAt: new Date(),
              abandonReason: "owner_retry_after_block",
              updatedAt: new Date(),
            })
            .where(
              and(eq(taskAgentExecution.id, execution.id), eq(taskAgentExecution.status, "ready")),
            )
            .returning();
          if (!abandoned) {
            throw new ConflictException("Checkpoint уже завершён другим commit");
          }
        }
      }

      const [updated] = await tx
        .update(task)
        .set({
          status: "todo",
          agentRunId: null,
          agentRunClaimedAt: null,
          agentExecutionAttemptId: null,
          agentExecutionRetryAt: null,
          agentExecutionBlockedAt: null,
          agentExecutionBlockedReason: null,
        })
        .where(
          and(
            eq(task.id, id),
            eq(task.ownerKind, "agent"),
            isNotNull(task.agentExecutionBlockedAt),
            ...(before.agentExecutionAttemptId !== null
              ? [eq(task.agentExecutionAttemptId, before.agentExecutionAttemptId)]
              : [isNull(task.agentExecutionAttemptId)]),
            ne(task.status, "done"),
            ne(task.status, "cancelled"),
          ),
        )
        .returning();
      if (!updated) {
        throw new ConflictException("Заблокированная попытка изменилась во время retry");
      }
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef: "owner",
        action: "task.agent_execution.retry",
        target: id,
        before,
        after: updated,
      });
      return updated;
    });
  }

  /** Просроченное: срок прошёл, а задача ещё не закрыта. */
  async overdue(): Promise<TaskRow[]> {
    return this.db
      .select()
      .from(task)
      .where(and(lt(task.due, new Date()), ne(task.status, "done"), ne(task.status, "cancelled")))
      .orderBy(asc(task.due))
      .limit(100);
  }

  /**
   * Смена статуса.
   *
   * Условие «статус ещё не такой» стоит в самом UPDATE: два одновременных
   * нажатия «Готово» иначе оба отчитались бы об успехе, а в журнале осталась
   * бы одна запись с непонятным автором.
   */
  async setStatus(
    id: string,
    status: Status,
    actorRef = "owner",
    resultNote?: string,
    expectedAgentRunId?: string,
  ): Promise<TaskRow> {
    return this.db.transaction(async (tx) => {
      // Отчёт и время закрытия проставляются только при закрытии: иначе
      // «взял в работу» затирал бы отчёт о прошлом выполнении.
      const patch: Record<string, unknown> = { status };
      if (status === "done") {
        patch.completedAt = new Date();
        // Кто фактически закрыл: лента действий не должна приписывать
        // сотруднику закрытие, сделанное владельцем из панели.
        patch.closedBy = actorRef;
        if (resultNote !== undefined && resultNote.trim().length > 0) {
          patch.resultNote = resultNote.trim();
        }
      }

      const conditions: SQL[] = [eq(task.id, id), ne(task.status, status)];
      if (expectedAgentRunId) {
        conditions.push(eq(task.agentRunId, expectedAgentRunId));
        conditions.push(ne(task.status, "done"), ne(task.status, "cancelled"));
      }
      const [updated] = await tx
        .update(task)
        .set(patch)
        .where(and(...conditions))
        .returning();

      if (!updated) {
        const [row] = await tx.select().from(task).where(eq(task.id, id));
        if (!row) throw new NotFoundException(`Задача ${id} не найдена`);
        if (expectedAgentRunId) {
          if (row.agentRunId !== expectedAgentRunId) {
            throw new ConflictException("Прогон агента уже заменён новой generation");
          }
          if (row.status !== status) {
            throw new ConflictException(
              `Задача уже в статусе ${row.status}; прогон не может её закрыть`,
            );
          }
        }
        return row; // статус уже такой — повторное нажатие не ошибка
      }

      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: `task.${status}`,
        target: id,
        after: updated,
      });

      // Закрытие авто-задачи ТО — это и есть факт работы: он ложится в журнал
      // обслуживания и двигает якорь норматива в ТОЙ ЖЕ транзакции. Guard
      // «статус ещё не такой» выше делает повторное «Готово» безопасным.
      if (status === "done") {
        await this.recordMaintenanceFact(tx, updated, actorRef);
      }
      return updated;
    });
  }

  /**
   * Хук «закрыл задачу ТО → запись в журнале обслуживания».
   *
   * Раньше цепочка рвалась ровно здесь: monitor заводил задачу по нормативу,
   * техник закрывал её в боте — а `maintenance_log` оставался пуст и якорь
   * `dueOn` не двигался, назавтра рождая ту же задачу снова.
   *
   * Двойной счёт закрыт с двух сторон: `clientKey = task:<id>` ловит ретраи,
   * а проверка «по этому нормативу сегодня уже отмечено» — случай, когда
   * техник успел нажать «Сделал» в «🗓 Графиках» и потом закрыл задачу.
   */
  private async recordMaintenanceFact(tx: Tx, updated: TaskRow, actorRef: string): Promise<void> {
    const m = MAINT_SOURCE.exec(updated.source ?? "");
    if (!m) return;
    const planId = m[1]!;

    // План удалён или выключен — закрытие задачи падать не должно.
    const [plan] = await tx
      .select()
      .from(maintenancePlan)
      .where(eq(maintenancePlan.id, planId))
      .limit(1);
    if (!plan) return;

    const today = todayInTz();
    const [already] = await tx
      .select({ id: maintenanceLog.id })
      .from(maintenanceLog)
      .where(
        and(
          eq(maintenanceLog.planId, planId),
          eq(maintenanceLog.performedOn, today),
          isNotNull(maintenanceLog.outcome),
        ),
      )
      .limit(1);
    if (already) return;

    await this.maintenance.createLog(
      {
        entityId: plan.entityId,
        kind: plan.kind,
        ...(plan.partKind !== null ? { partKind: plan.partKind } : {}),
        planId,
        taskId: updated.id,
        outcome: "done",
        performedOn: today,
        ...(updated.resultNote !== null ? { note: updated.resultNote } : {}),
        clientKey: `task:${updated.id}`,
        createdBy: actorRef,
      },
      tx,
    );
  }

  /**
   * Правка полей задачи владельцем из панели: переназначить исполнителя,
   * сменить приоритет, срок, заголовок, описание. Меняем ТОЛЬКО переданные поля
   * (частичное обновление) — статус и отчёт живут своим потоком (setStatus/rate)
   * и здесь не трогаются. Пустой патч → возвращаем задачу без записи в журнал.
   */
  async edit(
    id: string,
    patch: {
      title?: string;
      description?: string | null;
      ownerKind?: "human" | "agent";
      ownerRef?: string | null;
      priority?: Priority;
      due?: Date | null;
      entityId?: string | null;
    },
    actorRef = "owner",
  ): Promise<TaskRow> {
    const set: Record<string, unknown> = {};
    if (patch.title !== undefined) {
      const t = patch.title.trim();
      if (t.length === 0) throw new BadRequestException("Заголовок не может быть пустым");
      set.title = t;
    }
    if (patch.description !== undefined) {
      const d = (patch.description ?? "").trim();
      set.description = d.length > 0 ? d : null;
    }
    if (patch.ownerKind !== undefined) set.ownerKind = patch.ownerKind;
    if (patch.ownerRef !== undefined) {
      const r = (patch.ownerRef ?? "").trim();
      set.ownerRef = r.length > 0 ? r : null;
    }
    if (patch.priority !== undefined) set.priority = patch.priority;
    if (patch.due !== undefined) set.due = patch.due;
    if (patch.entityId !== undefined) set.entityId = patch.entityId;

    if (Object.keys(set).length === 0) return this.byId(id);

    // Право назначения требуется только при реальной смене исполнителя:
    // правка срока, текста или повторная отправка того же ownerRef не должны
    // запираться за менеджерской ролью.
    const before = await this.byId(id);
    const ownerRefChanged = set.ownerRef !== undefined && set.ownerRef !== before.ownerRef;
    const ownerKindChanged = set.ownerKind !== undefined && set.ownerKind !== before.ownerKind;
    if (ownerRefChanged) {
      await this.assertCan(actorRef, "tasks.assign");
      set.assignNotifiedAt = null;
      set.agentRunId = null;
      set.agentRunClaimedAt = null;
    }
    if (ownerKindChanged) {
      set.agentRunId = null;
      set.agentRunClaimedAt = null;
    }
    if ((ownerRefChanged || ownerKindChanged) && before.agentExecutionAttemptId != null) {
      // Общий SERVICE_TOKEN не вращает оплачиваемую attempt. Но и отдавать
      // новому агенту checkpoint прежнего нельзя: claim должен стоять до
      // явного owner-only retry, который abandon-ит ready history.
      set.agentExecutionRetryAt = null;
      set.agentExecutionBlockedAt = new Date();
      set.agentExecutionBlockedReason =
        "Исполнитель изменён после начала LLM-попытки; нужен owner retry";
    }

    return this.db.transaction(async (tx) => {
      const [updated] = await tx.update(task).set(set).where(eq(task.id, id)).returning();
      if (!updated) throw new NotFoundException(`Задача ${id} не найдена`);
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "task.edit",
        target: id,
        after: updated,
      });
      return updated;
    });
  }

  /**
   * Заводит задачу, если такой ещё нет на сегодня.
   *
   * Нужно для повторяющихся задач: планировщик может сработать дважды
   * (перезапуск контейнера, наложение расписаний), и без этой проверки
   * владелец каждое утро получал бы по три одинаковых «сделать инвентаризацию».
   */
  /**
   * Автомат в эксплуатации? Объект без карточки автомата (техника, помещение,
   * договор) считается рабочим: признак заводился для парка, а не для всего
   * реестра, и молчаливое исключение всего остального было бы хуже задачи.
   */
  private async machineIsOperationalCheck(entityId: string): Promise<boolean> {
    const [card] = await this.db
      .select({ status: machineCard.status })
      .from(machineCard)
      .where(eq(machineCard.entityId, entityId))
      .limit(1);
    return machineIsOperational(card?.status);
  }

  async ensureForDay(input: CreateTaskInput & { dayKey: string }): Promise<TaskRow | null> {
    // Автомату вне эксплуатации повторяющиеся задачи не ставим.
    //
    // Правило соблюдает монитор графиков — он спрашивает состояние и
    // пропускает такие строки. Но правило, которое живёт у ОДНОГО вызывающего,
    // держится только пока вызывающий один: `POST /tasks/ensure-day` открыт, и
    // следующий источник повторяющихся задач обойдёт его молча, ничего не
    // нарушив явно.
    //
    // Проверка здесь — страховка, а не замена: монитор по-прежнему считает
    // пропуски и называет причину, потому что ему есть что сказать владельцу.
    // Core же просто не заводит работу, которую физически некому выполнить.
    if (input.entityId && !(await this.machineIsOperationalCheck(input.entityId))) return null;

    const source = `${input.source ?? "recurring"}:${input.dayKey}`;
    // Было select-then-insert: два тика монитора в одну секунду проходили
    // проверку оба и создавали две задачи на один день. Ставку делает БД —
    // частичный уникальный индекс task_source_key (миграция 0040).
    // ownerRef: та же нормализация "" → null, что в create() и PATCH — пустая
    // строка от клиента не должна осесть «занятой» задачей.
    const ownerRef = (input.ownerRef ?? "").trim();
    const [created] = await this.db
      .insert(task)
      .values({
        title: input.title,
        description: input.description ?? null,
        ownerKind: input.ownerKind,
        ownerRef: ownerRef.length > 0 ? ownerRef : null,
        domain: input.domain ?? null,
        due: input.due ?? null,
        source,
        priority: input.priority ?? "normal",
        createdBy: input.createdBy ?? "scheduler",
        entityId: input.entityId ?? null,
      })
      .onConflictDoNothing({
        // ПРЕДИКАТ ОБЯЗАТЕЛЕН (R-G-2): индекс `task_source_key` ЧАСТИЧНЫЙ, и
        // из голого `target` Postgres его не выводит — `42P10`, который фильтр
        // исключений (класс не 22/23) отдаёт как 500. Так эта вставка не
        // проходила НИ РАЗУ: задач от монитора в проде 0 при 19 попытках в
        // сутки (замер 26.08.2026).
        target: task.source,
        where: TASK_SOURCE_DAY_PREDICATE,
      })
      .returning();
    if (!created) return null;

    await this.db.insert(auditLog).values({
      actorKind: "system",
      actorRef: "scheduler",
      action: "task.create",
      target: created.id,
      after: created,
    });
    return created;
  }

  // ── Общий пул: свободные задачи ────────────────────────────────────────────
  //
  // Закрепления сотрудников за объектами нет — все работают по всему парку,
  // поэтому автосозданная задача рождается без исполнителя и её разбирают.
  // Это нормальное состояние, а не дефект настройки.

  /** Свободные задачи: никто не взял, но работа стоит. */
  unassigned(limit = 50): Promise<TaskRow[]> {
    return this.db
      .select()
      .from(task)
      .where(
        and(
          eq(task.ownerKind, "human"),
          isNull(task.ownerRef),
          ne(task.status, "done"),
          ne(task.status, "cancelled"),
        ),
      )
      .orderBy(asc(task.due), desc(task.priority), asc(task.createdAt))
      .limit(limit);
  }

  /**
   * Взять свободную задачу.
   *
   * Двое, нажавших «Беру» одновременно, — это не редкий случай, а обычное утро
   * при одном общем дайджесте. Гонку разрешает БД: `WHERE owner_ref IS NULL`
   * внутри самого UPDATE. Проигравший получает null и увидит имя победителя,
   * а не ошибку.
   */
  async claim(id: string, personId: string, now = new Date()): Promise<TaskRow | null> {
    return this.db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(task)
        // Человек взял задачу сам — рассказывать ему о собственном действии не надо.
        .set({ ownerKind: "human", ownerRef: personId, assignNotifiedAt: now })
        .where(and(eq(task.id, id), eq(task.ownerKind, "human"), isNull(task.ownerRef)))
        .returning();
      if (!claimed) return null;

      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef: `person:${personId}`,
        action: "task.claimed",
        target: claimed.id,
        after: claimed,
      });
      return claimed;
    });
  }

  /**
   * Вернуть задачу в пул.
   *
   * Без этого техник, взявший задачу и застрявший (нет запчасти, точка
   * закрыта), молча блокирует её до срока: другим она уже не видна как
   * свободная, а он её не сделает.
   */
  async release(id: string, personId: string): Promise<TaskRow | null> {
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(task).where(eq(task.id, id)).limit(1);
      if (!before) throw new NotFoundException(`Задача ${id} не найдена`);
      // Отпустить можно только своё: иначе один сотрудник снимает задачу с другого.
      if (before.ownerRef !== personId) return null;

      const [freed] = await tx
        .update(task)
        .set({
          ownerRef: null,
          status: before.status === "in_progress" ? "todo" : before.status,
          assignNotifiedAt: null,
        })
        .where(eq(task.id, id))
        .returning();

      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef: `person:${personId}`,
        action: "task.released",
        target: id,
        before,
        after: freed,
      });
      return freed;
    });
  }

  /**
   * Приёмка сделанной работы менеджером. Статус остаётся `done`: приёмка —
   * отдельный факт поверх закрытия. Условие в UPDATE делает два одновременных
   * нажатия идемпотентными на уровне БД.
   */
  async confirm(id: string, actorRef: string, now = new Date()): Promise<TaskRow> {
    await this.assertCan(actorRef, "tasks.confirm");
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(task).where(eq(task.id, id)).limit(1);
      if (!row) throw new NotFoundException(`Задача ${id} не найдена`);
      if (row.status !== "done") {
        throw new BadRequestException("Подтвердить можно только сделанную задачу");
      }

      const patch: Record<string, unknown> = { confirmedAt: now, confirmedBy: actorRef };
      if (row.quality === null) patch.quality = "accepted";

      const [updated] = await tx
        .update(task)
        .set(patch)
        .where(and(eq(task.id, id), isNull(task.confirmedAt)))
        .returning();
      if (!updated) {
        // В гонке начальный SELECT мог увидеть старую строку. Возвращаем
        // актуальную принятую запись, но не пишем второй аудит и событие.
        const [current] = await tx.select().from(task).where(eq(task.id, id)).limit(1);
        return current ?? row;
      }

      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "task.confirmed",
        target: id,
        before: row,
        after: updated,
      });
      await tx.insert(event).values({
        source: "tasks",
        type: "task.confirmed",
        occurredAt: now,
        payload: {
          taskId: id,
          title: updated.title,
          ownerRef: updated.ownerRef,
          confirmedBy: actorRef,
          quality: updated.quality,
        },
      });
      return updated;
    });
  }

  /** Сделанные людьми, но ещё не принятые; дольше ожидающие идут первыми. */
  awaitingConfirmation(limit = TasksService.AWAITING_LIMIT): Promise<TaskRow[]> {
    return this.db
      .select()
      .from(task)
      .where(and(eq(task.status, "done"), isNull(task.confirmedAt), eq(task.ownerKind, "human")))
      .orderBy(asc(task.completedAt))
      .limit(limit);
  }

  // ── Переписка по задаче ────────────────────────────────────────────────────

  comments(taskId: string): Promise<CommentRow[]> {
    return this.db
      .select()
      .from(taskComment)
      .where(eq(taskComment.taskId, taskId))
      .orderBy(asc(taskComment.createdAt))
      .limit(200);
  }

  /** Комментарий = уточнение, вопрос или отчёт. Проверяем, что задача есть. */
  /**
   * Оценка сделанной задачи владельцем: отлично / принято / переделать.
   *
   * «Переделать» — не просто отметка: задача возвращается в работу, отчёт
   * остаётся в переписке, а напоминания включаются заново. Так качество
   * отмечается делом, а не забытым флажком.
   */
  async rate(
    id: string,
    quality: "excellent" | "accepted" | "redo",
    actorRef = "owner",
  ): Promise<TaskRow> {
    await this.assertCan(actorRef, "tasks.confirm");
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(task).where(eq(task.id, id));
      if (!row) throw new NotFoundException(`Задача ${id} не найдена`);
      if (row.status !== "done") {
        throw new BadRequestException("Оценить можно только сделанную задачу");
      }

      const patch: Record<string, unknown> = { quality };
      if (quality === "redo") {
        patch.status = "in_progress";
        patch.completedAt = null;
        patch.remindedAt = null; // напоминания должны включиться заново
        patch.redoNotifiedAt = null; // и сообщение о возврате должно уйти снова
        // Redo создаёт новую worker generation, но НЕ новый денежный attempt.
        // Если прошлый metered call уже существовал, replay поставит block, а
        // новую оплату разрешит только owner-token endpoint agent-run/retry.
        patch.agentRunId = null;
        patch.agentRunClaimedAt = null;
        if (row.ownerKind === "agent" && row.agentExecutionAttemptId !== null) {
          // Committed history immutable, а reuse старого attempt дал бы
          // заведомый ledger replay. Общий SERVICE_TOKEN не вращает оплату:
          // задача ждёт явного owner-only /agent-run/retry.
          patch.agentExecutionRetryAt = null;
          patch.agentExecutionBlockedAt = new Date();
          patch.agentExecutionBlockedReason =
            "Redo требует новой оплачиваемой попытки через owner retry";
        }
      }
      const [updated] = await tx.update(task).set(patch).where(eq(task.id, id)).returning();

      if (quality === "redo") {
        await tx.insert(taskComment).values({
          taskId: id,
          authorRef: actorRef,
          body: `Возвращено на доработку. Прошлый отчёт: ${row.resultNote ?? "—"}`,
        });
      }

      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: quality === "redo" ? "task.redo" : "task.rated",
        target: id,
        before: row,
        after: updated,
      });
      return updated;
    });
  }

  /** Кому ещё не сообщили о возврате на доработку — бот заберёт и доставит. */
  redoUnnotified(): Promise<TaskRow[]> {
    return this.db
      .select()
      .from(task)
      .where(
        and(
          eq(task.quality, "redo"),
          ne(task.status, "done"),
          ne(task.status, "cancelled"),
          isNull(task.redoNotifiedAt),
          eq(task.ownerKind, "human"),
          isNotNull(task.ownerRef),
        ),
      )
      .limit(50);
  }

  /** Отметка ставится ПОСЛЕ доставки — как у напоминаний: сбой сети не должен
   *  превращаться в «сотрудник так и не узнал». */
  async markRedoNotified(id: string): Promise<void> {
    await this.db.update(task).set({ redoNotifiedAt: new Date() }).where(eq(task.id, id));
  }

  /**
   * Кому ещё не сказали, что на него повесили задачу (R-P7-10).
   *
   * Зеркало `redoUnnotified`: та же пара «спросить кого — отметить доставку».
   * Момента здесь нет: в условии нет ни одного временнóго предиката.
   */
  assignUnnotified(limit = 50): Promise<TaskRow[]> {
    return this.db
      .select()
      .from(task)
      .where(
        and(
          eq(task.ownerKind, "human"),
          isNotNull(task.ownerRef),
          ne(task.status, "done"),
          ne(task.status, "cancelled"),
          isNull(task.assignNotifiedAt),
        ),
      )
      .limit(limit);
  }

  /** Отметка ставится ПОСЛЕ доставки: сбой сети не должен превращаться в
   *  «сотрудник так и не узнал». */
  async markAssignNotified(id: string, now = new Date()): Promise<void> {
    await this.db.update(task).set({ assignNotifiedAt: now }).where(eq(task.id, id));
  }

  async addComment(taskId: string, authorRef: string, body: string): Promise<CommentRow> {
    await this.byId(taskId);
    const [created] = await this.db
      .insert(taskComment)
      .values({ taskId, authorRef, body })
      .returning();
    return created;
  }

  // ── Контроль ───────────────────────────────────────────────────────────────

  /**
   * Кому пора напомнить: срок близко (или прошёл), задача открыта,
   * и раньше мы про неё не напоминали. `remindedAt` — защита от повторов:
   * без неё сотрудник получал бы одно и то же напоминание каждый час.
   */
  dueSoon(withinHours = 24): Promise<TaskRow[]> {
    const until = new Date(Date.now() + withinHours * 3600_000);
    return this.db
      .select()
      .from(task)
      .where(
        and(
          isNotNull(task.due),
          lt(task.due, until),
          ne(task.status, "done"),
          ne(task.status, "cancelled"),
          sql`${task.remindedAt} is null`,
        ),
      )
      .orderBy(asc(task.due))
      .limit(50);
  }

  /** Отметка «напомнили» — ставится после фактической отправки. */
  async markReminded(id: string): Promise<void> {
    await this.db.update(task).set({ remindedAt: new Date() }).where(eq(task.id, id));
  }

  /**
   * Картина по людям и агентам: что висит, что просрочено, что сделано за неделю.
   * Один запрос вместо трёх на каждого исполнителя — список может быть длинным.
   */
  async workload(): Promise<WorkloadRow[]> {
    // Дату передаём строкой с явным приведением: без ::timestamptz PostgreSQL
    // не может вывести тип параметра внутри count(case ...) и падает.
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const rows = await this.db
      .select({
        ownerKind: task.ownerKind,
        ownerRef: task.ownerRef,
        open: sql<number>`count(*) filter (where ${task.status} not in ('done','cancelled'))`.as(
          "open",
        ),
        overdue:
          sql<number>`count(*) filter (where ${task.status} not in ('done','cancelled') and ${task.due} < now())`.as(
            "overdue",
          ),
        doneLast7d:
          sql<number>`count(*) filter (where ${task.status} = 'done' and ${task.completedAt} >= ${weekAgo}::timestamptz)`.as(
            "done_last_7d",
          ),
        excellent: sql<number>`count(*) filter (where ${task.quality} = 'excellent')`.as(
          "excellent",
        ),
        redo: sql<number>`count(*) filter (where ${task.quality} = 'redo')`.as("redo"),
        doneOnTime:
          sql<number>`count(*) filter (where ${task.status} = 'done' and ${task.due} is not null and ${task.completedAt} <= ${task.due})`.as(
            "done_on_time",
          ),
        doneWithDue:
          sql<number>`count(*) filter (where ${task.status} = 'done' and ${task.due} is not null)`.as(
            "done_with_due",
          ),
      })
      .from(task)
      .groupBy(task.ownerKind, task.ownerRef);

    return rows.map((r) => ({
      ownerKind: r.ownerKind,
      ownerRef: r.ownerRef,
      open: Number(r.open ?? 0),
      overdue: Number(r.overdue ?? 0),
      doneLast7d: Number(r.doneLast7d ?? 0),
      excellent: Number(r.excellent ?? 0),
      redo: Number(r.redo ?? 0),
      doneOnTime: Number(r.doneOnTime ?? 0),
      doneWithDue: Number(r.doneWithDue ?? 0),
    }));
  }
}
