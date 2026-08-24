import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AccountingSaleRow, RawLotRow } from "@mydon/connectors";
import {
  addDays,
  runOurvendAccounting,
  salesWindow,
  windowDays,
  type AccountingConnector,
  type AccountingCoreClient,
} from "./ourvend-accounting";

// 10:00 по Ташкенту 24.08 → сегодня 2026-08-24, «вчера» 2026-08-23.
const NOW = () => new Date("2026-08-24T05:00:00Z");

function stubCore(status: {
  lastSaleDt: string | null;
  lastStockDt: string | null;
  perMachineSale?: { machineSerial: string; last: string }[];
}) {
  const pushes: { sales?: unknown[]; stock?: unknown[] }[] = [];
  const core: AccountingCoreClient = {
    ourvendSnapshotStatus: async () => ({ perMachineSale: [], ...status }),
    pushOurvendSnapshot: async (payload) => {
      pushes.push(payload as { sales?: unknown[]; stock?: unknown[] });
      const sales = (payload.sales ?? []) as { rows: unknown[] }[];
      const stock = (payload.stock ?? []) as { rows: unknown[] }[];
      return {
        saleDays: sales.length,
        saleRows: sales.reduce((a, d) => a + d.rows.length, 0),
        stockDays: stock.length,
        stockRows: stock.reduce((a, d) => a + d.rows.length, 0),
        quarantined: 0,
      };
    },
  };
  return { core, pushes };
}

function stubConnector(over: Partial<AccountingConnector> = {}): AccountingConnector {
  return {
    login: async () => undefined,
    listMachines: async () => [
      { serial: "2508160376", alias: "Olma" },
      { serial: "2508160359", alias: "School" },
    ],
    getAccountingSales: async (): Promise<AccountingSaleRow[]> => [
      { product: "Fanta", qty: 2, amount: 24000 },
    ],
    openStockSession: async () => undefined,
    getLotRows: async (): Promise<RawLotRow[]> => [{ product: "Fanta", quantity: 6 }],
    ...over,
  };
}

describe("Окно съёма продаж", () => {
  it("пустая история → 14 дней, заканчивая вчера", () => {
    const w = salesWindow(null, "2026-08-23");
    assert.equal(w.from, "2026-08-10");
    assert.equal(w.to, "2026-08-23");
    assert.equal(windowDays(w.from, w.to).length, 14);
  });

  it("снапшот дотянулся до вчера → пересъём одного вчера", () => {
    const w = salesWindow("2026-08-23", "2026-08-23");
    assert.deepEqual(w, { from: "2026-08-23", to: "2026-08-23" });
  });

  it("дыра больше 14 дней зажимается порогом", () => {
    const w = salesWindow("2026-06-01", "2026-08-23");
    assert.equal(w.from, "2026-08-10", "глубже 14 дней за один прогон не ходим");
  });

  it("обычный догон: со следующего после снятого дня", () => {
    const w = salesWindow("2026-08-20", "2026-08-23");
    assert.deepEqual(windowDays(w.from, w.to), ["2026-08-21", "2026-08-22", "2026-08-23"]);
  });

  it("addDays переживает границы месяца", () => {
    assert.equal(addDays("2026-08-01", -1), "2026-07-31");
  });
});

