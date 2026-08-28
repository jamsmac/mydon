import { Module } from "@nestjs/common";
import { EventsModule } from "../events/events.module";
import { MaintenanceModule } from "../maintenance/maintenance.module";
import { VendingModule } from "../vending/vending.module";
import { TaskBridgeService } from "./task-bridge.service";
import { TasksController } from "./tasks.controller";
import { TasksService } from "./tasks.service";

@Module({
  // Maintenance — ради хука «закрыл задачу ТО → факт в журнале обслуживания».
  imports: [MaintenanceModule, EventsModule, VendingModule],
  controllers: [TasksController],
  providers: [TasksService, TaskBridgeService],
  exports: [TasksService],
})
export class TasksModule {}
