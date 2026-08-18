import { Controller, Get, Query } from "@nestjs/common";
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from "class-validator";
import { Type } from "class-transformer";
import { AuditService } from "./audit.service";

/**
 * Раньше limit шёл через DefaultValuePipe без нижней границы:
 * ?limit=-1 обходил потолок и выгружал весь журнал целиком,
 * а ?limit=abc молча подставлял 50 вместо ошибки.
 *
 * Фильтры и offset (аудит видимости 18.08): без них журнал отдавал только
 * «последние N» — старая история и «всё по человеку X» были недостижимы.
 */
export class ListAuditDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "limit должен быть целым числом" })
  @Min(1, { message: "limit не может быть меньше 1" })
  @Max(500, { message: "limit не может быть больше 500" })
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "offset должен быть целым числом" })
  @Min(0, { message: "offset не может быть отрицательным" })
  @Max(100_000, { message: "offset слишком велик" })
  offset?: number;

  /** Подстрока actorRef: person:<id>, agent:<имя>, owner. */
  @IsOptional() @IsString() @MaxLength(128)
  actor?: string;

  /** Код действия целиком, например task.done. */
  @IsOptional() @IsString() @Matches(/^[a-z_.]{3,64}$/, { message: "action: код вида task.done" })
  action?: string;

  // Именно Matches, не IsISO8601: тот пропускает полный datetime, а сервис
  // конкатенирует «T00:00:00+05:00» — получался Invalid Date и 500.
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "from: дата YYYY-MM-DD" })
  from?: string;

  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "to: дата YYYY-MM-DD" })
  to?: string;
}

@Controller("audit")
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Query() filter: ListAuditDto) {
    return this.audit.list(filter.limit ?? 50, {
      offset: filter.offset ?? 0,
      actor: filter.actor,
      action: filter.action,
      from: filter.from,
      to: filter.to,
    });
  }
}
