import { Module } from "@nestjs/common";
import { ApprovalsModule } from "../approvals/approvals.module";
import { StockModule } from "../stock/stock.module";
import { CoffeeController } from "./coffee.controller";
import { CoffeeLedgerService } from "./coffee-ledger.service";
import { VisitsService } from "./visits.service";
import { CoffeeService } from "./coffee.service";
import { CoffeeOrdersService } from "./coffee-orders.service";
import { CoffeeOrdersStaleService } from "./orders-stale.service";
import { NormFactController } from "./norm-fact.controller";
import { NormFactService } from "./norm-fact.service";

@Module({
  imports: [StockModule, ApprovalsModule],
  controllers: [CoffeeController, NormFactController],
  providers: [CoffeeService, CoffeeOrdersService, NormFactService, CoffeeLedgerService, CoffeeOrdersStaleService, VisitsService],
  exports: [CoffeeService, CoffeeOrdersService, NormFactService, CoffeeLedgerService, VisitsService],
})
export class CoffeeModule {}
