import { Module } from "@nestjs/common";
import { DbModule } from "../db/db.module";
import { EventsModule } from "../events/events.module";
import { FinanceModule } from "../finance/finance.module";
import { ContractsController } from "./contracts.controller";
import { ContractsService } from "./contracts.service";

/** UZS-договоры купли-продажи GLOBERENT (перенос contracts PROMACH). */
@Module({
  imports: [DbModule, EventsModule, FinanceModule],
  controllers: [ContractsController],
  providers: [ContractsService],
  exports: [ContractsService],
})
export class ContractsModule {}
