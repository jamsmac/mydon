import { Module } from "@nestjs/common";
import { EventsModule } from "../events/events.module";
import { LlmAlertMonitorService } from "./llm-alert-monitor.service";
import { LlmLedgerController } from "./llm-ledger.controller";
import { LlmLedgerService } from "./llm-ledger.service";

@Module({
  imports: [EventsModule],
  controllers: [LlmLedgerController],
  providers: [LlmLedgerService, LlmAlertMonitorService],
  exports: [LlmLedgerService],
})
export class LlmLedgerModule {}
