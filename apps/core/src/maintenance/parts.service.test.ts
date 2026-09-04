import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PartsService, attentionOf, partUnitLabel, type PartUnitRow, type PartWhereabouts } from "./parts.service";

const unit = (over: Partial<PartUnitRow> = {}): PartUnitRow => ({
  id: "u1",
  partKind: "mixer",
  inventoryNo: "M-001",
  labelPending: false,
  serialNumber: null,
  model: null,
  manufacturer: null,
  setNumber: null,
  hopperPosition: null,
  tareWeight: null,
  purchaseDate: null,
  purchasePrice: null,
  warrantyUntil: null,
  retiredAt: null,
  retiredReason: null,
  origin: "manual",
  note: null,
  createdBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const onMachine: PartWhereabouts = {
  location: "machine",
  machineId: "m",
  machineName: "Автомат 12",
  slot: 1,
  since: "2026-09-01",
  periodId: "p",
};

describe("Внимание к узлу (R-PU-4, R-PU-6, R-PU-9)", () => {
  it("учтённый узел с фото — ничего не требует", () => {
    assert.deepEqual(attentionOf(unit(), onMachine, 1), []);
  });

  it("без номера → no_number; с номером, но наклейка не подтверждена → label_pending", () => {
    assert.deepEqual(attentionOf(unit({ inventoryNo: null }), onMachine, 1), ["no_number"]);
    assert.deepEqual(attentionOf(unit({ labelPending: true }), onMachine, 1), ["label_pending"]);
  });

  it("нет открытого периода или период unknown → местонахождение неизвестно", () => {
    assert.deepEqual(attentionOf(unit(), null, 1), ["unknown_location"]);
    assert.deepEqual(attentionOf(unit(), { ...onMachine, location: "unknown", machineId: null }, 1), ["unknown_location"]);
  });

  it("бункер без тары — no_tare; без фото — no_photo; списанный узел внимания не требует", () => {
    assert.deepEqual(attentionOf(unit({ partKind: "hopper", inventoryNo: "H-27-3" }), onMachine, 0), ["no_tare", "no_photo"]);
    assert.deepEqual(attentionOf(unit({ inventoryNo: null, retiredAt: "2026-09-01" }), null, 0), []);
  });

  it("подпись: вид + номер, без номера — словами", () => {
    assert.equal(partUnitLabel(unit()), "Миксер M-001");
    assert.equal(partUnitLabel(unit({ partKind: "hopper", inventoryNo: null })), "Бункер (без номера)");
  });
});

describe("Номер с наклейки — проверка формата до базы", () => {
  function stub(existing: Record<string, unknown>) {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.limit = async () => [existing];
    chain.then = (res: (v: unknown) => unknown) => Promise.resolve([existing]).then(res);
    const tx = { select: () => chain, insert: () => ({ values: async () => [] }), update: () => ({ set: () => ({ where: () => ({ returning: async () => [existing] }) }) }) };
    return { select: () => chain, transaction: async <T>(cb: (t: typeof tx) => Promise<T>) => cb(tx) } as never;
  }

  it("кириллица и мусор в номере — отказ до записи", async () => {
    const s = new PartsService(stub(unit()));
    await assert.rejects(s.assignNumber("u1", { inventoryNo: "М-001" }), /латиница/);
    await assert.rejects(s.assignNumber("u1", { inventoryNo: "-" }), /латиница/);
  });
});
