import { Module } from "@nestjs/common";
import { StockController } from "./stock.controller";
import { StockService } from "./stock.service";
import { VendingLedgerService } from "./vending-ledger";

@Module({
  controllers: [StockController],
  providers: [StockService, VendingLedgerService],
  exports: [StockService, VendingLedgerService],
})
export class StockModule {}
