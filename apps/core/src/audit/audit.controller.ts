import { Controller, Get, Query } from "@nestjs/common";
import { IsInt, IsOptional, Max, Min } from "class-validator";
import { Type } from "class-transformer";
import { AuditService } from "./audit.service";

/**
 * Раньше limit шёл через DefaultValuePipe без нижней границы:
 * ?limit=-1 обходил потолок и выгружал весь журнал целиком,
 * а ?limit=abc молча подставлял 50 вместо ошибки.
 */
export class ListAuditDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "limit должен быть целым числом" })
  @Min(1, { message: "limit не может быть меньше 1" })
  @Max(500, { message: "limit не может быть больше 500" })
  limit?: number;
}

@Controller("audit")
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Query() filter: ListAuditDto) {
    return this.audit.list(filter.limit ?? 50);
  }
}
