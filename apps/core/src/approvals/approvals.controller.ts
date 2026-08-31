import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from "@nestjs/common";
import { IsIn, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from "class-validator";
import { AUTONOMY_TIERS, type AutonomyTier } from "@mydon/shared";
import { OwnerMutationGuard } from "../common/owner-mutation.guard";
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

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  clientKey?: string;
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

/**
 * Фильтр списка. Значение раньше уходило прямо в PG-enum:
 * ?decision=что-угодно давало 500 вместо понятного 400.
 */
export class ListApprovalsDto {
  @IsOptional()
  @IsIn(["pending", "approved", "rejected", "clarify"])
  decision?: "pending" | "approved" | "rejected" | "clarify";
}

@Controller("approvals")
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Post()
  request(@Body() dto: RequestApprovalDto) {
    return this.approvals.request(dto);
  }

  @Get()
  list(@Query() filter: ListApprovalsDto) {
    return filter.decision ? this.approvals.list({ decision: filter.decision }) : this.approvals.list();
  }

  @Get("pending")
  pending() {
    return this.approvals.pending();
  }

  /**
   * Решение по согласованию — owner-действие (R-P5-5), под вторым поясом.
   * Guard пропускает, пока ужесточение выключено (по умолчанию): сегодня decide
   * штатно зовёт бот, когда владелец жмёт кнопку в Telegram (общий SERVICE_TOKEN).
   */
  @Post(":id/decide")
  @UseGuards(OwnerMutationGuard)
  decide(@Param("id", ParseUUIDPipe) id: string, @Body() dto: DecideDto) {
    return this.approvals.decide(id, dto.decision, dto.actor ?? "owner");
  }
}
