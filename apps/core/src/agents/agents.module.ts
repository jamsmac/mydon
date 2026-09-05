import { Module } from "@nestjs/common";
import { OwnerMutationGuard } from "../common/owner-mutation.guard";
import { TasksModule } from "../tasks/tasks.module";
import { AgentsController } from "./agents.controller";
import { AgentsService } from "./agents.service";

@Module({
  // TasksModule ИМПОРТИРУЕМ, а не переобъявляем провайдер: запуск навыка из
  // панели создаёт обычную задачу (R-SD-2), и второй экземпляр TasksService
  // разошёлся бы с первым по зависимостям (ТО, шина событий, ledger).
  imports: [TasksModule],
  controllers: [AgentsController],
  providers: [AgentsService, OwnerMutationGuard],
  exports: [AgentsService],
})
export class AgentsModule {}
