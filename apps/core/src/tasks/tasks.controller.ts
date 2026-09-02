import {
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Max,
  Min,
  ValidateIf,
} from "class-validator";
import { DOMAINS, type Domain } from "@mydon/shared";
import { DB, type Db } from "../db/db.module";
import { excludePersonal } from "../common/owner-enforcement";
import { OwnerActionGuard } from "../common/owner-action.guard";
import { TasksService } from "./tasks.service";

const STATUSES = ["todo", "in_progress", "done", "cancelled"] as const;
type Status = (typeof STATUSES)[number];
const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
type Priority = (typeof PRIORITIES)[number];

export class CreateTaskDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  title!: string;

  @IsIn(["human", "agent"], { message: "ownerKind: human или agent" })
  ownerKind!: "human" | "agent";

  @IsOptional()
  @IsString()
  @MaxLength(128)
  ownerRef?: string;

  @IsOptional()
  @IsIn([...DOMAINS])
  domain?: Domain;

  @IsOptional()
  @IsISO8601({}, { message: "due: дата в формате ISO" })
  due?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  source?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @IsOptional()
  @IsIn([...PRIORITIES])
  priority?: Priority;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  createdBy?: string;

  /** Ключ идемпотентности: повтор того же нажатия несёт то же значение. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  clientKey?: string;

  /** По какому объекту работа: автомат, точка, склад. */
  @IsOptional()
  @IsUUID()
  entityId?: string;
}

export class ListTasksDto {
  @IsOptional()
  @IsIn([...STATUSES])
  status?: Status;

  @IsOptional()
  @IsIn([...DOMAINS])
  domain?: Domain;

  @IsOptional()
  @IsIn(["human", "agent"])
  ownerKind?: "human" | "agent";

  @IsOptional()
  @IsString()
  @MaxLength(128)
  ownerRef?: string;

  /** "1" — только незакрытые: закрытое не должно засорять рабочий список. */
  @IsOptional()
  @IsIn(["1"])
  open?: string;

  /** "1" — только свободные: их разбирают из общего пула. */
  @IsOptional()
  @IsIn(["1"])
  unassigned?: string;

  /** "1" — сделанные, но ещё не принятые. */
  @IsOptional()
  @IsIn(["1"])
  awaiting?: string;

  /** System cron occurrences are an audit queue, not the owner's task list. */
  @IsOptional()
  @IsIn(["assigned", "scheduled"])
  agentInvocation?: "assigned" | "scheduled";

  /** Размер одной страницы; без параметра API сохраняет прежний лимит. */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "limit должен быть целым числом" })
  @Min(1, { message: "limit не может быть меньше 1" })
  @Max(TasksService.LIST_MAX_LIMIT, {
    message: `limit не может быть больше ${TasksService.LIST_MAX_LIMIT}`,
  })
  limit?: number;

  /** Смещение для постраничного чтения доски. */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "offset должен быть целым числом" })
  @Min(0, { message: "offset не может быть отрицательным" })
  @Max(TasksService.LIST_MAX_OFFSET, { message: "offset слишком велик" })
  offset?: number;
}

export class SetStatusDto {
  @IsIn([...STATUSES])
  status!: Status;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  actor?: string;

  /** Отчёт при закрытии: без него «сделано» ничего не значит. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  resultNote?: string;

  /** CAS для agent-worker: закрыть задачу может только текущая generation. */
  @IsOptional()
  @IsUUID()
  agentRunId?: string;
}

export class EditTaskDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @IsOptional()
  @IsIn(["human", "agent"], { message: "ownerKind: human или agent" })
  ownerKind?: "human" | "agent";

  @IsOptional()
  @IsString()
  @MaxLength(128)
  ownerRef?: string;

  @IsOptional()
  @IsIn([...PRIORITIES])
  priority?: Priority;

  // Unlike IsOptional, this skips only an omitted field: explicit null must
  // not clear a direction behind the typed UI's back.
  @ValidateIf((_dto: EditTaskDto, value: unknown) => value !== undefined)
  @IsIn([...DOMAINS])
  domain?: Domain;

  // Пустая строка допустима — это снятие срока. Иначе — ISO-дата.
  @IsOptional()
  @ValidateIf((o: EditTaskDto) => o.due !== "")
  @IsISO8601({}, { message: "due: дата в формате ISO" })
  due?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  actor?: string;

  // Пустая строка допустима — это отвязка от объекта. Иначе — uuid.
  @IsOptional()
  @ValidateIf((o: EditTaskDto) => o.entityId !== "")
  @IsUUID()
  entityId?: string;
}

