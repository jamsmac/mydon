import { Module } from "@nestjs/common";
import { CoffeeController } from "./coffee.controller";
import { CoffeeService } from "./coffee.service";
import { CoffeeOrdersService } from "./coffee-orders.service";

@Module({
  controllers: [CoffeeController],
  providers: [CoffeeService, CoffeeOrdersService],
  exports: [CoffeeService, CoffeeOrdersService],
})
export class CoffeeModule {}
