import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
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
import { GapsModule } from "./gaps/gaps.module";
import { HealthController } from "./health.controller";
import { HistoryModule } from "./history/history.module";
import { ImportsModule } from "./imports/imports.module";
import { KpModule } from "./kp/kp.module";
import { LlmLedgerModule } from "./llm-ledger/llm-ledger.module";
import { MaintenanceModule } from "./maintenance/maintenance.module";
import { NotesModule } from "./notes/notes.module";
import { OutboxModule } from "./outbox/outbox.module";
import { PeopleModule } from "./people/people.module";
import { PreordersModule } from "./preorders/preorders.module";
import { RawModule } from "./raw/raw.module";
import { RegistryModule } from "./registry/registry.module";
import { OurvendModule } from "./ourvend/ourvend.module";
import { RegistryImportModule } from "./registry-import/registry-import.module";
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
    ThrottlerModule.forRoot([
      { name: "burst", ttl: 10_000, limit: 60 },
      { name: "sustained", ttl: 60_000, limit: 600 },
    ]),
    DbModule,
    AgentsModule,
    AttachmentsModule,
    AuditModule,
    CatalogModule,
    CoffeeModule,
    ContractsModule,
    CollectionsModule,
    MaintenanceModule,
    EntitiesModule,
    EventsModule,
    ApprovalsModule,
    FinanceModule,
    GapsModule,
    RegistryModule,
    RegistryImportModule,
    RulesModule,
    OurvendModule,
    SalesModule,
    StockModule,
    SupplyModule,
    SystemModule,
    VendingModule,
    HistoryModule,
    ImportsModule,
    KpModule,
    LlmLedgerModule,
    NotesModule,
    OutboxModule,
    PeopleModule,
    PreordersModule,
    RawModule,
    TasksModule,
    UnitsModule,
    VerificationModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: ServiceTokenGuard },
  ],
})
export class AppModule {}
