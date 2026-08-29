import { Module } from "@nestjs/common";
import { LlmLedgerController } from "./llm-ledger.controller";
import { LlmLedgerService } from "./llm-ledger.service";

@Module({
  controllers: [LlmLedgerController],
  providers: [LlmLedgerService],
  exports: [LlmLedgerService],
})
export class LlmLedgerModule {}
