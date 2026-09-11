import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { EntitiesController } from "./entities.controller";
import { EntitiesService } from "./entities.service";
import { PlaceCardService } from "./place-card.service";
import { PlaceMergeService } from "./place-merge.service";

@Module({
  imports: [AuditModule],
  controllers: [EntitiesController],
  providers: [EntitiesService, PlaceCardService, PlaceMergeService],
  exports: [EntitiesService, PlaceCardService],
})
export class EntitiesModule {}
