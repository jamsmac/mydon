import { Module } from "@nestjs/common";
import { MaintenanceModule } from "../maintenance/maintenance.module";
import { TasksController } from "./tasks.controller";
import { TasksService } from "./tasks.service";

@Module({
  // Maintenance — ради хука «закрыл задачу ТО → факт в журнале обслуживания».
  imports: [MaintenanceModule],
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
