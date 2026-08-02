import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { IsISO8601, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from "class-validator";
import { EventsService } from "./events.service";

export class CreateEventDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  source!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  type!: string;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  @IsOptional()
  @IsISO8601()
  occurredAt?: string;
}

/**
 * Фильтр событий. Раньше ?since=abc уходил в new Date() и падал
 * с 500 (Invalid time value) уже на уровне драйвера.
 */
export class ListEventsDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  source?: string;

  @IsOptional()
  @IsISO8601()
  since?: string;
}

@Controller("events")
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Post()
  create(@Body() dto: CreateEventDto) {
    return this.events.record({
      source: dto.source,
      type: dto.type,
      payload: dto.payload,
      ...(dto.occurredAt ? { occurredAt: new Date(dto.occurredAt) } : {}),
    });
  }

  @Get()
  list(@Query() filter: ListEventsDto) {
    return this.events.list({
      ...(filter.type ? { type: filter.type } : {}),
      ...(filter.since ? { since: new Date(filter.since) } : {}),
    });
  }

  /** Счётчик событий под фильтр (источник/тип/с даты). */
  @Get("count")
  async count(@Query() filter: ListEventsDto) {
    const count = await this.events.count({
      ...(filter.source ? { source: filter.source } : {}),
      ...(filter.type ? { type: filter.type } : {}),
      ...(filter.since ? { since: new Date(filter.since) } : {}),
    });
    return { count };
  }

  /** Самое свежее событие под фильтр (источник/тип) — для дельта-памяти агента. */
  @Get("latest")
  async latest(@Query() filter: ListEventsDto) {
    const row = await this.events.latest({
      ...(filter.source ? { source: filter.source } : {}),
      ...(filter.type ? { type: filter.type } : {}),
    });
    return { event: row ?? null };
  }
}
