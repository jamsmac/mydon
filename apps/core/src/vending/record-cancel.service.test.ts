import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  auditLog,
  event,
  person,
  systemConfig,
  vendingCashSession,
  vendingRefill,
  vendingStock,
  vendingStockCount,
} from "@mydon/db";
import { RecordCancelService, type CancelActor } from "./record-cancel.service";

const OWNER: CancelActor = {
  personId: "00000000-0000-4000-8000-000000000001",
  ref: "person:00000000-0000-4000-8000-000000000001",
};
const AUTHOR: CancelActor = {
  personId: "00000000-0000-4000-8000-000000000002",
  ref: "person:00000000-0000-4000-8000-000000000002",
};
const NOW = new Date("2026-08-26T10:00:00+05:00");

interface StubOptions {
  original?: Record<string, unknown>;
  groupRows?: Record<string, unknown>[];
  roles?: string[];
  conflictOnInsert?: boolean;
  windowHours?: number;
}

function stub(opts: StubOptions) {
  const inserted: { table: unknown; row: Record<string, unknown> }[] = [];
  let seq = 0;
  let lockCalls = 0;

  const end = (rows: Record<string, unknown>[]) => {
    const chain = {
      then: (resolve: (value: Record<string, unknown>[]) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
      limit: async (n: number) => rows.slice(0, n),
      orderBy: () => chain,
      for: async () => {
        lockCalls += 1;
        return rows;
      },
    };
    return chain;
  };
  const selected = (table: unknown) => {
    if (table === person) return { where: () => end([{ id: AUTHOR.personId, roles: opts.roles ?? [] }]) };
    if (table === systemConfig) {
      return Promise.resolve([{ key: "SNACK_CANCEL_WINDOW_HOURS", value: String(opts.windowHours ?? 24) }]);
    }
    if (table === vendingStockCount) {
      const rows = opts.groupRows ?? (opts.original ? [opts.original] : []);
      return { where: () => end(rows) };
    }
    const rows = opts.original ? [opts.original] : [];
    return { where: () => end(rows) };
  };
  const select = () => ({ from: (table: unknown) => selected(table) });

  const tx = {
    select,
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown> | Record<string, unknown>[]) => {
        const source = Array.isArray(values) ? values : [values];
        const rows = source.map((value) => ({ id: `storno-${++seq}`, ...value }));
        const remember = () => {
          for (const row of rows) inserted.push({ table, row });
          return rows;
        };
        return {
          onConflictDoNothing: () => ({
            returning: async () => (opts.conflictOnInsert ? [] : remember()),
          }),
          onConflictDoUpdate: () => ({
            returning: async () => remember(),
            then: (resolve: (value: unknown) => unknown) => Promise.resolve(remember()).then(resolve),
          }),
          returning: async () => remember(),
          then: (resolve: (value: unknown) => unknown) => Promise.resolve(remember()).then(resolve),
        };
      },
    }),
  };

  return {
    db: {
      select,
      transaction: async (cb: (value: typeof tx) => unknown) => cb(tx),
    } as never,
    rows: (table: unknown) => inserted.filter((item) => item.table === table).map((item) => item.row),
    lockCallCount: () => lockCalls,
  };
}

function refill(over: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000101",
    machineId: null,
    machineSerial: "2508160376",
    coilId: "1",
    productId: null,
    productName: "Snickers 50gr",
    qty: 6,
    personId: AUTHOR.personId,
    taskId: null,
    performedAt: NOW,
    clientKey: "refill-1",
    source: "bot",
    note: null,
    createdBy: AUTHOR.ref,
    reversesId: null,
    createdAt: NOW,
    ...over,
  };
}

describe("Сторно заправки — дельта (R-P6-10)", () => {
  it("пишет противознак и возвращает товар на склад", async () => {
    const s = stub({ original: refill() });
    const result = await new RecordCancelService(s.db).cancel("refill", String(refill().id), AUTHOR, NOW);
    assert.equal(result.ok, true);
    assert.ok(s.rows(vendingRefill).some((row) => row.qty === -6 && row.source === "storno"));
    assert.equal(s.rows(vendingStock).length, 1);
    assert.equal(s.rows(event).length, 1);
    assert.equal(s.rows(auditLog).length, 1);
  });

  it("повтор безвреден: склад и журнал второй раз не трогаются", async () => {
    const s = stub({ original: refill(), conflictOnInsert: true });
    const result = await new RecordCancelService(s.db).cancel("refill", String(refill().id), AUTHOR, NOW);
    assert.equal(result.ok && result.alreadyCancelled, true);
    assert.equal(s.rows(vendingStock).length, 0);
    assert.equal(s.rows(event).length, 0);
    assert.equal(s.rows(auditLog).length, 0);
  });
});

