import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VendingService } from "./vending.service";

type Row = { machineSerial: string; coilId: string; productName: string | null; capacity: number; quantity: number };

/** Стаб БД: machines()/deficitSummary() читают `select().from()`. */
function readDb(rows: Row[]) {
  return { select: () => ({ from: async () => rows }) } as never;
}

/** Стаб БД для ingest: копит вставки. */
function writeDb() {
  const inserts: { table: string; values: unknown }[] = [];
  const tx = {
    insert: (table: { [Symbol.toStringTag]?: string }) => ({
      values: (v: unknown) => {
        const name = tableName(table);
        inserts.push({ table: name, values: v });
        return { onConflictDoUpdate: () => Promise.resolve() };
      },
    }),
  };
  const db = { transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx) } as never;
  return { db, inserts };
}
function tableName(t: unknown): string {
  // drizzle-таблица знает своё имя; для стаба достаточно эвристики по ключам.
  const keys = Object.keys((t ?? {}) as Record<string, unknown>);
  return keys.includes("capturedAt") && !keys.includes("syncedAt") ? "slot_snapshot" : "machine_slot";
}

const slot = (machineSerial: string, coilId: string, productName: string | null, capacity: number, quantity: number): Row => ({
  machineSerial,
  coilId,
  productName,
  capacity,
  quantity,
});

describe("Вендинг Core: дефицит по автоматам (Фаза 1c)", () => {
  it("считает дефицит/заполненность, статус, сортировку", async () => {
    const rows = [
      // AH: два валидных слота — дефицит (6-0)+(6-1)=11
      slot("AH", "31", "Montella", 6, 0),
      slot("AH", "34", "CocaCola", 6, 1),
      // NOSLOT: слоты без товара → no_slots, в конце
      slot("NOSLOT", "1", null, 6, 0),
    ];
    const svc = new VendingService(readDb(rows));
    const machines = await svc.machines();
    const ah = machines.find((m) => m.serial === "AH")!;
    assert.equal(ah.status, "ok");
    assert.equal(ah.deficit, 11);
    assert.equal(ah.capacity, 12);
    assert.equal(ah.fillRate, 8); // round(1/12*100)
    // no_slots-автомат уходит в конец.
    assert.equal(machines[machines.length - 1].serial, "NOSLOT");
    assert.equal(machines[machines.length - 1].status, "no_slots");
  });

  it("сводная потребность по товарам — только ok, с разбивкой", async () => {
    const rows = [
      slot("AH", "31", "Montella", 6, 0), // деф 6
      slot("Olma", "40", "Montella", 6, 3), // деф 3
      slot("Olma", "41", "Fanta", 6, 6), // деф 0 — не в сводке
    ];
    const svc = new VendingService(readDb(rows));
    const summary = await svc.deficitSummary();
    const m = summary.find((s) => s.product === "Montella")!;
    assert.equal(m.total, 9);
    assert.deepEqual(m.perMachine, { AH: 6, Olma: 3 });
    assert.ok(!summary.some((s) => s.product === "Fanta"), "нулевой дефицит не попадает в сводку");
  });
});

describe("Вендинг Core: приём слотов", () => {
  it("пишет актуальный слот и снапшот, считает is_valid", async () => {
    const { db, inserts } = writeDb();
    const svc = new VendingService(db);
    const res = await svc.ingestSlots({
      machines: [{ serial: "AH", slots: [{ coilId: "31", product: "Montella", capacity: 6, quantity: 0 }] }],
    });
    assert.deepEqual(res, { machines: 1, slots: 1 });
    // Один слот → одна строка планограммы + одна строка истории.
    assert.equal(inserts.filter((i) => i.table === "machine_slot").length, 1);
    assert.equal(inserts.filter((i) => i.table === "slot_snapshot").length, 1);
    const ms = inserts.find((i) => i.table === "machine_slot")!.values as { isValid: boolean; productName: string | null };
    assert.equal(ms.isValid, true); // 0 < 6 ≤ 100
    assert.equal(ms.productName, "Montella");
  });

  it("пустое имя товара → null (слот не назначен), вместимость 0 → невалиден", async () => {
    const { db, inserts } = writeDb();
    const svc = new VendingService(db);
    await svc.ingestSlots({ machines: [{ serial: "M", slots: [{ coilId: "1", product: "  ", capacity: 0, quantity: 0 }] }] });
    const ms = inserts.find((i) => i.table === "machine_slot")!.values as { isValid: boolean; productName: string | null };
    assert.equal(ms.productName, null);
    assert.equal(ms.isValid, false);
  });
});
