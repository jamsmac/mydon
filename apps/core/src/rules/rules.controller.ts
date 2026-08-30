import { BadRequestException, Body, Controller, Get, Post, Query } from "@nestjs/common";
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

/** Ключ одноразового действия: `staff-digest:<день>:<personId>` и подобные. */
export class ClaimDto {
  @IsString()
  @MaxLength(256)
  key!: string;
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
  pending(
    @Query("since") since?: string,
    @Query("immediate") immediate?: string,
    @Query("until") until?: string,
    @Query("afterAt") afterAt?: string,
    @Query("afterId") afterId?: string,
  ) {
    const from = since ? new Date(since) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const when = Number.isNaN(from.getTime()) ? new Date(Date.now() - 86_400_000) : from;
    const upper = until ? new Date(until) : null;
    if (upper && Number.isNaN(upper.getTime())) {
      throw new BadRequestException("until: invalid date");
    }
    if ((afterAt !== undefined || afterId !== undefined) && upper === null) {
      throw new BadRequestException("notification cursor требует fixed until");
    }
    if ((afterAt === undefined) !== (afterId === undefined)) {
      throw new BadRequestException("afterAt и afterId задаются вместе");
    }
    let after: { occurredAt: Date; eventId: string } | undefined;
    if (afterAt !== undefined && afterId !== undefined) {
      const occurredAt = new Date(afterAt);
      if (
        Number.isNaN(occurredAt.getTime()) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          afterId,
        )
      ) {
        throw new BadRequestException("invalid notification cursor");
      }
      after = { occurredAt, eventId: afterId };
    }
    return this.rules.pending(
      when,
      immediate === "1" || immediate === "true",
      upper ? { until: upper, ...(after ? { after } : {}) } : undefined,
    );
  }

  /** Отметить уведомления доставленными — после успешной отправки в Telegram. */
  @Post("ack")
  ack(@Body() dto: AckDto) {
    return this.rules.ack(dto.keys);
  }

  /**
   * Занять ключ одноразового действия. `{ claimed: true }` ровно один раз.
   * Так рассылка по таймеру переживает перезапуск, не задваивая сообщения.
   */
  @Post("claim")
  async claim(@Body() dto: ClaimDto) {
    return { claimed: await this.rules.claim(dto.key) };
  }

  @Post("dry-run")
  dryRun(@Body() dto: DryRunDto) {
    return this.rules.dryRun(dto.type, dto.payload ?? {});
  }
}
