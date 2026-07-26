import { timingSafeEqual } from "node:crypto";
import {
  Body,
  Controller,
  Param,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from "class-validator";
import { EventsService } from "../events/events.service";
import { RulesService } from "../rules/rules.service";

export class IngestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  type!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  source?: string;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}

/** Сравнение в постоянное время: иначе ключ подбирается по времени ответа. */
function secretEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Входящий шлюз для внешних систем (ТЗ: «дверь» для push-событий).
 * Защищён ключом INGEST_KEY. Если ключ не задан — дверь закрыта совсем,
 * а не открыта настежь.
 */
@Controller("ingest")
export class IngestController {
  constructor(
    private readonly events: EventsService,
    private readonly rules: RulesService,
  ) {}

  @Post(":key")
  async ingest(@Param("key") key: string, @Body() dto: IngestDto) {
    const expected = process.env.INGEST_KEY ?? "";
    if (!expected) {
      throw new ServiceUnavailableException(
        "Приём внешних событий выключен: INGEST_KEY не задан в .env",
      );
    }
    if (!secretEquals(key, expected)) {
      throw new UnauthorizedException("Неверный ключ приёма");
    }

    const event = await this.events.record({
      source: dto.source ?? "ingest",
      type: dto.type,
      payload: dto.payload ?? {},
    });

    // Сразу показываем, что это событие породит — чтобы отправитель видел эффект.
    const notifications = this.rules.dryRun(dto.type, dto.payload ?? {}, dto.source ?? "ingest");
    return { eventId: event.id, notifications };
  }
}
