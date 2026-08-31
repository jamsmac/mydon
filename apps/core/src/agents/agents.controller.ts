import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { Cron } from "croner";
import { AgentsService } from "./agents.service";

const STATUSES = ["active", "paused", "draft", "deprecated"] as const;
const TIERS = ["T0", "T1", "T2", "T3", "T4"] as const;
const STRATEGIES = ["pause", "downgrade", "ask"] as const;

export class ScheduleItemDto {
  @IsString() @IsNotEmpty() @MaxLength(64)
  cron!: string;

  @IsString() @IsNotEmpty() @MaxLength(64)
  skill!: string;
}

export class WebSourceDto {
  @IsString() @IsNotEmpty() @MaxLength(128)
  name!: string;

  // Только http(s) с явной схемой: агент ходит по этому адресу сам, поэтому
  // file:, gopher: и прочее сюда не попадает. Приватные адреса отсекает уже
  // коннектор web (проверка после разрешения имени) — здесь нечего проверять,
  // DNS в контроллере не спросить.
  @IsString()
  @MaxLength(512)
  @IsUrl(
    { protocols: ["http", "https"], require_protocol: true },
    { message: "url: нужен адрес http(s) с явной схемой (например https://example.uz/prices)" },
  )
  url!: string;
}

export class CreateAgentDto {
  // Машинное имя: по нему агент связан с журналом и согласованиями.
  @IsString()
  @Matches(/^[a-z][a-z0-9-]{1,63}$/, {
    message: "name: латиница в нижнем регистре, цифры и дефис (например vendhub-ops)",
  })
  name!: string;

  @IsOptional() @IsString() @MaxLength(64)
  business?: string;

  @IsOptional() @IsIn([...STATUSES])
  status?: (typeof STATUSES)[number];

  @IsOptional() @IsString() @MaxLength(512)
  description?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  mission?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(300, { each: true })
  nonGoals?: string[];

  @IsOptional() @IsIn([...TIERS])
  autonomyDefault?: (typeof TIERS)[number];

  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(64, { each: true })
  skills?: string[];

  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => ScheduleItemDto)
  schedule?: ScheduleItemDto[];

  @IsOptional() @IsNumber() @Min(0)
  budgetPerDayUsd?: number;

  @IsOptional() @IsIn([...STRATEGIES], { message: "on_exceeded: pause | downgrade | ask" })
  budgetOnExceeded?: (typeof STRATEGIES)[number];

  @IsOptional() @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => WebSourceDto)
  webSources?: WebSourceDto[];

  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(64, { each: true })
  breakGlass?: string[];

  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(128, { each: true })
  ideaChannels?: string[];
}

export class SeedAgentsDto {
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => CreateAgentDto)
  agents!: CreateAgentDto[];
}

export class UpdateAgentDto extends CreateAgentDto {
  // Имя менять нельзя: журнал и согласования ссылаются на него.
  @IsOptional()
  declare name: string;
}

/**
 * Карточка агента (запрос владельца: настройки пополняются, меняются, удаляются).
 * Источник истины — база: правки переживают обновление системы.
 */
@Controller("agents")
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get()
  list(@Query("archived") archived?: string) {
    return this.agents.list({ includeArchived: archived === "1" });
  }

  @Get(":name")
  byName(@Param("name") name: string) {
    return this.agents.byName(name);
  }

  @Post()
  create(@Body() dto: CreateAgentDto) {
    this.assertCrons(dto.schedule);
    return this.agents.create(this.toInput(dto));
  }

  /**
   * Перенос паспортов-файлов в базу (делают сами агенты при старте).
   * Идемпотентно: существующих НЕ трогаем — иначе обновление системы затирало бы
   * настройки, которые владелец поменял в карточке.
   */
  @Post("seed")
  seed(@Body() dto: SeedAgentsDto) {
    for (const a of dto.agents) this.assertCrons(a.schedule);
    return this.agents.seedIfEmpty(dto.agents.map((a) => this.toInput(a)));
  }

  @Patch(":name")
  update(@Param("name") name: string, @Body() dto: UpdateAgentDto) {
    this.assertCrons(dto.schedule);
    const patch = this.toInput(dto);
    // Имя неизменяемо — молча отбрасываем, если пришло.
    const { name: _ignored, ...rest } = patch;
    return this.agents.update(name, rest);
  }

  /** Удаление = архивация: история агента остаётся объяснимой. */
  @Delete(":name")
  archive(@Param("name") name: string) {
    return this.agents.archive(name);
  }

  /**
   * Битое расписание нельзя пускать в базу: агенты читают её при старте,
   * и один неверный cron лишил бы владельца работающих агентов.
   */
  private assertCrons(schedule?: ScheduleItemDto[]): void {
    for (const item of schedule ?? []) {
      try {
        new Cron(item.cron, { timezone: "Asia/Tashkent", paused: true }).stop();
      } catch {
        throw new BadRequestException(
          `Расписание "${item.cron}" (навык ${item.skill}) не распознано. ` +
            `Пример: "0 9 * * 1" — понедельник 09:00.`,
        );
      }
    }
  }

  private toInput(dto: CreateAgentDto) {
    return {
      name: dto.name,
      ...(dto.business !== undefined ? { business: dto.business } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
      ...(dto.mission !== undefined ? { mission: dto.mission } : {}),
      ...(dto.nonGoals !== undefined ? { nonGoals: dto.nonGoals } : {}),
      ...(dto.autonomyDefault !== undefined ? { autonomyDefault: dto.autonomyDefault } : {}),
      ...(dto.skills !== undefined ? { skills: dto.skills } : {}),
      ...(dto.schedule !== undefined
        ? { schedule: dto.schedule.map((s) => ({ cron: s.cron, skill: s.skill })) }
        : {}),
      ...(dto.budgetPerDayUsd !== undefined ? { budgetPerDayUsd: dto.budgetPerDayUsd } : {}),
      ...(dto.budgetOnExceeded !== undefined ? { budgetOnExceeded: dto.budgetOnExceeded } : {}),
      ...(dto.webSources !== undefined
        ? { webSources: dto.webSources.map((s) => ({ name: s.name, url: s.url })) }
        : {}),
      ...(dto.breakGlass !== undefined ? { breakGlass: dto.breakGlass } : {}),
      ...(dto.ideaChannels !== undefined ? { ideaChannels: dto.ideaChannels } : {}),
    };
  }
}
