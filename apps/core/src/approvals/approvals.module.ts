import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { OwnerMutationGuard } from "../common/owner-mutation.guard";
import { EventsModule } from "../events/events.module";
import { ApprovalsController } from "./approvals.controller";
import { ApprovalsService } from "./approvals.service";

@Module({
  imports: [AuditModule, EventsModule],
  controllers: [ApprovalsController],
  providers: [ApprovalsService, OwnerMutationGuard],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
