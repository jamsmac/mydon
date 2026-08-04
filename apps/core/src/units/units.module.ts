import { Module } from "@nestjs/common";
import { DbModule } from "../db/db.module";
import { EventsModule } from "../events/events.module";
import { UnitsController } from "./units.controller";
import { UnitsService } from "./units.service";

/** Склад техники GLOBERENT: конвейер единиц и резервы (перенос PROMACH). */
@Module({
  imports: [DbModule, EventsModule],
  controllers: [UnitsController],
  providers: [UnitsService],
  exports: [UnitsService],
})
export class UnitsModule {}
