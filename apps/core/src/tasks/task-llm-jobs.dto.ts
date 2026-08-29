import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";

const MAX_TOKEN_COUNT = 100_000_000;

export class EnsureTaskLlmJobDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  agentName!: string;

  @IsUUID()
  runId!: string;

  @IsUUID()
  executionAttemptId!: string;

  @IsString()
  @Matches(/^[a-z0-9][a-z0-9:._/-]{0,127}$/i)
  stepKey!: string;

  @IsInt()
  @Min(1)
  @Max(3)
  providerAttemptNo!: number;

  @IsIn(["chat", "embedding"])
  kind!: "chat" | "embedding";

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  feature!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  adapter!: string;

  @IsInt()
  @IsIn([1])
  adapterVersion!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  endpointProfile!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  provider!: string;

  @IsString()
  @IsNotEmpty()
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

  @IsObject()
  requestPayload!: Record<string, unknown>;
}

export class ClaimTaskLlmDispatchDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  agentName!: string;

  @IsUUID()
  runId!: string;

  @IsUUID()
  executionAttemptId!: string;

  @IsUUID()
  dispatchToken!: string;
}

export class CompleteTaskLlmJobDto {
  @IsUUID()
  dispatchToken!: string;

  @IsIn(["success", "provider_rejection", "unknown"])
  outcome!: "success" | "provider_rejection" | "unknown";

  @IsOptional()
  @IsObject()
  result?: Record<string, unknown>;
}
