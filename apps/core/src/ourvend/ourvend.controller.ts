import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Type } from "class-transformer";
import { IsArray, IsInt, IsOptional, Max, Min } from "class-validator";
import { OurvendHealthService } from "./ourvend-health.service";
import { OurvendParityService } from "./ourvend-parity.service";
import { OurvendSnapshotService, type SnapshotDay } from "./ourvend-snapshot.service";

/**
 * Приём собственного учётного снапшота OurVend (П2 плана поглощения).
 * DTO нарочно мелкий: массовые данные проверяются ПОСТРОЧНО в сервисе с
 * карантином (урок среза D — @IsPositive на строке массового импорта отбивал
 * весь запрос без построчного отчёта). Мутации закрыты общим service-token.
 */
export class OurvendSnapshotDto {
  @IsOptional() @IsArray()
  sales?: SnapshotDay[];

  @IsOptional() @IsArray()
  stock?: SnapshotDay[];
}

/**
 * Сколько прогонов сбора показать. Граница стоит на ВХОДЕ: `?runs=100000`
 * иначе доехал бы до `limit` в запросе. `@Type(() => Number)` обязателен —
 * в query всё приходит строкой, а `ValidationPipe` включён без
 * `enableImplicitConversion`.
 */
export class OurvendHealthDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  runs?: number;
}

@Controller("ourvend")
export class OurvendController {
  constructor(
    private readonly snapshots: OurvendSnapshotService,
    private readonly parity: OurvendParityService,
    private readonly healthReport: OurvendHealthService,
  ) {}

  @Post("snapshot")
  snapshot(@Body() dto: OurvendSnapshotDto) {
    return this.snapshots.apply({
      ...(dto.sales ? { sales: dto.sales } : {}),
      ...(dto.stock ? { stock: dto.stock } : {}),
    });
  }

  @Get("status")
  status() {
    return this.snapshots.status();
  }

  @Get("parity")
  parityReport(@Query("days") days?: string) {
    const n = Number(days);
    return this.parity.parity(Number.isFinite(n) && n > 0 ? n : 7);
  }

  /**
   * Здоровье сбора OurVend (R-P5b-8): прогоны, серия отказов, свежесть снимков,
   * паритет. Отвечает на вопрос, который 25.08 никто не задал вовремя, — «сбор
   * вообще работает?».
   *
   * Живого запроса в кабинет тут нет и не будет: коннектор ходит по крону из
   * слоя агентов, здесь — только его следы.
   */
  @Throttle({ burst: { limit: 12, ttl: 60_000 }, sustained: { limit: 12, ttl: 60_000 } })
  @Get("health")
  health(@Query() dto: OurvendHealthDto) {
    return this.healthReport.health(dto.runs);
  }
}
