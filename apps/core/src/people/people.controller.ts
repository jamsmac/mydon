import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { IsBoolean, IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { PeopleService } from "./people.service";

export class CreatePersonDto {
  @IsString() @IsNotEmpty() @MaxLength(256)
  name!: string;

  @IsOptional() @IsString() @MaxLength(128)
  role?: string;

  @IsOptional() @IsEmail({}, { message: "email: похоже, адрес записан неверно" })
  email?: string;

  @IsOptional() @IsString() @MaxLength(64)
  phone?: string;

  /** @username в Telegram: по нему сотрудник привяжется, нажав /start. */
  @IsOptional() @IsString() @MaxLength(64)
  tgUsername?: string;

  @IsOptional() @IsBoolean()
  active?: boolean;
}

export class UpdatePersonDto extends CreatePersonDto {
  @IsOptional() @IsString() @MaxLength(256)
  declare name: string;
}

/** Сотрудники: кому владелец ставит задачи (люди; агенты — отдельно). */
@Controller("people")
export class PeopleController {
  constructor(private readonly people: PeopleService) {}

  @Get()
  list(@Query("all") all?: string) {
    return this.people.list({ includeInactive: all === "1" });
  }

  @Get(":id")
  byId(@Param("id", ParseUUIDPipe) id: string) {
    return this.people.byId(id);
  }

  @Post()
  create(@Body() dto: CreatePersonDto) {
    return this.people.create(dto);
  }

  @Patch(":id")
  update(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdatePersonDto) {
    return this.people.update(id, dto);
  }
}