describe("Сторно пересчёта — метка на весь ввод (R-P6-11)", () => {
  it("копирует qty каждой позиции и не меняет текущий vending_stock", async () => {
    const base = {
      id: "00000000-0000-4000-8000-000000000201",
      dt: "2026-08-26",
      productName: "Coca-Cola",
      productId: null,
      qty: "19.00",
      source: "own",
      extId: null,
      countedAt: NOW,
      personId: AUTHOR.personId,
      note: AUTHOR.ref,
      reversesId: null,
      createdAt: NOW,
    };
    const group = [
      base,
      { ...base, id: "00000000-0000-4000-8000-000000000202", productName: "Sprite", qty: "5.00" },
    ];
    const s = stub({ original: base, groupRows: group });
    const result = await new RecordCancelService(s.db).cancel("stock_count", String(base.id), AUTHOR, NOW);
    assert.equal(result.ok, true);
    assert.deepEqual(s.rows(vendingStockCount).map((row) => row.qty), ["19.00", "5.00"]);
    assert.equal(s.rows(vendingStock).length, 0);
    assert.equal(s.lockCallCount(), 1, "весь ввод сериализуется одним стабильным замком группы");
  });
});

describe("Сторно кассы — противознак (R-P6-10)", () => {
  it("меняет знак итогов, подытога и строки", async () => {
    const original = {
      id: "00000000-0000-4000-8000-000000000301",
      receivedAmount: "2400000.00",
      categories: [{ name: "базар", subtotal: 376300, lines: [{ label: "снеки", amount: 376300 }] }],
      totalSpent: "376300.00",
      remainder: "2023700.00",
      source: "own",
      createdBy: OWNER.ref,
      reversesId: null,
      createdAt: NOW,
    };
    const s = stub({ original, roles: ["owner"] });
    const result = await new RecordCancelService(s.db).cancel("cash", String(original.id), OWNER, NOW);
    assert.equal(result.ok, true);
    const [row] = s.rows(vendingCashSession);
    assert.equal(row.receivedAmount, "-2400000.00");
    assert.equal((row.categories as { subtotal: number; lines: { amount: number }[] }[])[0]?.subtotal, -376300);
  });
});

describe("Права и окно отмены (R-P6-12)", () => {
  it("чужая запись запрещена", async () => {
    const s = stub({ original: refill({ createdBy: "person:00000000-0000-4000-8000-000000000099" }) });
    assert.deepEqual(
      await new RecordCancelService(s.db).cancel("refill", String(refill().id), AUTHOR, NOW),
      { ok: false, reason: "not_yours" },
    );
  });

  it("возраст считается по created_at, а performed_at не мешает", async () => {
    const fresh = stub({ original: refill({ performedAt: new Date("2020-01-01T00:00:00Z") }) });
    assert.equal((await new RecordCancelService(fresh.db).cancel("refill", String(refill().id), AUTHOR, NOW)).ok, true);

    const old = stub({ original: refill({ createdAt: new Date(NOW.getTime() - 25 * 3_600_000) }) });
    assert.deepEqual(
      await new RecordCancelService(old.db).cancel("refill", String(refill().id), AUTHOR, NOW),
      { ok: false, reason: "too_old", hours: 24 },
    );
  });

  it("администратор может отменить чужую старую запись", async () => {
    const oldForeign = stub({
      original: refill({
        createdBy: "person:00000000-0000-4000-8000-000000000099",
        createdAt: new Date(NOW.getTime() - 25 * 3_600_000),
      }),
      roles: ["owner"],
    });
    const result = await new RecordCancelService(oldForeign.db).cancel(
      "refill",
      String(refill().id),
      OWNER,
      NOW,
    );
    assert.equal(result.ok, true);
  });

  it("несуществующая запись возвращает not_found", async () => {
    const s = stub({});
    assert.deepEqual(
      await new RecordCancelService(s.db).cancel("refill", String(refill().id), AUTHOR, NOW),
      { ok: false, reason: "not_found" },
    );
  });
});
