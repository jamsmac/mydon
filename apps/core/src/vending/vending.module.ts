import { Module } from "@nestjs/common";
import { ApprovalsModule } from "../approvals/approvals.module";
import { VendingController } from "./vending.controller";
import { VendingService } from "./vending.service";

@Module({
  imports: [ApprovalsModule],
  controllers: [VendingController],
  providers: [VendingService],
  exports: [VendingService],
})
export class VendingModule {}
