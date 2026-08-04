import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UnitsService } from "./units.service";

type Row = Record<string, unknown>;

/**
 * Guard'ы склада: конвейерные переходы, VIN, резервы и стадии продажи
 * отбивают запрещённое ДО записи (матрица — в shared, здесь её применение).
 */
function stubDb(opts: { existing?: Row; updated?: Row | null }) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => (opts.existing ? [opts.existing] : []),
    for: async () => (opts.existing ? [opts.existing] : []),
    orderBy: () => chain,
    groupBy: async () => [],
  };
  const tx = {
    select: () => chain,
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => (opts.updated === null ? [] : [opts.updated ?? { ...opts.existing }]),
        }),
      }),
    }),
    insert: () => ({ values: () => ({ returning: async () => [opts.updated ?? {}] }) }),
  };
  return {
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
    select: () => chain,
    update: tx.update,
    insert: tx.insert,
    execute: async () => undefined,
  } as never;
}

const noopEvents = { record: async () => undefined } as never;

function service(opts: { existing?: Row; updated?: Row | null }): UnitsService {
  return new UnitsService(stubDb(opts), noopEvents);
}

describe("UnitsService.applyAction — применение матрицы", () => {
  it("разрешённый переход проходит: CONTRACT_SIGNED → READY_FOR_SHIPMENT", async () => {
    const s = service({
      existing: { id: "u1", status: "CONTRACT_SIGNED" },
      updated: { id: "u1", status: "READY_FOR_SHIPMENT" },
    });
    const r = await s.applyAction("u1", "mark-ready-to-ship");
    assert.equal(r.status, "READY_FOR_SHIPMENT");
  });

  it("запрещённый переход отбивается: доставленную нельзя «в путь»", async () => {
    const s = service({ existing: { id: "u1", status: "DELIVERED_TO_WH" } });
    await assert.rejects(
      () => s.applyAction("u1", "mark-in-transit", { transportCompany: "Truck" }),
      /невозможен/,
    );
  });

  it("«в пути» без перевозчика — отказ до базы", async () => {
    const s = service({});
    await assert.rejects(() => s.applyAction("u1", "mark-in-transit"), /перевозчика/);
  });

  it("ГТД без номера или с кривой датой — отказ", async () => {
    const s = service({});
    await assert.rejects(() => s.applyAction("u1", "mark-customs-im40", {}), /номер ГТД/);
    await assert.rejects(
      () => s.applyAction("u1", "mark-customs-im40", { declarationNumber: "123", declarationDate: "вчера" }),
      /ГГГГ-ММ-ДД/,
    );
  });

  it("гонка: UPDATE с WHERE-статусом ничего не вернул — конфликт, не тихий успех", async () => {
    const s = service({ existing: { id: "u1", status: "CONTRACT_SIGNED" }, updated: null });
    await assert.rejects(() => s.applyAction("u1", "mark-ready-to-ship"), /параллельным/);
  });
});

describe("UnitsService — VIN и резервы", () => {
  it("откат VIN из IM40 запрещён (логист уже работал физически)", async () => {
    const s = service({ existing: { id: "u1", status: "IM40", vin: "LC0C123" } });
    await assert.rejects(() => s.unbindVin("u1"), /не откатывается/);
  });
  it("резерв на технику в пути — отказ", async () => {
    const s = service({ existing: { id: "u1", status: "IN_TRANSIT_TO_UZ" } });
    await assert.rejects(() => s.reserve("u1", { endDate: "2099-01-01" }), /только на технику на складе/);
  });
  it("резерв с прошедшей датой — отказ до базы", async () => {
    const s = service({});
    await assert.rejects(() => s.reserve("u1", { endDate: "2020-01-01" }), /уже прошла/);
  });
});

describe("UnitsService.setSalesStage — guard'ы продажи", () => {
  it("старт продажи по технике в пути — отказ", async () => {
    const s = service({ existing: { id: "u1", status: "AT_BORDER", salesStage: null, salesPrice: null } });
    await assert.rejects(() => s.setSalesStage("u1", "NEW_LEAD"), /на складе или в резерве/);
  });
  it("стадия «ждём предоплату» без цены — отказ (guard донора)", async () => {
    const s = service({
      existing: { id: "u1", status: "IN_STOCK", salesStage: "WAITING_CONTRACT", salesPrice: null, lostReason: null },
    });
    await assert.rejects(() => s.setSalesStage("u1", "WAITING_ADVANCE"), /нужна цена продажи/);
  });
  it("LOST без причины — отказ", async () => {
    const s = service({});
    await assert.rejects(() => s.setSalesStage("u1", "LOST"), /причина/);
  });
});