/** Постановка повторяющейся задачи на день — от монитора графиков. */
export class EnsureForDayDto extends CreateTaskDto {
  /**
   * Календарный день по Ташкенту — ЧАСТЬ КЛЮЧА ИДЕМПОТЕНТНОСТИ.
   *
   * `@IsISO8601` пропускает и полную дату-время; такой `source`
   * (`maint:<plan>:2026-08-26T06:00:00Z`) не попадает под предикат частичного
   * индекса, и дедуп выключается МОЛЧА — дубли пойдут без единой ошибки.
   */
  @IsISO8601({ strict: true }, { message: "dayKey: дата YYYY-MM-DD" })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "dayKey: только голые сутки YYYY-MM-DD, без времени" })
  dayKey!: string;
}

/** Materialize one exact planned cron occurrence as a durable agent task. */
export class EnsureAgentScheduleDto {
  @IsString()
  @Matches(/^[a-z][a-z0-9-]{1,63}$/)
  agentName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  skill!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  cron!: string;

  /** Croner sends the planned UTC fire time, never callback wall-clock time. */
  @IsISO8601({ strict: true }, { message: "scheduledAt: ISO UTC date-time" })
  @Matches(/Z$/, { message: "scheduledAt: UTC timestamp ending in Z" })
  scheduledAt!: string;
}

/** Кто берёт задачу из общего пула или возвращает её обратно. */
export class ClaimTaskDto {
  @IsUUID()
  personId!: string;
}

/** Durable lease для worker, исполняющего задачу агента. */
export class ClaimAgentRunDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  agentName!: string;

  @IsOptional()
  @IsIn(["assigned", "scheduled"])
  invocation?: "assigned" | "scheduled";
}

/** Heartbeat/release lease только его текущим владельцем (CAS по runId). */
export class AgentRunLeaseDto extends ClaimAgentRunDto {
  @IsUUID()
  runId!: string;
}

export class AgentRunFenceDto extends AgentRunLeaseDto {
  @IsUUID()
  executionAttemptId!: string;
}

export class AgentRunStartDto extends AgentRunFenceDto {
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  claimedTaskInputHash!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  skill!: string;

  @IsInt()
  @Min(1)
  @Max(1000)
  workflowVersion!: number;

  @IsObject()
  plan!: Record<string, unknown>;
}

export class AgentRunInputSnapshotDto extends AgentRunFenceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  kind!: string;

  @IsObject()
  payload!: Record<string, unknown>;
}

export class AgentRunCheckpointDto extends AgentRunFenceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  skill!: string;

  @IsIn(["no_signal", "proposal"])
  kind!: "no_signal" | "proposal";

  @IsOptional()
  @IsString()
  @MaxLength(512)
  action?: string;

  @IsOptional()
  @IsObject()
  facts?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(1000, { each: true })
  next?: string[];
}

export class AgentRunCommitDto extends AgentRunFenceDto {
  @IsIn(["no_signal", "no_change", "approval_requested", "executed"])
  kind!: "no_signal" | "no_change" | "approval_requested" | "executed";

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  note!: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  action?: string;

  @IsOptional()
  @IsObject()
  facts?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(1000, { each: true })
  next?: string[];

  @IsOptional()
  @IsIn(["T0", "T1", "T2", "T3", "T4"])
  tier?: "T0" | "T1" | "T2" | "T3" | "T4";

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  memorySignature?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  executionDetail?: string;
}

