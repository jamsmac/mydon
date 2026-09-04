import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { PART_KINDS, PART_LOCATIONS, type PartKind } from "@mydon/shared";
import { PartsService } from "./parts.service";

const OFF_LOCATIONS = ["warehouse", "washing", "drying", "repair", "unknown"] as const;

export class CreatePartUnitDto {
  @IsIn([...PART_KINDS])
  partKind!: PartKind;

  @IsOptional() @IsString() @MaxLength(32)
  inventoryNo?: string;

  @IsOptional() @IsString() @MaxLength(128)
  serialNumber?: string;

  @IsOptional() @IsString() @MaxLength(128)
  model?: string;

  @IsOptional() @IsString() @MaxLength(128)
  manufacturer?: string;

  @IsOptional() @IsInt() @Min(1) @Max(99)
  setNumber?: number;

  @IsOptional() @IsInt() @Min(1) @Max(8)
  hopperPosition?: number;

  @IsOptional() @IsInt() @Min(0) @Max(20000)
  tareWeight?: number;

  @IsOptional() @IsISO8601({ strict: true })
  purchaseDate?: string;

  @IsOptional() @IsNumberString()
  purchasePrice?: string;

  @IsOptional() @IsISO8601({ strict: true })
  warrantyUntil?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  note?: string;

  @IsOptional() @IsIn([...OFF_LOCATIONS])
  location?: (typeof OFF_LOCATIONS)[number];

  @IsOptional() @IsString() @MaxLength(128)
  createdBy?: string;
}

export class UpdatePartUnitDto {
  @IsOptional() @IsString() @MaxLength(128)
  serialNumber?: string | null;

  @IsOptional() @IsString() @MaxLength(128)
  model?: string | null;

  @IsOptional() @IsString() @MaxLength(128)
  manufacturer?: string | null;

  @IsOptional() @IsInt() @Min(1) @Max(99)
  setNumber?: number | null;

  @IsOptional() @IsInt() @Min(1) @Max(8)
  hopperPosition?: number | null;

  @IsOptional() @IsInt() @Min(0) @Max(20000)
  tareWeight?: number | null;

  @IsOptional() @IsISO8601({ strict: true })
  purchaseDate?: string | null;

  @IsOptional() @IsNumberString()
  purchasePrice?: string | null;

  @IsOptional() @IsISO8601({ strict: true })
  warrantyUntil?: string | null;

  @IsOptional() @IsString() @MaxLength(2000)
  note?: string | null;

  @IsOptional() @IsString() @MaxLength(128)
  actorRef?: string;
}

export class AssignNumberDto {
  @IsOptional() @IsString() @MaxLength(32)
  inventoryNo?: string;

  @IsOptional() @IsBoolean()
  confirmLabel?: boolean;

  @IsOptional() @IsString() @MaxLength(128)
  actorRef?: string;
}

export class ProvisionDto {
  @IsOptional() @IsBoolean()
  dryRun?: boolean;

  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID(undefined, { each: true })
  machineIds?: string[];

  @IsOptional() @IsString() @MaxLength(128)
  actorRef?: string;
}

export class MovePartUnitDto {
  @IsIn(["warehouse", "washing", "drying", "repair", "unknown"])
  to!: "warehouse" | "washing" | "drying" | "repair" | "unknown";

  @IsOptional() @IsUUID()
  personId?: string;

  @IsOptional() @IsUUID()
  taskId?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  note?: string;

  @IsOptional() @IsString() @MaxLength(128)
  clientKey?: string;

  @IsOptional() @IsString() @MaxLength(128)
  actorRef?: string;
}

export class WashedPartUnitDto {
  @IsOptional() @IsUUID()
  personId?: string;

  @IsOptional() @IsUUID()
  taskId?: string;

  @IsOptional() @IsString() @MaxLength(128)
  clientKey?: string;

  @IsOptional() @IsString() @MaxLength(128)
  actorRef?: string;
}

export class RetirePartUnitDto {
  @IsString() @MaxLength(500)
  reason!: string;

  @IsOptional() @IsString() @MaxLength(128)
  actorRef?: string;
}

/**
 * Карточки узлов: реестр, очередь внимания, номера, паспорт, история.
 * Периоды (снять/поставить/заменить) остаются в /maintenance/part-*.
 */
@Controller("parts")
export class PartsController {
  constructor(private readonly parts: PartsService) {}

