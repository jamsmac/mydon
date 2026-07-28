import { Module } from "@nestjs/common";
import { AgentsModule } from "./agents/agents.module";
import { ApprovalsModule } from "./approvals/approvals.module";
import { AuditModule } from "./audit/audit.module";
import { DbModule } from "./db/db.module";
import { EntitiesModule } from "./entities/entities.module";
import { EventsModule } from "./events/events.module";
import { HealthController } from "./health.controller";
import { NotesModule } from "./notes/notes.module";
import { PeopleModule } from "./people/people.module";
import { RegistryModule } from "./registry/registry.module";
import { RulesModule } from "./rules/rules.module";
import { TasksModule } from "./tasks/tasks.module";
import { VerificationModule } from "./verification/verification.module";

@Module({
  imports: [
    DbModule,
    AgentsModule,
    AuditModule,
    EntitiesModule,
    EventsModule,
    ApprovalsModule,
    RegistryModule,
    RulesModule,
    NotesModule,
    PeopleModule,
    TasksModule,
    VerificationModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
