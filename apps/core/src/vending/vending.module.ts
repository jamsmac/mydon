import { Module } from "@nestjs/common";
import { ApprovalsModule } from "../approvals/approvals.module";
import { RefillEventsService } from "./refill-events.service";
import { RefillService } from "./refill.service";
import { ShrinkageService } from "./shrinkage.service";
import { VendingController } from "./vending.controller";
import { VendingService } from "./vending.service";

@Module({
  imports: [ApprovalsModule],
  controllers: [VendingController],
  providers: [VendingService, RefillService, RefillEventsService, ShrinkageService],
  exports: [VendingService, RefillService, RefillEventsService, ShrinkageService],
})
export class VendingModule {}
