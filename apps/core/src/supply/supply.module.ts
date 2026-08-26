import { Module } from "@nestjs/common";
import { VendingModule } from "../vending/vending.module";
import { SupplyController } from "./supply.controller";
import { SupplyService } from "./supply.service";

/**
 * `VendingModule` — ради ОДНОГО вопроса: какие автоматы не в строю (R-P8b-4).
 *
 * Импорт односторонний и цикла не даёт: вендинг о снабжении не знает вовсе.
 * Свой запрос к `machine_card` здесь был бы третьей копией правила «не в строю»
 * (первые две — план закупа и паритет), и она разошлась бы с ними в тот день,
 * когда владелец заведёт новый статус карточки.
 */
@Module({
  imports: [VendingModule],
  controllers: [SupplyController],
  providers: [SupplyService],
  exports: [SupplyService],
})
export class SupplyModule {}
