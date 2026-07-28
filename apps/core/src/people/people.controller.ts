import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { IsBoolean, IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { DOMAINS, type Domain } from "@mydon/shared";
import { PeopleService } from "./people.service";

export class CreatePersonDto {
  @IsString() @IsNotEmpty() @MaxLength(256)
  name!: string;

  @IsOptional() @IsString() @MaxLength(128)
  role?: string;

  /** Направление, куда нанят: сотрудник живёт внутри дела, а не отдельным списком. */
  @IsOptional() @IsIn(DOMAINS)
  domain?: Domain;

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

export class LinkTelegramDto {
  @IsString() @IsNotEmpty() @MaxLength(32)
  chatId!: string;

  @IsOptional() @IsString() @MaxLength(64)
  username?: string;
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

  /**
   * Привязка Telegram: сотрудник нажал «Старт» у бота.
   * Объявлено ВЫШЕ параметрических маршрутов, иначе "link" уедет в :id.
   */
  @Post("link")
  async link(@Body() dto: LinkTelegramDto) {
    const person = await this.people.linkTelegram(dto.chatId, dto.username ?? null);
    return person ?? { linked: false };
  }

  /** Кто написал боту — по chat_id. Бот отличает сотрудника от постороннего. */
  @Get("by-chat/:chatId")
  async byChat(@Param("chatId") chatId: string) {
    const person = await this.people.byChatId(chatId);
    return person ?? { found: false };
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
