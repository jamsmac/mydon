import { Body, Controller, Get, Put } from "@nestjs/common";
import { IsOptional, IsString, MaxLength } from "class-validator";
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
  constructor(private readonly system: SystemService) {}

  @Get()
  effective() {
    return this.system.effective();
  }

  @Put()
  set(@Body() dto: SetConfigDto) {
    return this.system.set(dto.key, dto.value, dto.updatedBy);
  }
}
