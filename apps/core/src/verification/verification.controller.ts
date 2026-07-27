import { Body, Controller, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { VerificationService, type Claim } from "./verification.service";

/** Одно проверяемое утверждение агента. */
export class ClaimDto {
  @IsIn(["entity", "money", "event"])
  kind!: "entity" | "money" | "event";

  @IsOptional() @IsUUID() id?: string;
  @IsOptional() @IsString() @MaxLength(64) field?: string;
  @IsOptional() @IsString() @MaxLength(256) equals?: string;

  @IsOptional() @IsUUID() entityId?: string;
  @IsOptional() @IsIn(["in", "out"]) direction?: "in" | "out";
  @IsOptional() @IsInt() @Min(0) minAmount?: number;

  @IsOptional() @IsString() @MaxLength(128) type?: string;
  @IsOptional() @IsInt() @Min(1) @Max(10080) sinceMinutes?: number;
}

export class ReportDto {
  @IsString() @IsNotEmpty() @MaxLength(128)
  agent!: string;

  /** Ограничение размера намеренное: отчёт на тысячу утверждений — способ загрузить базу. */
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => ClaimDto)
  claims!: ClaimDto[];
}

@Controller("approvals")
export class VerificationController {
  constructor(private readonly verification: VerificationService) {}

  /**
   * Агент сообщает «готово» — и обязан приложить проверяемые утверждения.
   * Core сверяет их с базой сам; слову агента не верим.
   */
  @Post(":id/report")
  report(@Param("id", ParseUUIDPipe) id: string, @Body() dto: ReportDto) {
    return this.verification.verify({
      approvalId: id,
      agent: dto.agent,
      claims: dto.claims as unknown as Claim[],
    });
  }
}
