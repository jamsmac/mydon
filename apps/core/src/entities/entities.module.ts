import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { EntitiesController } from "./entities.controller";
import { EntitiesService } from "./entities.service";

@Module({
  imports: [AuditModule],
  controllers: [EntitiesController],
  providers: [EntitiesService],
  exports: [EntitiesService],
})
export class EntitiesModule {}
