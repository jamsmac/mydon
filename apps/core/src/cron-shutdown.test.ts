import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OurvendParityService } from "./ourvend/ourvend-parity.service";
import { SyncStaleService } from "./ourvend/sync-stale.service";
import { SalesService } from "./sales/sales.service";
import { StockService } from "./stock/stock.service";
import { SupplyService } from "./supply/supply.service";
import { TaskBridgeService } from "./tasks/task-bridge.service";
import { RetentionService } from "./vending/retention.service";
import { ShrinkageService } from "./vending/shrinkage.service";

interface CronOwner {
  cron: { stop(): void } | null;
  onApplicationShutdown(): void;
}

describe("Core cron shutdown", () => {
  for (const [name, create] of [
    ["sales", () => new SalesService({} as never)],
    ["supply", () => new SupplyService({} as never, {} as never)],
    ["stock", () => new StockService({} as never)],
    ["shrinkage", () => new ShrinkageService({} as never, {} as never)],
    ["sync-stale", () => new SyncStaleService({} as never)],
    // Паритет ходит по крону 08:40 и до П8b в этой таблице отсутствовал: его
    // `Cron` пережил бы остановку приложения и держал event loop открытым.
    ["ourvend-parity", () => new OurvendParityService({} as never, {} as never)],
    // Ретенция ходит по крону вс 04:10 (П8b, R-P8b-7) — тот же риск, что и у
    // остальных: непойманный `Cron` держит event loop открытым после shutdown.
    ["retention", () => new RetentionService({} as never)],
    ["task-bridge", () => new TaskBridgeService({} as never, {} as never, {} as never, {} as never, {} as never)],
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
