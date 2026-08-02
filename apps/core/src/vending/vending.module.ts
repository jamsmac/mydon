import { Module } from "@nestjs/common";
import { VendingController } from "./vending.controller";
import { VendingService } from "./vending.service";

@Module({
  controllers: [VendingController],
  providers: [VendingService],
  exports: [VendingService],
})
export class VendingModule {}
