import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CollectionsService } from "./collections.service";

type Row = Record<string, unknown>;

/**
 * Заглушка транзакции. Хитрость: create() сначала ищет автомат (entity),
 * receive/cancel ищут саму инкассацию — здесь это разводится флагом.
 */
function stub(opts: { machine?: Row | null; existing?: Row | null }) {
  const audit: Row[] = [];
  const rows = () => (opts.machine !== undefined ? (opts.machine ? [opts.machine] : []) : opts.existing ? [opts.existing] : []);
  const withFor = () =>
    Object.assign(Promise.resolve(rows()), {
      limit: async () => rows(),
      for: async () => rows(),
    });
  const tx = {
    select: () => ({ from: () => ({ where: () => withFor() }) }),
    insert: (t: unknown) => ({
      values: (v: Row) => {
        if ((t as { _?: { name?: string } })?._?.name === "audit_log" || audit.length >= 0) {
          // считаем записи журнала по признаку поля action
          if (typeof v.action === "string") audit.push(v);
        }
        return Object.assign(Promise.resolve(undefined), {
          returning: async () => [{ id: "c1", ...v }],
        });
      },
    }),
    update: () => ({
      set: (v: Row) => ({
        where: () => ({ returning: async () => [{ ...(opts.existing ?? {}), ...v }] }),
      }),
    }),
  };
  const db = { transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx) } as never;
  return { db, audit };
}

describe("Инкассация", () => {
  it("сбор фиксируется временем «сейчас» и следом в журнале", async () => {
    const { db, audit } = stub({ machine: { id: "m1", type: "machine" } });
    const s = new CollectionsService(db);
    const before = Date.now();
    const c = await s.create({ machineId: "m1", operatorId: "p1" });
    const at = new Date(c.collectedAt as unknown as string | Date).getTime();
    assert.ok(at >= before - 1000 && at <= Date.now() + 1000, "время сбора — момент нажатия");
    assert.equal(audit.filter((a) => a.action === "collection.collected").length, 1);
  });

  it("инкассация не по автомату — понятная ошибка", async () => {
    const { db } = stub({ machine: { id: "e1", type: "product" } });
    const s = new CollectionsService(db);
    await assert.rejects(() => s.create({ machineId: "e1" }), /только по автомату/);
  });

  it("приём: сумма записана, статус received; повторный приём невозможен", async () => {
    const { db } = stub({ existing: { id: "c1", status: "collected" } });
    const s = new CollectionsService(db);
    const r = await s.receive("c1", 1250000, "owner");
    assert.equal(r.status, "received");
    assert.equal(r.amount, "1250000");

    const closed = stub({ existing: { id: "c1", status: "received" } });
    await assert.rejects(
      () => new CollectionsService(closed.db).receive("c1", 1, "owner"),
      /уже закрыта/,
    );
  });

  it("отрицательная сумма не принимается", async () => {
    const { db } = stub({ existing: { id: "c1", status: "collected" } });
    const s = new CollectionsService(db);
    await assert.rejects(() => s.receive("c1", -5, "owner"), /не меньше нуля/);
  });
});
