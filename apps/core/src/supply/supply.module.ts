import { Module } from "@nestjs/common";
import { SupplyController } from "./supply.controller";
import { SupplyService } from "./supply.service";

@Module({
  controllers: [SupplyController],
  providers: [SupplyService],
  exports: [SupplyService],
})
export class SupplyModule {}
