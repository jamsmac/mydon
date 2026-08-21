import { Module } from "@nestjs/common";
import { CollectionsModule } from "../collections/collections.module";
import { FinanceModule } from "../finance/finance.module";
import { GapsController } from "./gaps.controller";
import { GapsService } from "./gaps.service";

/**
 * Реестр пробелов (срез К, задача 5): вычисляемый на чтении список того,
 * что нельзя посчитать сейчас. Опирается на готовые `CollectionsService` и
 * `FinanceService` — их сходимость и сверка кассы здесь не дублируются.
 */
@Module({
  imports: [CollectionsModule, FinanceModule],
  controllers: [GapsController],
  providers: [GapsService],
  exports: [GapsService],
})
export class GapsModule {}
