import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Matches,
  Min,
  ValidateNested,
} from "class-validator";
import { LLM_LEDGER_CONSUMERS, LLM_SETTLEMENT_OUTCOMES } from "@mydon/shared";
import type {
  LlmLedgerConsumer,
  LlmReserveRequest,
  LlmSettlementOutcome,
  LlmSettlementRequest,
} from "@mydon/shared";

const MAX_TOKEN_COUNT = 100_000_000;

export class ReserveLlmDto implements LlmReserveRequest {
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(256)
  requestKey!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(256)
  traceKey?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @IsIn([...LLM_LEDGER_CONSUMERS])
  consumer!: LlmLedgerConsumer;

  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(128)
  feature!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(128)
  agentName?: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(64)
  provider!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(192)
  model!: string;

  @IsInt()
  @Min(0)
  @Max(MAX_TOKEN_COUNT)
  inputTokenCeiling!: number;

  @IsInt()
  @Min(0)
  @Max(MAX_TOKEN_COUNT)
  outputTokenCeiling!: number;
}

export class LlmTokenUsageDto {
  @IsInt()
  @Min(0)
  @Max(MAX_TOKEN_COUNT)
  inputTokens!: number;

  @IsInt()
  @Min(0)
  @Max(MAX_TOKEN_COUNT)
  outputTokens!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_TOKEN_COUNT)
  cacheReadInputTokens?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_TOKEN_COUNT)
  cacheCreationInputTokens?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_TOKEN_COUNT)
  cacheCreation5mInputTokens?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_TOKEN_COUNT)
  cacheCreation1hInputTokens?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000)
  codeExecutionRequests?: number;
}

export class SettleLlmDto implements LlmSettlementRequest {
  @IsIn([...LLM_SETTLEMENT_OUTCOMES])
  outcome!: LlmSettlementOutcome;

  @IsOptional()
  @ValidateNested()
  @Type(() => LlmTokenUsageDto)
  usage?: LlmTokenUsageDto;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(256)
  providerRequestId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(192)
  resolvedModel?: string;

  /**
   * Факт для provider_reported. У token-тарифа не заменяет server snapshot,
   * но остаётся одним из lower-bound кандидатов при routing anomaly.
   */
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  providerReportedUsd?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class ReleaseLlmDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(1000)
  reason!: string;
}
