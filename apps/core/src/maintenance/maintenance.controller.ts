import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from "class-validator";
import {
  MaintenanceService,
  type MaintenanceKind,
  type MaintenanceOutcome,
  type PartSwapReason,
} from "./maintenance.service";

const KINDS = [
  "cleaning",
  "sanitation",
  "service",
  "part_replace",
  "inspection",
  "calibration",
  "repair",
  "other",
] as const;

const PART_KINDS = [
  "bill_acceptor",
  "coin_acceptor",
  "brewer",
  "grinder",
  "mixer",
  "hopper",
  "water_filter",
  "pump",
  "boiler",
  "cooling_unit",
  "compressor",
  "payment_terminal",
  "display",
  "mainboard",
  "motor",
  "valve",
  "sensor",
  "lock",
  "spiral",
  "elevator",
  "other",
] as const;

const OUTCOMES = ["done", "partial", "failed"] as const;
const REASONS = ["failure", "preventive", "upgrade", "warranty", "moved"] as const;

export class CreateLogDto {
  @IsUUID()
  entityId!: string;

  @IsIn([...KINDS])
  kind!: MaintenanceKind;

  @IsOptional() @IsIn([...PART_KINDS])
  partKind?: string;

  @IsOptional() @IsUUID()
  personId?: string;

  @IsOptional() @IsUUID()
  taskId?: string;

  /** Норматив, по которому работа сделана: без него срок не сдвинется. */
  @IsOptional() @IsUUID()
  planId?: string;

  @IsOptional() @IsISO8601({ strict: true }, { message: "performedOn: дата YYYY-MM-DD" })
  performedOn?: string;

  @IsOptional() @IsIn([...OUTCOMES])
  outcome?: MaintenanceOutcome;

  @IsOptional() @IsString() @MaxLength(2000)
  note?: string;

  @IsOptional() @IsInt() @Min(0)
  counterValue?: number;

  @IsOptional() @IsString() @MaxLength(128)
  createdBy?: string;
}

export class CloseLogDto {
  @IsIn([...OUTCOMES])
  outcome!: MaintenanceOutcome;

  @IsOptional() @IsString() @MaxLength(2000)
  note?: string;

  @IsOptional() @IsInt() @Min(0)
  counterValue?: number;

  @IsOptional() @IsString() @MaxLength(128)
  actor?: string;
}

export class SwapPartDto {
  @IsUUID()
  machineId!: string;

  @IsIn([...PART_KINDS])
  partKind!: string;

  @IsOptional() @IsInt() @IsPositive()
  slot?: number;

  @IsOptional() @IsString() @MaxLength(128)
  oldSerial?: string;

  @IsOptional() @IsString() @MaxLength(128)
  newSerial?: string;

  @IsOptional() @IsString() @MaxLength(128)
  model?: string;

  @IsOptional() @IsIn([...REASONS])
  reason?: PartSwapReason;

  @IsOptional() @IsUUID()
  personId?: string;

  @IsOptional() @IsUUID()
  taskId?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  note?: string;

  @IsOptional() @IsISO8601({ strict: true })
  warrantyUntil?: string;

  @IsOptional() @IsISO8601({ strict: true })
  performedOn?: string;

  @IsOptional() @IsString() @MaxLength(128)
  createdBy?: string;
}

export class UpsertPlanDto {
  @IsOptional() @IsUUID()
  id?: string;

  @IsUUID()
  entityId!: string;

  @IsIn([...KINDS])
  kind!: MaintenanceKind;

  @IsOptional() @IsIn([...PART_KINDS])
  partKind?: string;

  @IsOptional() @IsString() @MaxLength(200)
  title?: string;

  @IsOptional() @IsInt() @IsPositive()
  everyDays?: number;

  @IsOptional() @IsInt() @IsPositive()
  everyMonths?: number;

  @IsOptional() @IsInt() @IsPositive()
  everyCount?: number;

  @IsOptional() @IsString() @MaxLength(40)
  counterLabel?: string;

  @IsOptional() @IsISO8601({ strict: true })
  dueOn?: string;

  @IsOptional() @IsInt() @Min(0)
  taskLeadDays?: number;

  @IsOptional() @IsBoolean()
  autoTask?: boolean;

  @IsOptional() @IsUUID()
  assigneeId?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  note?: string;

