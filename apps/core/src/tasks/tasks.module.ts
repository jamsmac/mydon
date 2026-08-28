import { Module } from "@nestjs/common";
import { EventsModule } from "../events/events.module";
import { MaintenanceModule } from "../maintenance/maintenance.module";
import { RulesModule } from "../rules/rules.module";
import { VendingModule } from "../vending/vending.module";
import { TaskBridgeService } from "./task-bridge.service";
import { TasksController } from "./tasks.controller";
import { TasksService } from "./tasks.service";

@Module({
  // Maintenance — ради хука «закрыл задачу ТО → факт в журнале обслуживания».
  // RulesModule нужен мосту ради атомарных одноразовых ключей дедупа, а не для
  // исполнения правил внутри модуля задач.
  imports: [MaintenanceModule, EventsModule, VendingModule, RulesModule],
  controllers: [TasksController],
  providers: [TasksService, TaskBridgeService],
  exports: [TasksService],
})
export class TasksModule {}
