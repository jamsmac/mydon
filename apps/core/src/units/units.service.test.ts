import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { globerentUnit, moneyFlow, systemConfig } from "@mydon/db";
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

// ── Комиссия при закрытии сделки ────────────────────────────────────────────
//
// Провал начисления НЕ роняет закрытие (осознанный дизайн), но обязан
// оставить след: лог + событие unit.commission_failed в ленте. Молчаливый
// catch уже один раз оставил менеджера без комиссии незаметно.

interface RecordedEvent {
  source: string;
  type: string;
  payload?: Record<string, unknown>;
}

interface LogLine {
  level: "error" | "warn";
  message: string;
}

/**
 * Стаб БД для сценариев комиссии: раздаёт строки ПО ТАБЛИЦЕ (конфиг,
 * единица, платежи), пишет inserts в журнал вызовов. config: "boom" —
 * чтение тумблеров падает, как упавшая БД в момент начисления.
 */
function commissionStub(opts: {
  unit: Row;
  updated: Row;
  config: { key: string; value: string }[] | "boom";
  flows?: Row[];
}) {
  const inserts: { table: unknown; values: Row }[] = [];
  let table: unknown;
  const rowsFor = (): Row[] => {
    if (table === systemConfig) {
      if (opts.config === "boom") throw new Error("БД недоступна: system_config не читается");
      return opts.config;
    }
    if (table === globerentUnit) return [opts.unit];
    if (table === moneyFlow) return opts.flows ?? [];
    return [];
  };
  const chain = {
    from(t: unknown) {
      table = t;
      return chain;
    },
    where: () => chain,
    orderBy: () => chain,
    limit: async () => rowsFor(),
    for: async () => rowsFor(),
    groupBy: async () => [],
    then(resolve: (rows: Row[]) => void, reject: (e: unknown) => void) {
      try {
        resolve(rowsFor());
      } catch (e) {
        reject(e);
      }
    },
  };
  const insert = (t: unknown) => ({
    values: (v: Row) => {
      inserts.push({ table: t, values: v });
      // Как настоящая БД: returning отдаёт строку уже с id.
      return { returning: async () => [{ id: `row-${inserts.length}`, ...v }] };
    },
  });
  const update = () => ({
    set: () => ({ where: () => ({ returning: async () => [opts.updated] }) }),
  });
  const tx = { select: () => chain, update, insert };
  const db = {
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
    select: () => chain,
    update,
    insert,
    execute: async () => undefined,
  };
  return { db, inserts };
}

/** Сервис с перехватом событий и лога — чтобы провал был ПРОВЕРЯЕМО виден. */
function commissionService(
  opts: Parameters<typeof commissionStub>[0] & {
    /** Типы событий, на которых шина падает — как сбой БД в момент записи. */
    failEventTypes?: string[];
  },
) {
  const stub = commissionStub(opts);
  const events: RecordedEvent[] = [];
  const logs: LogLine[] = [];
  const eventsStub = {
    record: async (input: RecordedEvent) => {
      if (opts.failEventTypes?.includes(input.type)) {
        throw new Error(`шина событий недоступна (${input.type})`);
      }
      events.push(input);
      return {};
    },
  };
  const s = new UnitsService(stub.db as never, eventsStub as never);
  (s as unknown as { log: { error(m: string): void; warn(m: string): void } }).log = {
    error: (m: string) => logs.push({ level: "error", message: m }),
    warn: (m: string) => logs.push({ level: "warn", message: m }),
  };
  return { s, events, logs, inserts: stub.inserts };
}

const closingUnit: Row = {
  id: "u1",
  code: "WH-0001",
  orgId: "o1",
  domain: "globerent",
  status: "SOLD",
  salesStage: "DELIVERED",
  salesPrice: "100000000",
  lostReason: null,
};
const closedUnit: Row = { ...closingUnit, salesStage: "CLOSED" };

