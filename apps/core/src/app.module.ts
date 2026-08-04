import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ServiceTokenGuard } from "./common/service-token.guard";
import { AgentsModule } from "./agents/agents.module";
import { ApprovalsModule } from "./approvals/approvals.module";
import { AttachmentsModule } from "./attachments/attachments.module";
import { AuditModule } from "./audit/audit.module";
import { CatalogModule } from "./catalog/catalog.module";
import { CoffeeModule } from "./coffee/coffee.module";
import { ContractsModule } from "./contracts/contracts.module";
import { CollectionsModule } from "./collections/collections.module";
import { DbModule } from "./db/db.module";
import { EntitiesModule } from "./entities/entities.module";
import { EventsModule } from "./events/events.module";
import { FinanceModule } from "./finance/finance.module";
import { HealthController } from "./health.controller";
import { HistoryModule } from "./history/history.module";
import { ImportsModule } from "./imports/imports.module";
import { NotesModule } from "./notes/notes.module";
import { PeopleModule } from "./people/people.module";
import { RawModule } from "./raw/raw.module";
import { RegistryModule } from "./registry/registry.module";
import { RulesModule } from "./rules/rules.module";
import { SalesModule } from "./sales/sales.module";
import { StockModule } from "./stock/stock.module";
import { SupplyModule } from "./supply/supply.module";
import { SystemModule } from "./system/system.module";
import { TasksModule } from "./tasks/tasks.module";
import { UnitsModule } from "./units/units.module";
import { VendingModule } from "./vending/vending.module";
import { VerificationModule } from "./verification/verification.module";

@Module({
  imports: [
    DbModule,
    AgentsModule,
    AttachmentsModule,
    AuditModule,
    CatalogModule,
    CoffeeModule,
    ContractsModule,
    CollectionsModule,
    EntitiesModule,
    EventsModule,
    ApprovalsModule,
    FinanceModule,
    RegistryModule,
    RulesModule,
    SalesModule,
    StockModule,
    SupplyModule,
    SystemModule,
    VendingModule,
    HistoryModule,
    ImportsModule,
    NotesModule,
    PeopleModule,
    RawModule,
    TasksModule,
    UnitsModule,
    VerificationModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ServiceTokenGuard }],
})
export class AppModule {}
