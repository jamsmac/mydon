import { Module } from "@nestjs/common";
import { OwnerMutationGuard } from "../common/owner-mutation.guard";
import { AgentsController } from "./agents.controller";
import { AgentsService } from "./agents.service";

@Module({
  controllers: [AgentsController],
  providers: [AgentsService, OwnerMutationGuard],
  exports: [AgentsService],
})
export class AgentsModule {}
