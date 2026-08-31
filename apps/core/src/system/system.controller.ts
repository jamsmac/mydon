import { Body, Controller, Get, Put, UseGuards } from "@nestjs/common";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { SystemOwnerGuard } from "../common/system-owner.guard";
import { AnalyticsService } from "../vending/analytics.service";
import { LLM_PROFILE_KEYS } from "./config-spec";
import { SystemService } from "./system.service";

export class SetConfigDto {
  @IsString()
  @MaxLength(64)
  key!: string;

  // Пустое значение допустимо — это сброс тумблера к env/дефолту.
  @IsString()
  @MaxLength(1024)
  value!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  updatedBy?: string;
}

export class LlmProfileItemDto {
  @IsString()
  @MaxLength(64)
  @IsIn([...LLM_PROFILE_KEYS])
  key!: string;

  // Пусто — сброс к env/дефолту, как и в одиночном endpoint.
  @IsString()
  @MaxLength(1024)
  value!: string;
}

export class SetLlmProfileDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(LLM_PROFILE_KEYS.length)
  @ArrayUnique((item: LlmProfileItemDto) => item.key)
  @ValidateNested({ each: true })
  @Type(() => LlmProfileItemDto)
  items!: LlmProfileItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(128)
  updatedBy?: string;
}

/**
 * Глобальные тумблеры системы. Мутация (PUT) закрыта общим ServiceTokenGuard,
 * а поверх — независимым `SystemOwnerGuard` (второй пояс, привязанный к наличию
 * `OWNER_ACTION_TOKEN`, а не к флагу enforcement: сам флаг пишется здесь же).
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
  @UseGuards(SystemOwnerGuard)
  async set(@Body() dto: SetConfigDto) {
    const итог = await this.system.set(dto.key, dto.value, dto.updatedBy);
    this.analytics.invalidateReports();
    return итог;
  }

  /**
   * Профиль пишется одним commit: модель, route и лимиты не могут
   * на мгновение стать взаимно несогласованными. Global ServiceTokenGuard закрывает
   * PUT так же, как остальные мутации Core; `SystemOwnerGuard` добавляет второй
   * пояс (owner-токен), когда он задан — маршрут и бюджеты LLM меняет только владелец.
   */
  @Put("llm-profile")
  @UseGuards(SystemOwnerGuard)
  async setLlmProfile(@Body() dto: SetLlmProfileDto) {
    const итог = await this.system.setLlmProfile(dto.items, dto.updatedBy);
    this.analytics.invalidateReports();
    return итог;
  }
}
