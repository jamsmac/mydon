import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { IsIn, IsISO8601, IsNumber, IsObject, IsOptional, IsString, IsUUID, MaxLength, Min } from "class-validator";
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

  @IsOptional() @IsString() @MaxLength(200)
  clientKey?: string;
}

export class ReceiveCollectionDto {
  @IsNumber() @Min(0)
  amount!: number;

  @IsOptional() @IsString() @MaxLength(128)
  manager?: string;

  /**
   * Разбивка по купюрам: номинал сум → количество. Необязательна — 386
   * исторических приёмов её не знают, и это законно.
   *
   * DTO проверяет только ТИП (объект), а не то, что номиналы существуют,
   * количества целые и неотрицательные, и что их сумма сошлась с `amount` —
   * это семантика, и её место в сервисе (parseDenominations), с отказом,
   * называющим обе цифры. Иначе одна плохая строка отбивает приём целиком,
   * как уже было с @IsPositive() в срезе D.
   */
  @IsOptional() @IsObject()
  denominations?: Record<string, string | number>;
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

  /**
   * Сверка по автоматам за период (R-K11): `rows` — итог по автомату за всё
   * окно, `intervals` — построчно по каждой инкассации за всю историю.
   * Даты — обязательные `ГГГГ-ММ-ДД`; отсутствие или неверный формат отбивает
   * сервис понятным сообщением, а не тихим NaN.
   *
   * Стоит выше `:id` по той же причине, что и cash-estimate.
   */
  @Get("reconcile")
  reconcile(@Query("from") from?: string, @Query("to") to?: string) {
    return this.collections.reconcile(from ?? "", to ?? "");
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
    return this.collections.receive(id, dto.amount, dto.manager ?? "owner", dto.denominations);
  }

  @Post(":id/cancel")
  cancel(@Param("id", ParseUUIDPipe) id: string, @Body() dto: { manager?: string }) {
    return this.collections.cancel(id, dto?.manager ?? "owner");
  }
}
