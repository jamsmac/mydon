import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SalesService } from "./sales/sales.service";
import { StockService } from "./stock/stock.service";
import { SupplyService } from "./supply/supply.service";
import { ShrinkageService } from "./vending/shrinkage.service";

interface CronOwner {
  cron: { stop(): void } | null;
  onApplicationShutdown(): void;
}

describe("Core cron shutdown", () => {
  for (const [name, create] of [
    ["sales", () => new SalesService({} as never)],
    ["supply", () => new SupplyService({} as never)],
    ["stock", () => new StockService({} as never)],
    ["shrinkage", () => new ShrinkageService({} as never, {} as never)],
  ] as const) {
    it(`останавливает ${name} cron и освобождает event loop`, () => {
      const service = create() as unknown as CronOwner;
      let stops = 0;
      service.cron = { stop: () => stops++ };

      service.onApplicationShutdown();

      assert.equal(stops, 1);
      assert.equal(service.cron, null);
    });
  }
});
