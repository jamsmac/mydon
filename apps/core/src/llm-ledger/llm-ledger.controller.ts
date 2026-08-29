import { Body, Controller, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ReleaseLlmDto, ReserveLlmDto, SettleLlmDto } from "./llm-ledger.dto";
import { LlmLedgerService } from "./llm-ledger.service";

/**
 * Все маршруты мутируют финансовый журнал, поэтому глобальный
 * ServiceTokenGuard закрывает их fail-closed при пустом/неверном SERVICE_TOKEN.
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