export class ReleaseAgentRunDto extends AgentRunFenceDto {
  /** Core сам проверит, был ли до denial хоть один начатый reserve. */
  @IsOptional()
  @IsIn([
    "budget_denied",
    "execution_unknown",
    "workflow_changed",
    "route_unavailable",
    "action_capped",
    "unsupported",
  ])
  reason?:
    | "budget_denied"
    | "execution_unknown"
    | "workflow_changed"
    | "route_unavailable"
    | "action_capped"
    | "unsupported";

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  detail?: string;
}

export class SetQualityDto {
  @IsIn(["excellent", "accepted", "redo"])
  quality!: "excellent" | "accepted" | "redo";

  /** `owner` | `person:<uuid>` — от него зависит право приёмки. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  actor?: string;
}

export class ConfirmTaskDto {
  /** `owner` | `person:<uuid>` — от него зависит право приёмки. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  actor?: string;
}

export class AddCommentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  body!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  author?: string;
}

@Controller("tasks")
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    @Inject(DB) private readonly db: Db,
  ) {}

  /**
   * Исключать ли личные задачи из domain-less чтения.
   *
   * Тот же механизм, что у PersonalDomainGuard (R-P5-6): ужесточение включено И
   * запрос НЕ доказан owner-токеном. `GET /tasks` без `domain` отдавал задачи
   * всех доменов, включая personal — здесь закрываем этот обход. Флаг выключен
   * (дефолт) → false → выдача прода не меняется.
   */
  private excludePersonal(req: Request): Promise<boolean> {
    return excludePersonal(req, this.db);
  }

  @Post()
  create(@Body() dto: CreateTaskDto) {
    return this.tasks.create({
      title: dto.title,
      ownerKind: dto.ownerKind,
      ...(dto.ownerRef ? { ownerRef: dto.ownerRef } : {}),
      ...(dto.domain ? { domain: dto.domain } : {}),
      ...(dto.due ? { due: new Date(dto.due) } : {}),
      ...(dto.source ? { source: dto.source } : {}),
      ...(dto.description ? { description: dto.description } : {}),
      ...(dto.priority ? { priority: dto.priority } : {}),
      ...(dto.createdBy ? { createdBy: dto.createdBy } : {}),
      ...(dto.entityId ? { entityId: dto.entityId } : {}),
      ...(dto.clientKey ? { clientKey: dto.clientKey } : {}),
    });
  }

  /**
   * Идемпотентная постановка повторяющейся задачи на конкретный день.
   *
   * Вызывает монитор графиков. Дубль по-прежнему отсекает уникальный индекс в
   * БД, а не проверка перед вставкой — меняется только форма ответа: повтор в
   * тот же день (и автомат вне эксплуатации) отвечает `{ created: false }`.
   *
   * ПОЧЕМУ НЕ `null`. `return null` из контроллера Nest отдаёт 201 с ПУСТЫМ
   * телом, и `res.json()` на стороне агентов падал с `SyntaxError: Unexpected
   * end of JSON input` — монитор графиков валился КАЖДЫЙ ДЕНЬ на всех 19
   * планах (прод, события `maintenance.monitor_failed` 28.08–02.09.2026).
   * Явный JSON закрывает это на источнике.
   *
   * `id` продублирован на верхнем уровне рядом с `task` сознательно: старый
   * клиент агентов (до фикса) различал исходы по `row?.id` — при неатомарной
   * выкатке «новый Core + старый агент» он продолжает верно считать created.
   */
  @Post("ensure-for-day")
  async ensureForDay(@Body() dto: EnsureForDayDto) {
    const created = await this.tasks.ensureForDay({
      title: dto.title,
      ownerKind: dto.ownerKind,
      dayKey: dto.dayKey,
      ...(dto.domain ? { domain: dto.domain } : {}),
      ...(dto.ownerRef ? { ownerRef: dto.ownerRef } : {}),
      ...(dto.entityId ? { entityId: dto.entityId } : {}),
      ...(dto.description ? { description: dto.description } : {}),
      ...(dto.due ? { due: new Date(dto.due) } : {}),
      ...(dto.priority ? { priority: dto.priority } : {}),
      ...(dto.source ? { source: dto.source } : {}),
      ...(dto.createdBy ? { createdBy: dto.createdBy } : {}),
    });
    if (!created) return { created: false as const };
    return { created: true as const, id: created.id, task: created };
  }

