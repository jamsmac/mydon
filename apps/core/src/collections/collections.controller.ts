import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { IsIn, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min } from "class-validator";
import { CollectionsService } from "./collections.service";

export class CreateCollectionDto {
  @IsUUID()
  machineId!: string;

  @IsOptional() @IsUUID()
  operatorId?: string;

  @IsOptional() @IsISO8601()
  collectedAt?: string;

  @IsOptional() @IsIn(["realtime", "manual_history", "import"])
  source?: "realtime" | "manual_history" | "import";

  @IsOptional() @IsString() @MaxLength(1000)
  notes?: string;
}

export class ReceiveCollectionDto {
  @IsNumber() @Min(0)
  amount!: number;

  @IsOptional() @IsString() @MaxLength(128)
  manager?: string;
}

/** Инкассация автоматов: фиксация сбора, приём с суммой, отчёты. */
@Controller("collections")
export class CollectionsController {
  constructor(private readonly collections: CollectionsService) {}

  @Post()
  create(@Body() dto: CreateCollectionDto) {
    return this.collections.create(dto, dto.operatorId ? `person:${dto.operatorId}` : "bot");
  }

  @Get("summary")
  summary(@Query("days") days?: string) {
    const n = Number(days);
    return this.collections.summary(Number.isFinite(n) && n > 0 ? Math.min(n, 365) : 30);
  }

  /**
   * Оценка наличных в автоматах прямо сейчас.
   *
   * Стоит ВЫШЕ маршрута `:id` — иначе «cash-estimate» ушло бы в него как в
   * идентификатор и вернуло бы ошибку разбора.
   */
  @Get("cash-estimate")
  cashEstimate() {
    return this.collections.cashEstimate();
  }

  @Get()
  list(
    @Query("status") status?: string,
    @Query("days") days?: string,
    @Query("limit") limit?: string,
  ) {
    const st = status === "collected" || status === "received" || status === "cancelled" ? status : undefined;
    const d = Number(days);
    const l = Number(limit);
    return this.collections.list({
      ...(st ? { status: st } : {}),
      ...(Number.isFinite(d) && d > 0 ? { days: Math.min(d, 365) } : {}),
      ...(Number.isFinite(l) && l > 0 ? { limit: Math.min(l, 500) } : {}),
    });
  }

  @Post(":id/receive")
  receive(@Param("id", ParseUUIDPipe) id: string, @Body() dto: ReceiveCollectionDto) {
    return this.collections.receive(id, dto.amount, dto.manager ?? "owner");
  }

  @Post(":id/cancel")
  cancel(@Param("id", ParseUUIDPipe) id: string, @Body() dto: { manager?: string }) {
    return this.collections.cancel(id, dto?.manager ?? "owner");
  }
}
