import { Module } from "@nestjs/common";
import { EventsModule } from "../events/events.module";
import { RawController } from "./raw.controller";
import { RawService } from "./raw.service";

@Module({
  imports: [EventsModule],
  controllers: [RawController],
  providers: [RawService],
  exports: [RawService],
})
export class RawModule {}