  /** Durable, exact-replay materialization of one metered cron occurrence. */
  @Post("agent-schedule/ensure")
  ensureAgentSchedule(@Body() dto: EnsureAgentScheduleDto) {
    return this.tasks.ensureAgentSchedule({
      agentName: dto.agentName,
      skill: dto.skill,
      cron: dto.cron,
      scheduledAt: new Date(dto.scheduledAt),
    });
  }

  // R-P5-7a закрывает кросс-доменные агрегаты: overdue/due-soon/workload/
  // redo-unnotified/assign-unnotified теперь гейтятся тем же excludePersonal,
  // что и list/by-id — при ужесточении и не-owner запросе личный контур не
  // утекает наружу. ВАЖНО: рассыльщики напоминаний/приёмок/назначений живут в
  // apps/bot и ходят сюда по HTTP (core-client.request шлёт только x-service-token,
  // owner-action-токена у бота нет) — значит они проходят ЭТОТ гейт, а не зовут
  // сервис напрямую. При enforcement=ON бот получает excludePersonal=TRUE и
  // личные задачи в рассылке теряет — осознанный компромисс: настоящий
  // per-consumer доступ потребовал бы завести x-owner-action-token в бот.
  // Флаг enforcement выключен по умолчанию → excludePersonal=false → SQL прежний.

  // Объявлены ВЫШЕ параметрических маршрутов, иначе "overdue" уедет в :id.
  @Get("overdue")
  async overdue(@Req() req: Request) {
    return this.tasks.overdue(await this.excludePersonal(req));
  }

  /** Кому пора напомнить — читает рассыльщик напоминаний. */
  @Get("due-soon")
  async dueSoon(@Req() req: Request, @Query("hours") hours?: string) {
    const h = Number(hours);
    return this.tasks.dueSoon(Number.isFinite(h) && h > 0 ? h : 24, await this.excludePersonal(req));
  }

  /** Картина по людям и агентам: висит / просрочено / сделано за неделю. */
  /** Кому сообщить о возврате на доработку. До маршрута :id — иначе перехват. */
  @Get("redo-unnotified")
  async redoUnnotified(@Req() req: Request) {
    return this.tasks.redoUnnotified(await this.excludePersonal(req));
  }

  /** Кому сообщить о новом назначении. До маршрута :id — иначе перехват. */
  @Get("assign-unnotified")
  async assignUnnotified(@Req() req: Request) {
    return this.tasks.assignUnnotified(50, await this.excludePersonal(req));
  }

  @Get("workload")
  async workload(@Req() req: Request) {
    return this.tasks.workload(await this.excludePersonal(req));
  }

  @Get()
  async list(@Query() filter: ListTasksDto, @Req() req: Request) {
    // awaiting/unassigned — отдельные выборки, но тот же domain-less обход, что
    // и голый list: excludePersonal обязан пробрасываться и в них, иначе
    // `GET /tasks?awaiting=1` / `?unassigned=1` отдавали бы личные задачи
    // не-владельцу при ужесточении в обход фильтра общего списка.
    if (filter.awaiting === "1") {
      return this.tasks.awaitingConfirmation(
        filter.limit ?? TasksService.AWAITING_LIMIT,
        filter.offset ?? 0,
        await this.excludePersonal(req),
      );
    }
    // Свободные — отдельная выборка: «ничей» это IS NULL, а не значение
    // ownerRef, и через общий фильтр по равенству его не выразить.
    if (filter.unassigned === "1") {
      return this.tasks.unassigned(
        filter.limit ?? 50,
        filter.offset ?? 0,
        await this.excludePersonal(req),
      );
    }
    return this.tasks.list(
      {
        ...(filter.status !== undefined ? { status: filter.status } : {}),
        ...(filter.domain !== undefined ? { domain: filter.domain } : {}),
        ...(filter.ownerKind !== undefined ? { ownerKind: filter.ownerKind } : {}),
        ...(filter.ownerRef !== undefined ? { ownerRef: filter.ownerRef } : {}),
        ...(filter.agentInvocation !== undefined
          ? { agentInvocation: filter.agentInvocation }
          : {}),
        ...(filter.limit !== undefined ? { limit: filter.limit } : {}),
        ...(filter.offset !== undefined ? { offset: filter.offset } : {}),
        ...(filter.open === "1" ? { openOnly: true } : {}),
      },
      await this.excludePersonal(req),
    );
  }

