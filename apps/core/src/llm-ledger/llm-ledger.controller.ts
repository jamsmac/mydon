import { Body, Controller, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ReleaseLlmDto, ReserveLlmDto, SettleLlmDto } from "./llm-ledger.dto";
import { LlmLedgerService } from "./llm-ledger.service";

/**
 * Every route mutates the financial ledger, so the global ServiceTokenGuard
 * fails closed when SERVICE_TOKEN is empty or incorrect.
 */
@Controller("llm-ledger")
export class LlmLedgerController {
  constructor(private readonly ledger: LlmLedgerService) {}

  @Post("reservations")
  reserve(@Body() dto: ReserveLlmDto) {
    return this.ledger.reserve(dto);
  }

  @Post("reservations/:id/settle")
  settle(@Param("id", new ParseUUIDPipe()) id: string, @Body() dto: SettleLlmDto) {
    return this.ledger.settle(id, dto);
  }

  @Post("reservations/:id/release")
  release(@Param("id", new ParseUUIDPipe()) id: string, @Body() dto: ReleaseLlmDto) {
    return this.ledger.release(id, dto);
  }
}
