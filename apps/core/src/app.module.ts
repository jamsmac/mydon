import { Module } from "@nestjs/common";
import { ApprovalsModule } from "./approvals/approvals.module";
import { AuditModule } from "./audit/audit.module";
import { DbModule } from "./db/db.module";
import { EntitiesModule } from "./entities/entities.module";
import { EventsModule } from "./events/events.module";
import { HealthController } from "./health.controller";
import { RegistryModule } from "./registry/registry.module";
import { RulesModule } from "./rules/rules.module";
import { VerificationModule } from "./verification/verification.module";

@Module({
  imports: [
    DbModule,
    AuditModule,
    EntitiesModule,
    EventsModule,
    ApprovalsModule,
    RegistryModule,
    RulesModule,
    VerificationModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
