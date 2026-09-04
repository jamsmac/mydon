import { Module } from "@nestjs/common";
import { MaintenanceController } from "./maintenance.controller";
import { MaintenanceService } from "./maintenance.service";
import { PartsController } from "./parts.controller";
import { PartsService } from "./parts.service";

@Module({
  controllers: [MaintenanceController, PartsController],
  providers: [MaintenanceService, PartsService],
  exports: [MaintenanceService, PartsService],
})
export class MaintenanceModule {}
