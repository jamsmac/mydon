import { Module } from "@nestjs/common";
import { StockModule } from "../stock/stock.module";
import { CoffeeController } from "./coffee.controller";
import { CoffeeLedgerService } from "./coffee-ledger.service";
import { CoffeeService } from "./coffee.service";
import { CoffeeOrdersService } from "./coffee-orders.service";
import { NormFactController } from "./norm-fact.controller";
import { NormFactService } from "./norm-fact.service";

@Module({
  imports: [StockModule],
  controllers: [CoffeeController, NormFactController],
  providers: [CoffeeService, CoffeeOrdersService, NormFactService, CoffeeLedgerService],
  exports: [CoffeeService, CoffeeOrdersService, NormFactService, CoffeeLedgerService],
})
export class CoffeeModule {}
