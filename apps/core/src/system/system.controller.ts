import { Body, Controller, Get, Put } from "@nestjs/common";
import { IsOptional, IsString, MaxLength } from "class-validator";
import { AnalyticsService } from "../vending/analytics.service";
import { SystemService } from "./system.service";

export class SetConfigDto {
  @IsString() @MaxLength(64)
  key!: string;

  // Пустое значение допустимо — это сброс тумблера к env/дефолту.
  @IsString() @MaxLength(1024)
  value!: string;

  @IsOptional() @IsString() @MaxLength(128)
  updatedBy?: string;
}

/**
 * Глобальные тумблеры системы. Мутация (PUT) закрыта общим ServiceTokenGuard.
 * Секретов здесь нет — только не-секретная активация из белого списка.
 */
@Controller("system/config")
export class SystemController {
  constructor(
    private readonly system: SystemService,
    private readonly analytics: AnalyticsService,
  ) {}

  @Get()
  effective() {
    return this.system.effective();
  }

  /**
   * Записать тумблер и СБРОСИТЬ кеш отчётов.
   *
   * Четыре из пяти порогов аналитики (`MARGIN_LOW_PCT`, `PRICE_CHANGE_PCT`,
   * `PRICE_GAP_PCT`, `COST_WINDOW_DAYS`) читаются ВНУТРИ кешируемого расчёта и
   * в ключ кеша не входят — без сброса панель говорила бы «сохранено», а отчёт
   * до пяти минут считался бы по прежнему порогу. Сброс общий и безусловный:
   * различать «этот ключ на отчёты влияет, а тот нет» дороже, чем один лишний
   * пересчёт на редкую правку настроек.
   */
  @Put()
  async set(@Body() dto: SetConfigDto) {
    const итог = await this.system.set(dto.key, dto.value, dto.updatedBy);
    this.analytics.invalidateReports();
    return итог;
  }
}