  /**
   * Вернуть норматив в строй (`true`) или снять (`false`).
   *
   * Гасить можно было и раньше — `DELETE /plans/:id` не удаляет, а выключает.
   * Обратной операции не существовало: автомат, вернувшийся из ремонта,
   * оставался без графика навсегда. Поле не передано — состояние не трогаем.
   */
  @IsOptional() @IsBoolean()
  isActive?: boolean;

  @IsOptional() @IsString() @MaxLength(128)
  actor?: string;
}

/**
 * Массовое заведение стандартных нормативов.
 *
 * Список объектов приходит явно, а не «всем автоматам сразу»: у владельца
 * есть кофейные точки и снек-автоматы, и мойка миксера раз в 10 дней имеет
 * смысл не для всех. Кого включать — решает вызывающий, а не Core.
 */
export class ApplyStandardNormsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @IsUUID(undefined, { each: true })
  entityIds!: string[];

  @IsOptional() @IsString() @MaxLength(128)
  actor?: string;
}

/**
 * Обслуживание оборудования: журнал работ и узлы автоматов.
 *
 * Сроки следующих работ здесь не считаются — это дело нормативов, у которых
 * своя таблица. Тут только то, что действительно произошло.
 */
@Controller("maintenance")
export class MaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}

  @Post("log")
  createLog(@Body() dto: CreateLogDto) {
    return this.maintenance.createLog(dto);
  }

  @Get("log")
  list(
    @Query("entityId") entityId?: string,
    @Query("personId") personId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.maintenance.list({
      ...(entityId ? { entityId } : {}),
      ...(personId ? { personId } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    });
  }

  @Patch("log/:id")
  closeLog(@Param("id", ParseUUIDPipe) id: string, @Body() dto: CloseLogDto) {
    return this.maintenance.closeLog(
      id,
      {
        outcome: dto.outcome,
        ...(dto.note !== undefined ? { note: dto.note } : {}),
        ...(dto.counterValue !== undefined ? { counterValue: dto.counterValue } : {}),
      },
      dto.actor ?? "owner",
    );
  }

  /** «Ошибся — исправить»: убрать свою запись и внести заново. */
  @Delete("log/:id")
  async removeLog(
    @Param("id", ParseUUIDPipe) id: string,
    @Query("personId", ParseUUIDPipe) personId: string,
    @Query("actor") actor?: string,
  ) {
    await this.maintenance.removeLog(id, personId, actor ?? `person:${personId}`);
    return { ok: true };
  }

  // ── Нормативы ──────────────────────────────────────────────────────────────

  /** Что подходит к сроку. Объявлен ВЫШЕ «plans/:id», иначе уедет в параметр. */
  @Get("due")
  due() {
    return this.maintenance.dueList();
  }

  @Get("plans")
  plans(@Query("entityId") entityId?: string, @Query("includeInactive") includeInactive?: string) {
    return this.maintenance.plans(entityId, includeInactive === "1" || includeInactive === "true");
  }

  @Post("plans")
  upsertPlan(@Body() dto: UpsertPlanDto) {
    return this.maintenance.upsertPlan(dto, dto.actor ?? "owner");
  }

  /** Стандартные нормативы (10 / 45 / 90) на список объектов. Идемпотентно. */
  @Post("plans/standard")
  async applyStandardNorms(@Body() dto: ApplyStandardNormsDto) {
    const { created, skipped } = await this.maintenance.applyStandardNorms(
      dto.entityIds,
      dto.actor ?? "owner",
    );
    // Наружу отдаём счётчики и заведённое, а не полный список из полутора
    // сотен строк: вызывающему нужно «что изменилось», остальное — GET /plans.
    return { created: created.length, skipped, plans: created };
  }

  @Delete("plans/:id")
  deactivatePlan(@Param("id", ParseUUIDPipe) id: string, @Query("actor") actor?: string) {
    return this.maintenance.deactivatePlan(id, actor ?? "owner");
  }

  @Post("part-swap")
  swapPart(@Body() dto: SwapPartDto) {
    return this.maintenance.swapPart(dto);
  }

  @Get("parts")
  parts(@Query("machineId", ParseUUIDPipe) machineId: string) {
    return this.maintenance.parts(machineId);
  }

  /** Недавние объекты сотрудника — MRU для пикера в боте. */
  @Get("recent-objects")
  recentObjects(@Query("personId", ParseUUIDPipe) personId: string, @Query("limit") limit?: string) {
    const n = Number(limit);
    return this.maintenance.recentObjects(personId, Number.isFinite(n) && n > 0 ? Math.min(n, 20) : 5);
  }
}
