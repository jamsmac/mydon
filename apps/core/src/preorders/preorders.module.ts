import { Module } from "@nestjs/common";
import { DbModule } from "../db/db.module";
import { EventsModule } from "../events/events.module";
import { PreordersController } from "./preorders.controller";
import { PreordersService } from "./preorders.service";

/** Предзаказы GLOBERENT (перенос pre_orders PROMACH). */
@Module({
  imports: [DbModule, EventsModule],
  controllers: [PreordersController],
  providers: [PreordersService],
  exports: [PreordersService],
})
export class PreordersModule {}
