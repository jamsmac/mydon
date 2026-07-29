import { Controller, Get, Query } from "@nestjs/common";
import { SupplyService } from "./supply.service";

/** Снабжение: приход и остатки в автоматах (этап 2 миграции). */
@Controller("supply")
export class SupplyController {
  constructor(private readonly supply: SupplyService) {}

  @Get("summary")
  summary() {
    return this.supply.summary();
  }

  @Get("machine-stock")
  machineStock() {
    return this.supply.machineLevels();
  }

  @Get("purchases")
  purchases(@Query("days") days?: string, @Query("limit") limit?: string) {
    const d = Number(days);
    const l = Number(limit);
    return this.supply.purchases(
      Number.isFinite(d) && d > 0 ? Math.min(d, 365) : 30,
      Number.isFinite(l) && l > 0 ? Math.min(l, 1000) : 300,
    );
  }
}
