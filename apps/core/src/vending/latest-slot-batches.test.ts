import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VendingService } from "./vending.service";

interface SlotRow {
  machineSerial: string;
  coilId: string;
  productName: string | null;
  capacity: number;
  quantity: number;
  syncedAt: Date;
}

function service(rows: SlotRow[]): VendingService {
  const db = {
    select: () => ({
      from: () => ({ where: async () => rows }),
    }),
  } as never;
  return new VendingService(db);
}

describe("Последняя authoritative пачка machine_slot", () => {
  it("не смешивает старые ещё не pruned строки с новым батчем", async () => {
    const old = new Date("2026-08-31T03:00:00.000Z");
    const fresh = new Date("2026-08-31T06:00:00.000Z");
    const batches = await service([
      {
        machineSerial: "c2508160376",
        coilId: "1",
        productName: "Twix",
        capacity: 10,
        quantity: 0,
        syncedAt: old,
      },
      {
        machineSerial: "2508160376",
        coilId: "2",
        productName: "Snickers",
        capacity: 10,
        quantity: 8,
        syncedAt: fresh,
      },
    ]).latestSlotBatches(new Date("2026-08-30T06:00:00.000Z"));

    assert.deepEqual(batches.get("2508160376"), {
      syncedAt: fresh,
      slots: [{ coilId: "2", product: "Snickers", capacity: 10, quantity: 8 }],
    });
  });

  it("схлопывает две формы серийника и одинаковый coil последнего батча", async () => {
    const fresh = new Date("2026-08-31T06:00:00.000Z");
    const batches = await service([
      {
        machineSerial: "c2508160376",
        coilId: "2",
        productName: "старое имя",
        capacity: 10,
        quantity: 1,
        syncedAt: fresh,
      },
      {
        machineSerial: "2508160376",
        coilId: "2",
        productName: "Twix",
        capacity: 10,
        quantity: 1,
        syncedAt: fresh,
      },
      {
        machineSerial: "2508160376",
        coilId: "1",
        productName: "Cola",
        capacity: 8,
        quantity: 7,
        syncedAt: fresh,
      },
    ]).latestSlotBatches(new Date("2026-08-30T06:00:00.000Z"));

    assert.deepEqual(batches.get("2508160376")?.slots, [
      { coilId: "1", product: "Cola", capacity: 8, quantity: 7 },
      { coilId: "2", product: "Twix", capacity: 10, quantity: 1 },
    ]);
  });
});
