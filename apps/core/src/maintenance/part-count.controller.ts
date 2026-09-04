import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from "class-validator";
import { PART_KINDS, type PartKind } from "@mydon/shared";
import { COUNT_LOCATIONS, PartCountService, type CountLocation } from "./part-count.service";

export class StartCountDto {
  @IsIn([...COUNT_LOCATIONS])
  location!: CountLocation;

  @IsOptional() @IsUUID()
  warehouseId?: string;

  @IsOptional() @IsUUID()
  personId?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  note?: string;

  @IsOptional() @IsString() @MaxLength(128)
  actorRef?: string;
}

export class AddCountLineDto {
  @IsIn([...PART_KINDS])
  partKind!: PartKind;

  @IsOptional() @IsString() @MaxLength(32)
  inventoryNo?: string;

  @IsOptional() @IsString() @MaxLength(128)
  serialNumber?: string;

  @IsOptional() @IsInt() @Min(1) @Max(99)
  setNumber?: number;

  @IsOptional() @IsInt() @Min(1) @Max(8)
  hopperPosition?: number;

  @IsOptional() @IsString() @MaxLength(500)
  photoSkippedReason?: string;

  @IsOptional() @IsString() @MaxLength(128)
  clientKey?: string;

  @IsOptional() @IsString() @MaxLength(128)
  actorRef?: string;
}

export class SkipPhotoDto {
  @IsString() @MaxLength(500)
  reason!: string;
}

export class ActorDto {
  @IsOptional() @IsString() @MaxLength(128)
  actorRef?: string;

  @IsOptional() @IsUUID()
  personId?: string;
}

/**
 * Инвентаризация узлов (R-PU-7, У4). Маршруты трёхсегментные (`parts/count/…`),
 * чтобы не пересекаться с `GET /parts/:id`.
 */
@Controller("parts/count")
export class PartCountController {
  constructor(private readonly count: PartCountService) {}

  @Get("sessions")
  list(@Query("limit") limit?: string) {
    const n = Number(limit);
    return this.count.list(Number.isFinite(n) && n > 0 ? n : 50);
  }

  @Post("sessions")
  start(@Body() dto: StartCountDto) {
    return this.count.start(dto);
  }

  @Get("sessions/:id")
  summary(@Param("id", ParseUUIDPipe) id: string) {
    return this.count.summary(id);
  }

  @Post("sessions/:id/lines")
  addLine(@Param("id", ParseUUIDPipe) id: string, @Body() dto: AddCountLineDto) {
    return this.count.addLine(id, dto);
  }

  @Post("sessions/:id/finish")
  finish(@Param("id", ParseUUIDPipe) id: string, @Body() dto: ActorDto) {
    return this.count.finish(id, dto.actorRef);
  }

  @Post("sessions/:id/apply")
  apply(@Param("id", ParseUUIDPipe) id: string, @Body() dto: ActorDto) {
    return this.count.apply(id, dto);
  }

  @Post("sessions/:id/reverse")
  reverse(@Param("id", ParseUUIDPipe) id: string, @Body() dto: ActorDto) {
    return this.count.reverse(id, dto.actorRef);
  }

  @Post("lines/:lineId/skip-photo")
  skipPhoto(@Param("lineId", ParseUUIDPipe) lineId: string, @Body() dto: SkipPhotoDto) {
    return this.count.skipPhoto(lineId, dto.reason);
  }

  @Post("lines/:lineId/remove")
  async removeLine(@Param("lineId", ParseUUIDPipe) lineId: string, @Body() dto: ActorDto) {
    await this.count.removeLine(lineId, dto.actorRef);
    return { ok: true };
  }
}
