import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  runGloberentMonitor,
  type GloberentMonitorCoreClient,
  type MonitorContractRow,
  type MonitorUnitRow,
} from "./globerent-monitor";

/** Заглушка Core-клиента: копит отправленные события. */
function stubCore(units: MonitorUnitRow[] | Error, contracts: MonitorContractRow[] | Error) {
  const events: { type: string; payload?: Record<string, unknown> }[] = [];
  const core: GloberentMonitorCoreClient = {
    globerentUnits: () =>
      units instanceof Error ? Promise.reject(units) : Promise.resolve(units),
    globerentContracts: () =>
      contracts instanceof Error ? Promise.reject(contracts) : Promise.resolve(contracts),
    recordEvent: (e) => {
      events.push({ type: e.type, ...(e.payload !== undefined ? { payload: e.payload } : {}) });
      return Promise.resolve({});
    },
  };
  return { core, events };
}

const unit = (over: Partial<MonitorUnitRow>): MonitorUnitRow => ({
  code: "WH-0001",
  name: "HELI CPD30",
  status: "IN_STOCK",
  declarationNumber: null,
  ...over,
});

const contract = (over: Partial<MonitorContractRow>): MonitorContractRow => ({
  id: "c1",
  contractNo: "12",
  status: "active",
  totalWithVat: "100000000",
  paidUzs: 0,
  ...over,
});

describe("монитор инвариантов конвейера GLOBERENT", () => {
  it("единица в ИМ-74/ИМ-40 без номера ГТД — событие; с номером и вне таможни — нет", async () => {
    const { core, events } = stubCore(
      [
        unit({ code: "WH-0001", status: "IM74" }), // нарушение
        unit({ code: "WH-0002", status: "IM40", declarationNumber: "  " }), // пустой номер = нарушение
        unit({ code: "WH-0003", status: "IM40", declarationNumber: "26010/04.08.2026/0012345" }),
        unit({ code: "WH-0004", status: "IN_STOCK" }), // склад — ГТД не проверяем
      ],
      [],
    );
    const r = await runGloberentMonitor(core);
    assert.equal(r.unitsNoGtd, 2);
    assert.deepEqual(
      events.filter((e) => e.type === "globerent.unit_no_gtd").map((e) => e.payload?.["code"]),
      ["WH-0001", "WH-0002"],
    );
  });

  it("договор действует и оплачен полностью — событие; частичная оплата и закрытый — нет", async () => {
    const { core, events } = stubCore(
      [],
      [
        contract({ id: "c1", contractNo: "5", paidUzs: 100_000_000 }), // оплачен, не закрыт
        contract({ id: "c2", contractNo: "6", paidUzs: 40_000_000 }), // платится
        contract({ id: "c3", contractNo: "7", status: "closed", paidUzs: 100_000_000 }), // закрыт — порядок
        contract({ id: "c4", contractNo: "8", status: "cancelled", paidUzs: 100_000_000 }),
      ],
    );
    const r = await runGloberentMonitor(core);
    assert.equal(r.contractsPaidUnclosed, 1);
    assert.equal(events[0]?.payload?.["contractNo"], "5");
  });

  it("кривая или нулевая сумма договора — инвариант молчит, не выдумывает", async () => {
    const { core } = stubCore(
      [],
      [
        contract({ totalWithVat: "0", paidUzs: 1 }),
        contract({ totalWithVat: "мусор", paidUzs: 1 }),
      ],
    );
    const r = await runGloberentMonitor(core);
    assert.equal(r.contractsPaidUnclosed, 0);
  });

  it("сбой одного источника не прячет сигналы другого", async () => {
    const { core, events } = stubCore(new Error("units down"), [
      contract({ paidUzs: 100_000_000 }),
    ]);
    const r = await runGloberentMonitor(core);
    assert.equal(r.contractsPaidUnclosed, 1);
    assert.equal(events.length, 1);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0] ?? "", /единицы/);
  });
});
