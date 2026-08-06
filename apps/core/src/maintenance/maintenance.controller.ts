import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import {
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
