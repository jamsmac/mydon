import { Module } from "@nestjs/common";
import { CoffeeController } from "./coffee.controller";
import { CoffeeService } from "./coffee.service";
import { CoffeeOrdersService } from "./coffee-orders.service";
import { NormFactController } from "./norm-fact.controller";
import { NormFactService } from "./norm-fact.service";

@Module({
  controllers: [CoffeeController, NormFactController],
  providers: [CoffeeService, CoffeeOrdersService, NormFactService],
  exports: [CoffeeService, CoffeeOrdersService, NormFactService],
})
export class CoffeeModule {}