  @Get()
  list(
    @Query("kind") kind?: string,
    @Query("location") location?: string,
    @Query("machineId") machineId?: string,
    @Query("attention") attention?: string,
    @Query("retired") retired?: string,
    @Query("q") q?: string,
    @Query("limit") limit?: string,
  ) {
    return this.parts.list({
      ...(kind && (PART_KINDS as readonly string[]).includes(kind) ? { kind: kind as PartKind } : {}),
      ...(location === "none" || (location && (PART_LOCATIONS as readonly string[]).includes(location))
        ? { location: location as never }
        : {}),
      ...(machineId ? { machineId } : {}),
      ...(attention === "1" ? { attention: true } : {}),
      ...(retired === "1" ? { includeRetired: true } : {}),
      ...(q ? { q } : {}),
      ...(limit && /^\d+$/.test(limit) ? { limit: Number(limit) } : {}),
    });
  }

  /** Очередь «Наклеить номер» и прочее внимание — по одному, как квиз. */
  @Get("queue")
  queue() {
    return this.parts.queue();
  }

  @Get("suggest-no")
  async suggest(@Query("kind") kind: string) {
    if (!(PART_KINDS as readonly string[]).includes(kind)) return { inventoryNo: null };
    return { inventoryNo: await this.parts.suggestNumber(kind as PartKind) };
  }

  /** Автозаведение узлов по составу кофейного автомата (R-PU-3); dryRun — только план. */
  @Post("provision")
  provision(@Body() dto: ProvisionDto) {
    return this.parts.provision(dto);
  }

  /** Шаблон состава (настройка PARTS_TEMPLATE_COFFEE или дефолт). */
  @Get("template")
  template() {
    return this.parts.coffeeTemplate();
  }

  /** Узлы, стоящие на автомате сейчас. */
  @Get("installed")
  installed(@Query("machineId", ParseUUIDPipe) machineId: string) {
    return this.parts.installedOn(machineId);
  }

  /** Запасные узлы вида на складе (или в указанном месте). */
  @Get("spares")
  spares(@Query("kind") kind: string, @Query("location") location?: string) {
    if (!(PART_KINDS as readonly string[]).includes(kind)) return [];
    const loc = location && (PART_LOCATIONS as readonly string[]).includes(location) ? (location as never) : undefined;
    return this.parts.spares(kind as PartKind, loc);
  }

  /** Узлы вне автоматов по месту: мойка, сушка, склад, ремонт. */
  @Get("at")
  atLocation(@Query("location") location: string) {
    const allowed = ["warehouse", "washing", "drying", "repair", "unknown"] as const;
    if (!(allowed as readonly string[]).includes(location)) return [];
    return this.parts.atLocation(location as (typeof allowed)[number]);
  }

  @Get(":id")
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.parts.get(id);
  }

  /** Перемещение узла вне автомата: мойка → сушка → склад, склад ↔ ремонт. */
  @Post(":id/move")
  move(@Param("id", ParseUUIDPipe) id: string, @Body() dto: MovePartUnitDto) {
    return this.parts.move(id, dto);
  }

  /** «Помыл»: с мойки на сушку или сразу на склад — по настройке PARTS_DRYING_STAGE. */
  @Post(":id/washed")
  async washed(@Param("id", ParseUUIDPipe) id: string, @Body() dto: WashedPartUnitDto) {
    const to = await this.parts.afterWashLocation();
    return this.parts.move(id, { ...dto, to, note: to === "drying" ? "помыт — на сушку" : "помыт — на склад" });
  }

  @Get(":id/history")
  history(@Param("id", ParseUUIDPipe) id: string) {
    return this.parts.history(id);
  }

  @Get(":id/logs")
  logs(@Param("id", ParseUUIDPipe) id: string) {
    return this.parts.logs(id);
  }

  @Post()
  create(@Body() dto: CreatePartUnitDto) {
    return this.parts.create(dto);
  }

  @Patch(":id")
  update(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdatePartUnitDto) {
    const { actorRef, ...patch } = dto;
    return this.parts.update(id, patch, actorRef ?? "owner");
  }

  @Post(":id/number")
  assignNumber(@Param("id", ParseUUIDPipe) id: string, @Body() dto: AssignNumberDto) {
    return this.parts.assignNumber(id, dto);
  }

  @Post(":id/retire")
  retire(@Param("id", ParseUUIDPipe) id: string, @Body() dto: RetirePartUnitDto) {
    return this.parts.retire(id, dto.reason, dto.actorRef ?? "owner");
  }
}
