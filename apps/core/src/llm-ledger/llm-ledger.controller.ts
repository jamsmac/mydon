import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ReleaseLlmDto, ReserveLlmDto, SettleLlmDto } from "./llm-ledger.dto";
import { LlmLedgerService } from "./llm-ledger.service";

/**
 * The global ServiceTokenGuard protects financial mutations. Core GET routes
 * are readable only inside the private network, so monitoring additionally
 * returns no raw provider reasons, metadata or request identifiers.
 */
@Controller("llm-ledger")
export class LlmLedgerController {
  constructor(private readonly ledger: LlmLedgerService) {}

  @Get("monitoring")
  monitoring() {
    return this.ledger.monitoring();
  }

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