describe("runOurvendAccounting", () => {
  it("успех: помашинные окна, пустая проба не даёт дней", async () => {
    const { core, pushes } = stubCore({
      lastSaleDt: "2026-08-21",
      lastStockDt: null,
      // Вотермарка есть только у первого автомата; второй пойдёт полным окном.
      perMachineSale: [{ machineSerial: "2508160376", last: "2026-08-21" }],
    });
    const calls: string[] = [];
    const connector = stubConnector({
      getAccountingSales: async (serial, from, to) => {
        calls.push(`${serial}:${from.toISOString().slice(0, 10)}..${to.toISOString().slice(0, 10)}`);
        if (serial === "2508160359") return []; // у второго автомата продаж нет
        return [{ product: "Fanta", qty: 2, amount: 24000 }];
      },
    });
    const r = await runOurvendAccounting(core, { account: "a", password: "p", groupId: "g" }, { connector, now: NOW });

    assert.equal(r.status, "success");
    assert.equal(r.machinesTotal, 2);
    assert.equal(r.machinesOk, 2);
    assert.equal(r.saleDays, 2, "окно 22–23.08: два дня первого автомата");
    assert.equal(r.stockRows, 2, "по строке остатков на каждый автомат");
    // Второй автомат (без вотермарки) пробуется ПОЛНЫМ 14-дневным окном.
    assert.ok(calls.includes("2508160359:2026-08-10..2026-08-23"));
    const saleDts = pushes
      .flatMap((p) => (p.sales ?? []) as { dt: string; machineSerial: string }[])
      .map((d) => `${d.machineSerial}@${d.dt}`)
      .sort();
    assert.deepEqual(saleDts, ["2508160376@2026-08-22", "2508160376@2026-08-23"]);
    const stockDts = pushes.flatMap((p) => (p.stock ?? []) as { dt: string }[]).map((d) => d.dt);
    assert.deepEqual([...new Set(stockDts)], ["2026-08-24"], "остатки — сегодняшним днём");
  });

  it("вотермарка сбойной машины не уезжает за здоровыми: её окно остаётся своим", async () => {
    const { core } = stubCore({
      lastSaleDt: "2026-08-23",
      lastStockDt: null,
      perMachineSale: [
        { machineSerial: "2508160376", last: "2026-08-23" }, // здоровая, догнана
        { machineSerial: "2508160359", last: "2026-08-20" }, // отстала на 3 дня
      ],
    });
    const spans: string[] = [];
    const connector = stubConnector({
      getAccountingSales: async (serial, from, to) => {
        spans.push(`${serial}:${from.toISOString().slice(0, 10)}..${to.toISOString().slice(0, 10)}`);
        return [];
      },
    });
    await runOurvendAccounting(core, { account: "a", password: "p", groupId: "g" }, { connector, now: NOW });
    assert.ok(spans.includes("2508160376:2026-08-23..2026-08-23"), "догнанная — пересъём вчера");
    assert.ok(spans.includes("2508160359:2026-08-21..2026-08-23"), "отставшая — догоняет свои дни");
  });

  it("сбой одной машины не роняет съём: partial, остальное доставлено", async () => {
    const { core, pushes } = stubCore({ lastSaleDt: "2026-08-22", lastStockDt: null });
    const connector = stubConnector({
      getAccountingSales: async (serial) => {
        if (serial === "2508160376") throw new Error("timeout");
        return [{ product: "Вода", qty: 1, amount: 5000 }];
      },
    });
    const r = await runOurvendAccounting(core, { account: "a", password: "p", groupId: "g" }, { connector, now: NOW });
    assert.equal(r.status, "partial");
    assert.equal(r.machinesOk, 1);
    assert.match(r.error ?? "", /продажи 2508160376/);
    assert.ok(pushes.length > 0, "данные здоровой машины дошли до Core");
  });

  it("отказ приёма в Core — честный failed", async () => {
    const { core } = stubCore({ lastSaleDt: "2026-08-22", lastStockDt: null });
    core.pushOurvendSnapshot = async () => {
      throw new Error("503");
    };
    const r = await runOurvendAccounting(core, { account: "a", password: "p", groupId: "g" }, { connector: stubConnector(), now: NOW });
    assert.equal(r.status, "failed");
    assert.match(r.error ?? "", /приём снапшота/);
  });

  it("провал логина — failed без похода по машинам", async () => {
    const { core, pushes } = stubCore({ lastSaleDt: null, lastStockDt: null });
    const connector = stubConnector({
      login: async () => {
        throw new Error("Вход в Ourvend не удался");
      },
    });
    const r = await runOurvendAccounting(core, { account: "a", password: "p", groupId: "g" }, { connector, now: NOW });
    assert.equal(r.status, "failed");
    assert.equal(pushes.length, 0);
  });

  it("сбой Lot-сессии не трогает продажи: partial с пометкой", async () => {
    const { core, pushes } = stubCore({ lastSaleDt: "2026-08-22", lastStockDt: null });
    const connector = stubConnector({
      openStockSession: async () => {
        throw new Error("нет сессии");
      },
    });
    const r = await runOurvendAccounting(core, { account: "a", password: "p", groupId: "g" }, { connector, now: NOW });
    assert.equal(r.status, "partial");
    assert.match(r.error ?? "", /Lot-сессия/);
    assert.ok(pushes.some((p) => (p.sales ?? []).length > 0), "продажи всё равно отправлены");
    assert.ok(!pushes.some((p) => (p.stock ?? []).length > 0), "остатков нет — сессия не открылась");
  });
});
