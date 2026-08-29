import { Module } from "@nestjs/common";
import { OwnerActionGuard } from "../common/owner-action.guard";
import { EventsModule } from "../events/events.module";
import { MaintenanceModule } from "../maintenance/maintenance.module";
import { LlmLedgerModule } from "../llm-ledger/llm-ledger.module";
import { RulesModule } from "../rules/rules.module";
import { VendingModule } from "../vending/vending.module";
import { TaskBridgeService } from "./task-bridge.service";
import { TaskLlmJobsController } from "./task-llm-jobs.controller";
import { TaskLlmJobsService } from "./task-llm-jobs.service";
import { TasksController } from "./tasks.controller";
import { TasksService } from "./tasks.service";

@Module({
  // Maintenance — ради хука «закрыл задачу ТО → факт в журнале обслуживания».
  // RulesModule нужен мосту ради атомарных одноразовых ключей дедупа, а не для
  // исполнения правил внутри модуля задач.
  imports: [MaintenanceModule, EventsModule, VendingModule, RulesModule, LlmLedgerModule],
  controllers: [TasksController, TaskLlmJobsController],
  providers: [TasksService, TaskBridgeService, TaskLlmJobsService, OwnerActionGuard],
  exports: [TasksService],
})
export class TasksModule {}
