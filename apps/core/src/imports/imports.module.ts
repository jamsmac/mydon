import { Module } from "@nestjs/common";
import { DbModule } from "../db/db.module";
import { EventsModule } from "../events/events.module";
import { FinanceModule } from "../finance/finance.module";
import { ImportsController } from "./imports.controller";
import { ImportsService } from "./imports.service";

/** Импортные контракты GLOBERENT (перенос import_contracts PROMACH). */
@Module({
  imports: [DbModule, EventsModule, FinanceModule],
  controllers: [ImportsController],
  providers: [ImportsService],
  exports: [ImportsService],
})
export class ImportsModule {}