  @Get(":id")
  async byId(@Param("id", ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.tasks.byId(id, await this.excludePersonal(req));
  }

  @Get(":id/comments")
  async comments(@Param("id", ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.tasks.comments(id, await this.excludePersonal(req));
  }

  @Post(":id/comments")
  addComment(@Param("id", ParseUUIDPipe) id: string, @Body() dto: AddCommentDto) {
    return this.tasks.addComment(id, dto.author ?? "owner", dto.body);
  }

  /** Отметка «напомнили» — чтобы одно и то же не слалось дважды. */
  /** Оценка сделанной задачи. «Переделать» возвращает её в работу. */
  @Post(":id/quality")
  rate(@Param("id", ParseUUIDPipe) id: string, @Body() dto: SetQualityDto) {
    return this.tasks.rate(id, dto.quality, dto.actor ?? "owner");
  }

  /** Приёмка работы менеджером. */
  @Throttle({ burst: { limit: 12, ttl: 60_000 }, sustained: { limit: 12, ttl: 60_000 } })
  @Post(":id/confirm")
  confirm(@Param("id", ParseUUIDPipe) id: string, @Body() dto: ConfirmTaskDto) {
    return this.tasks.confirm(id, dto.actor ?? "owner");
  }

  @Post(":id/redo-notified")
  async markRedoNotified(@Param("id", ParseUUIDPipe) id: string) {
    await this.tasks.markRedoNotified(id);
    return { ok: true };
  }

  @Post(":id/assign-notified")
  async markAssignNotified(@Param("id", ParseUUIDPipe) id: string) {
    await this.tasks.markAssignNotified(id);
    return { ok: true };
  }

  @Post(":id/reminded")
  async markReminded(@Param("id", ParseUUIDPipe) id: string) {
    await this.tasks.markReminded(id);
    return { ok: true };
  }

  /**
   * Взять свободную задачу из общего пула.
   *
   * 409, а не 400: задача существует и запрос корректен — просто кто-то успел
   * раньше. Вызывающему надо перерисовать список, а не показывать ошибку.
   */
  @Post(":id/claim")
  async claim(@Param("id", ParseUUIDPipe) id: string, @Body() dto: ClaimTaskDto) {
    const claimed = await this.tasks.claim(id, dto.personId);
    if (!claimed) throw new ConflictException("Задачу уже взял другой сотрудник");
    return claimed;
  }

  /** Вернуть свою задачу в пул: не смогу — пусть возьмёт другой. */
  @Post(":id/release")
  async release(@Param("id", ParseUUIDPipe) id: string, @Body() dto: ClaimTaskDto) {
    const freed = await this.tasks.release(id, dto.personId);
    if (!freed) throw new ConflictException("Эта задача не на тебе");
    return freed;
  }

  /**
   * Один атомарный claim на задачу агента. Проигранная гонка —
   * обычный результат worker, поэтому 200 + claimed:false, а не 409.
   */
  @Post(":id/agent-run/claim")
  async claimAgentRun(@Param("id", ParseUUIDPipe) id: string, @Body() dto: ClaimAgentRunDto) {
    const claimed = await this.tasks.claimAgentRun(
      id,
      dto.agentName,
      new Date(),
      dto.invocation ?? "assigned",
    );
    if (!claimed) return { claimed: false as const };
    return {
      claimed: true as const,
      runId: claimed.agentRunId!,
      executionAttemptId: claimed.agentExecutionAttemptId!,
      generation: claimed.agentRunGeneration,
      claimedAt: claimed.agentRunClaimedAt!.toISOString(),
      taskInputHash: claimed.taskInputHash,
      taskInput: claimed.taskInput,
      execution: claimed.agentExecution,
      checkpoint: claimed.agentExecution?.checkpoint ?? null,
    };
  }

  /** Durable execution root is created before any provider dispatch. */
  @Post(":id/agent-run/start")
  startAgentRun(@Param("id", ParseUUIDPipe) id: string, @Body() dto: AgentRunStartDto) {
    return this.tasks.startAgentRun(id, dto);
  }

  /** Immutable public retrieval evidence, persisted before a dependent LLM call. */
  @Post(":id/agent-run/input-snapshot")
  inputSnapshotAgentRun(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: AgentRunInputSnapshotDto,
  ) {
    return this.tasks.ensureAgentRunInputSnapshot(id, dto);
  }

  /** Durable provider/skill result, before approval/event/memory/task effects. */
  @Post(":id/agent-run/checkpoint")
  checkpointAgentRun(@Param("id", ParseUUIDPipe) id: string, @Body() dto: AgentRunCheckpointDto) {
    return this.tasks.checkpointAgentRun(id, dto);
  }

  /** Atomic application of a previously checkpointed agent outcome. */
  @Post(":id/agent-run/commit")
  commitAgentRun(@Param("id", ParseUUIDPipe) id: string, @Body() dto: AgentRunCommitDto) {
    return this.tasks.commitAgentRun(id, dto);
  }

  /** CAS-release: старый worker не снимет lease новой generation. */
  @Post(":id/agent-run/release")
  async releaseAgentRun(@Param("id", ParseUUIDPipe) id: string, @Body() dto: ReleaseAgentRunDto) {
    const released = await this.tasks.releaseAgentRun(
      id,
      dto.agentName,
      dto.runId,
      dto.executionAttemptId,
      dto.reason,
      dto.detail,
    );
    return { released: released !== null };
  }

  /**
   * Только явный owner retry создаёт новый executionAttemptId. Общего
   * SERVICE_TOKEN недостаточно: он есть у самого Agents worker.
   */
  @Post(":id/agent-run/retry")
  @UseGuards(OwnerActionGuard)
  retryAgentRun(@Param("id", ParseUUIDPipe) id: string) {
    return this.tasks.retryBlockedAgentExecution(id);
  }

  /** Lease живого worker не должен стать stale во время длинного LLM-вызова. */
  @Post(":id/agent-run/heartbeat")
  async heartbeatAgentRun(@Param("id", ParseUUIDPipe) id: string, @Body() dto: AgentRunLeaseDto) {
    const renewed = await this.tasks.heartbeatAgentRun(id, dto.agentName, dto.runId);
    return { renewed };
  }

  @Patch(":id")
  setStatus(@Param("id", ParseUUIDPipe) id: string, @Body() dto: SetStatusDto) {
    return this.tasks.setStatus(
      id,
      dto.status,
      dto.actor ?? "owner",
      dto.resultNote,
      dto.agentRunId,
    );
  }

  /** Правка полей задачи (переназначение, приоритет, срок, заголовок, описание). */
  @Patch(":id/edit")
  edit(@Param("id", ParseUUIDPipe) id: string, @Body() dto: EditTaskDto) {
    return this.tasks.edit(
      id,
      {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.ownerKind !== undefined ? { ownerKind: dto.ownerKind } : {}),
        ...(dto.ownerRef !== undefined ? { ownerRef: dto.ownerRef } : {}),
        ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
        ...(dto.domain !== undefined ? { domain: dto.domain } : {}),
        // "" → снять срок; иначе ISO-строка → дата.
        ...(dto.due !== undefined ? { due: dto.due === "" ? null : new Date(dto.due) } : {}),
        // "" → отвязать от объекта; иначе uuid.
        ...(dto.entityId !== undefined
          ? { entityId: dto.entityId === "" ? null : dto.entityId }
          : {}),
      },
      dto.actor ?? "owner",
    );
  }
}
