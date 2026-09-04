import { Module } from "@nestjs/common";
import { MaintenanceController } from "./maintenance.controller";
import { MaintenanceService } from "./maintenance.service";
import { PartCountController } from "./part-count.controller";
import { PartCountService } from "./part-count.service";
import { PartsController } from "./parts.controller";
import { PartsService } from "./parts.service";

@Module({
  controllers: [MaintenanceController, PartsController, PartCountController],
  providers: [MaintenanceService, PartsService, PartCountService],
  exports: [MaintenanceService, PartsService, PartCountService],
})
export class MaintenanceModule {}
