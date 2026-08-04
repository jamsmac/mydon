import { Module } from "@nestjs/common";
import { DbModule } from "../db/db.module";
import { FinanceController } from "./finance.controller";
import { FinanceService } from "./finance.service";

/** Финансовый контур направлений: модель платежа и агинг из PROMACH. */
@Module({
  imports: [DbModule],
  controllers: [FinanceController],
  providers: [FinanceService],
  exports: [FinanceService],
})
export class FinanceModule {}
