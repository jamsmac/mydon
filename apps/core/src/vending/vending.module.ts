import { Module } from "@nestjs/common";
import { ApprovalsModule } from "../approvals/approvals.module";
import { RefillEventsService } from "./refill-events.service";
import { RefillService } from "./refill.service";
import { VendingController } from "./vending.controller";
import { VendingService } from "./vending.service";

@Module({
  imports: [ApprovalsModule],
  controllers: [VendingController],
  providers: [VendingService, RefillService, RefillEventsService],
  exports: [VendingService, RefillService, RefillEventsService],
})
export class VendingModule {}
