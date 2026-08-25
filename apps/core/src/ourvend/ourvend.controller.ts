import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Transform } from "class-transformer";
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
 *
 * `@Transform` гасит ПУСТОЕ значение (`?runs=`) в «не задано»: документировано
 * «пусто → дефолт», а `@IsOptional` пустую строку не пропускает и отдал бы 400
 * на ссылку, которую руками собрать легче лёгкого. Число он приводит САМ,
 * вместо `@Type(() => Number)`: `@Type` отрабатывает раньше и превращает `""`
 * в `0`, после чего гасить уже нечего — `@Min(1)` отбивает ноль (поймано
 * дымовым прогоном, не тестом).
 */
export class OurvendHealthDto {
  @IsOptional() @Transform(({ value }) => (value === "" || value === undefined ? undefined : Number(value))) @IsInt() @Min(1) @Max(100)
  runs?: number;
}

/**
 * Окно сверки учётных дорожек, суток. Потолок 30 — верхняя граница была
 * НУЖНА: без неё `?days=100000` доезжал до `sql.raw(String(n))` в сыром SQL
 * паритета, и запрос читал бы всю историю снимков. Гейт переключения источника
 * учёта живёт на семи днях, месяц — предел осмысленного разбора.
 */
export class OurvendParityDto {
  @IsOptional() @Transform(({ value }) => (value === "" || value === undefined ? undefined : Number(value))) @IsInt() @Min(1) @Max(30)
  days?: number;
}

/** Окно сверки по умолчанию — гейт переключения источника учёта (7 зелёных дней). */
const PARITY_DAYS_DEFAULT = 7;

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

  /**
   * Сверка собственного учётного снапшота с дорожкой mydon-stock.
   *
   * Троттл тот же, что у отчётов: внутри — четыре сырых агрегата, и до правки
   * этот роут был единственным отчётным чтением вообще без лимита.
   */
  @Throttle({ burst: { limit: 12, ttl: 60_000 }, sustained: { limit: 12, ttl: 60_000 } })
  @Get("parity")
  parityReport(@Query() dto: OurvendParityDto) {
    return this.parity.parity(dto.days ?? PARITY_DAYS_DEFAULT);
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
