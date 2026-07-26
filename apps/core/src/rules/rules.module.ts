import { Module } from "@nestjs/common";
import { EventsModule } from "../events/events.module";
import { IngestController } from "../ingest/ingest.controller";
import { RulesController } from "./rules.controller";
import { RulesService } from "./rules.service";

@Module({
  imports: [EventsModule],
  controllers: [RulesController, IngestController],
  providers: [RulesService],
  exports: [RulesService],
})
export class RulesModule {}
