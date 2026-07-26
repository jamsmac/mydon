import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { IsIn, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from "class-validator";
import { AUTONOMY_TIERS, type AutonomyTier } from "@mydon/shared";
import { ApprovalsService } from "./approvals.service";

export class RequestApprovalDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  agent!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  action!: string;

  @IsIn([...AUTONOMY_TIERS])
  tier!: AutonomyTier;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}

export class DecideDto {
  @IsIn(["approved", "rejected", "clarify"])
  decision!: "approved" | "rejected" | "clarify";

  /** Кто решил. Пока единственный, кто согласует, — владелец (Ф6). */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  actor?: string;
}

@Controller("approvals")
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Post()
  request(@Body() dto: RequestApprovalDto) {
    return this.approvals.request(dto);
  }

  @Get()
  list(@Query("decision") decision?: "pending" | "approved" | "rejected" | "clarify") {
    return decision ? this.approvals.list({ decision }) : this.approvals.list();
  }

  @Get("pending")
  pending() {
    return this.approvals.pending();
  }

  @Post(":id/decide")
  decide(@Param("id", ParseUUIDPipe) id: string, @Body() dto: DecideDto) {
    return this.approvals.decide(id, dto.decision, dto.actor ?? "owner");
  }
}
