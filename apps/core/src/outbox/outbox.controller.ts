import { Body, Controller, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { OutboxService } from "./outbox.service";

export class ClaimOutboxDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  destination!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  workerRef!: string;
}

export class CompleteOutboxDto {
  @IsUUID()
  leaseToken!: string;

  @IsIn(["sent", "skipped", "unknown", "dead"])
  status!: "sent" | "skipped" | "unknown" | "dead";

  @IsOptional()
  @IsString()
  @MaxLength(512)
  providerRef?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  error?: string;
}

@Controller("outbox")
export class OutboxController {
  constructor(private readonly outbox: OutboxService) {}

  @Post("claim")
  async claim(@Body() dto: ClaimOutboxDto) {
    return { delivery: await this.outbox.claim(dto.destination, dto.workerRef) };
  }

  @Post(":id/complete")
  complete(@Param("id", ParseUUIDPipe) id: string, @Body() dto: CompleteOutboxDto) {
    return this.outbox.complete(id, dto.leaseToken, dto.status, {
      ...(dto.providerRef ? { providerRef: dto.providerRef } : {}),
      ...(dto.error ? { error: dto.error } : {}),
    });
  }
}
