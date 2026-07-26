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
  list(@Query("type") type?: string, @Query("since") since?: string) {
    return this.events.list({
      ...(type ? { type } : {}),
      ...(since ? { since: new Date(since) } : {}),
    });
  }
}
