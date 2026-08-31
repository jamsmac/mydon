import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";
import { DOMAINS, STAFF_ROLES, type Domain } from "@mydon/shared";
import { OwnerMutationGuard } from "../common/owner-mutation.guard";
import { InvitesService } from "./invites.service";
import { PeopleService } from "./people.service";

export class ActorDto {
  @IsOptional() @IsString() @MaxLength(128)
  actor?: string;
}

/** Роли, которые сотрудник получит при подключении. */
export class InviteDto extends ActorDto {
  @IsOptional() @IsArray() @ArrayMaxSize(6)
  @IsIn([...STAFF_ROLES], { each: true })
  roles?: string[];
}

export class RolesDto extends ActorDto {
  @IsArray() @ArrayMaxSize(6)
  @IsIn([...STAFF_ROLES], { each: true })
  roles!: string[];
}

/** Погашение приглашения ботом: код и chat_id того, кто по ссылке пришёл. */
export class RedeemDto {
  @IsString() @IsNotEmpty() @MaxLength(64)
  code!: string;

  @IsString() @IsNotEmpty() @MaxLength(64)
  chatId!: string;
}

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
  constructor(
    private readonly people: PeopleService,
    private readonly invites: InvitesService,
  ) {}

  @Get()
  list(@Query("all") all?: string) {
    return this.people.list({ includeInactive: all === "1" });
  }

  /**
   * Привязка Telegram: сотрудник нажал «Старт» у бота.
   * Объявлено ВЫШЕ параметрических маршрутов, иначе "link" уедет в :id.
   */
  /**
   * Выпустить приглашение. Код возвращается ОДИН раз — в БД лежит только хеш,
   * и «покажи ещё раз» невозможно by design.
   *
   * Owner-действие (R-P5-5): выдача доступа и ролей — из того же множества, что
   * смена ролей. Guard пропускает, пока ужесточение выключено (по умолчанию):
   * сегодня приглашение штатно зовёт бот, когда владелец добавляет сотрудника в
   * Telegram (общий SERVICE_TOKEN).
   */
  @Post(":id/invite")
  @UseGuards(OwnerMutationGuard)
  async invite(@Param("id", ParseUUIDPipe) id: string, @Body() dto: InviteDto) {
    const res = await this.invites.issue(id, dto.roles ?? [], dto.actor ?? "owner");
    return { code: res.code, expiresAt: res.expiresAt.toISOString(), name: res.person.name };
  }

  /** Погасить приглашение и привязать Telegram. Зовёт бот по /start inv_XXX. */
  @Post("redeem")
  redeem(@Body() dto: RedeemDto) {
    return this.invites.redeem(dto.code, dto.chatId);
  }

  /**
   * Отозвать доступ: снять привязку, погасить приглашения, снять роли.
   * Owner-действие (R-P5-5) — снятие ролей и доступа. Guard пропускает, пока
   * ужесточение выключено: сегодня отзыв штатно зовёт бот (общий SERVICE_TOKEN).
   */
  @Post(":id/revoke")
  @UseGuards(OwnerMutationGuard)
  revoke(@Param("id", ParseUUIDPipe) id: string, @Body() dto: ActorDto) {
    return this.invites.revoke(id, dto.actor ?? "owner");
  }

  /**
   * Проставить роли уже подключённому сотруднику.
   * Owner-действие (R-P5-5) — прямая смена ролей. Guard пропускает, пока
   * ужесточение выключено; сегодня зовёт только панель (общий SERVICE_TOKEN).
   */
  @Post(":id/roles")
  @UseGuards(OwnerMutationGuard)
  setRoles(@Param("id", ParseUUIDPipe) id: string, @Body() dto: RolesDto) {
    return this.invites.setRoles(id, dto.roles, dto.actor ?? "owner");
  }

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