describe("UnitsService.setSalesStage — комиссия при закрытии", () => {
  it("провал начисления: сделка ЗАКРЫТА, в ленте unit.commission_failed, в логе error", async () => {
    const { s, events, logs } = commissionService({
      unit: closingUnit,
      updated: closedUnit,
      config: "boom",
    });
    const r = await s.setSalesStage("u1", "CLOSED");
    assert.equal(r.salesStage, "CLOSED"); // закрытие не уронено
    const failed = events.find((e) => e.type === "unit.commission_failed");
    assert.ok(failed, "провал комиссии обязан попасть в ленту событий");
    assert.equal(failed.source, "units");
    assert.equal(failed.payload?.unitId, "u1");
    assert.equal(failed.payload?.code, "WH-0001");
    assert.match(String(failed.payload?.error), /system_config/);
    assert.equal(failed.payload?.accruedFlowId, null); // до money_flow не дошло — можно заводить руками
    const err = logs.find((l) => l.level === "error");
    assert.ok(err, "провал комиссии обязан попасть в лог");
    assert.match(err.message, /u1/);
    assert.match(err.message, /system_config/);
  });

  it("успех: комиссия начислена (money_flow + событие sale_closed), провальных следов нет", async () => {
    const { s, events, logs, inserts } = commissionService({
      unit: closingUnit,
      updated: closedUnit,
      config: [
        { key: "GR_COMMISSION_METHOD", value: "margin_rate" },
        { key: "GR_COMMISSION_RATE_PCT", value: "10" },
      ],
      flows: [{ category: "supplier", currency: "UZS", amount: "80000000", amountUzs: null }],
    });
    const r = await s.setSalesStage("u1", "CLOSED");
    assert.equal(r.salesStage, "CLOSED");
    // margin_rate донора: Math.round((100М − 80М) × 10) / 100 = 2 000 000
    const flow = inserts.find((i) => i.table === moneyFlow);
    assert.ok(flow, "комиссия обязана лечь в money_flow");
    assert.equal(flow.values.amount, "2000000");
    assert.equal(flow.values.category, "commission");
    assert.ok(events.some((e) => e.type === "unit.sale_closed"));
    assert.ok(!events.some((e) => e.type === "unit.commission_failed"));
    assert.equal(logs.length, 0);
  });

  it("двойной провал: комиссия упала И событие не записалось — сделка ЗАКРЫТА, в логе два error", async () => {
    const { s, events, logs } = commissionService({
      unit: closingUnit,
      updated: closedUnit,
      config: "boom",
      failEventTypes: ["unit.commission_failed"],
    });
    const r = await s.setSalesStage("u1", "CLOSED");
    assert.equal(r.salesStage, "CLOSED"); // даже двойной провал не роняет сделку
    assert.ok(!events.some((e) => e.type === "unit.commission_failed")); // событие реально не записалось
    const errors = logs.filter((l) => l.level === "error");
    const [commissionErr, eventErr] = errors;
    assert.ok(
      commissionErr && eventErr && errors.length === 2,
      "след обязан остаться хотя бы в логе: провал комиссии + провал записи события",
    );
    assert.match(commissionErr.message, /не начислена/);
    assert.match(commissionErr.message, /system_config/);
    assert.match(eventErr.message, /unit\.commission_failed/);
    assert.match(eventErr.message, /не записалось/);
  });

  it("провал ПОСЛЕ начисления: лог не врёт «не начислена», в payload — accruedFlowId", async () => {
    const { s, events, logs, inserts } = commissionService({
      unit: closingUnit,
      updated: closedUnit,
      config: [
        { key: "GR_COMMISSION_METHOD", value: "margin_rate" },
        { key: "GR_COMMISSION_RATE_PCT", value: "10" },
      ],
      flows: [{ category: "supplier", currency: "UZS", amount: "80000000", amountUzs: null }],
      failEventTypes: ["unit.sale_closed"], // сбой шины УЖЕ ПОСЛЕ insert в money_flow
    });
    const r = await s.setSalesStage("u1", "CLOSED");
    assert.equal(r.salesStage, "CLOSED");
    const flow = inserts.find((i) => i.table === moneyFlow);
    assert.ok(flow, "строка комиссии легла в money_flow ДО провала события");
    const err = logs.find((l) => l.level === "error");
    assert.ok(err, "провал следа обязан быть виден в логе");
    // «не начислена» здесь — враньё: по нему оператор завёл бы комиссию второй раз
    assert.doesNotMatch(err.message, /не начислена/);
    assert.match(err.message, /НАЧИСЛЕНА/);
    assert.match(err.message, /повторно руками не заводить/);
    const failed = events.find((e) => e.type === "unit.commission_failed");
    assert.ok(failed, "провал следа виден в ленте");
    assert.ok(
      failed.payload?.accruedFlowId,
      "payload несёт id уже созданной строки — защита от ручного повторного начисления",
    );
  });

  it("кривой GR_COMMISSION_METHOD: фолбэк flat_bonus с warn, не бросает", async () => {
    const { s, events, logs } = commissionService({
      unit: closingUnit,
      updated: closedUnit,
      config: [{ key: "GR_COMMISSION_METHOD", value: "yolo" }],
    });
    const r = await s.setSalesStage("u1", "CLOSED");
    assert.equal(r.salesStage, "CLOSED");
    const warn = logs.find((l) => l.level === "warn");
    assert.ok(warn, "кривой тумблер обязан дать warn");
    assert.match(warn.message, /GR_COMMISSION_METHOD/);
    assert.match(warn.message, /yolo/);
    const closedEvent = events.find((e) => e.type === "unit.sale_closed");
    assert.ok(closedEvent, "закрытие прошло штатно");
    assert.equal(closedEvent.payload?.method, "flat_bonus"); // фолбэк, не «yolo»
    assert.ok(!events.some((e) => e.type === "unit.commission_failed"));
    assert.ok(!logs.some((l) => l.level === "error"));
  });
});
