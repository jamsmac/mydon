import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ArrayMaxSize, IsArray, IsObject, IsOptional, IsString, MaxLength } from "class-validator";
import { RulesService } from "./rules.service";

export class DryRunDto {
  @IsString()
  @MaxLength(128)
  type!: string;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}

/** Отметка о доставке: ключи `<eventId>:<ruleId>`, которые дошли до владельца. */
export class AckDto {
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @MaxLength(256, { each: true })
  keys!: string[];
}

@Controller("rules")
export class RulesController {
  constructor(private readonly rules: RulesService) {}

  @Get()
  list() {
    return this.rules.list();
  }

  /** Что должно было побеспокоить владельца с момента `since`. */
  @Get("pending")
  pending(@Query("since") since?: string, @Query("immediate") immediate?: string) {
    const from = since ? new Date(since) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const when = Number.isNaN(from.getTime()) ? new Date(Date.now() - 86_400_000) : from;
    return this.rules.pending(when, immediate === "1" || immediate === "true");
  }

  /** Отметить уведомления доставленными — после успешной отправки в Telegram. */
  @Post("ack")
  ack(@Body() dto: AckDto) {
    return this.rules.ack(dto.keys);
  }

  @Post("dry-run")
  dryRun(@Body() dto: DryRunDto) {
    return this.rules.dryRun(dto.type, dto.payload ?? {});
  }
}
