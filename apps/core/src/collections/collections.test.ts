import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collection as collectionTable, coffeeOrder as coffeeOrderTable, entity as entityTable, sale as saleTable } from "@mydon/db";
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

  it("приём без разбивки купюр проходит как раньше (386 исторических записей)", async () => {
    const { db } = stub({ existing: { id: "c1", status: "collected" } });
    const s = new CollectionsService(db);
    const r = await s.receive("c1", 560500, "owner");
    assert.equal(r.status, "received");
    assert.equal(r.denominations, null);
  });

  it("разбивка купюр: сумма сошлась — приём проходит, набор сохраняется", async () => {
    const { db } = stub({ existing: { id: "c1", status: "collected" } });
    const s = new CollectionsService(db);
    const r = await s.receive("c1", 560000, "owner", { "50000": 10, "10000": 6 });
    assert.equal(r.status, "received");
    assert.deepEqual(r.denominations, { "50000": 10, "10000": 6 });
  });

  it("разбивка купюр: сумма НЕ сошлась — отказ называет обе цифры", async () => {
    const { db } = stub({ existing: { id: "c1", status: "collected" } });
    const s = new CollectionsService(db);
    await assert.rejects(
      () => s.receive("c1", 560000, "owner", { "50000": 10, "10000": 5 }), // 550000 ≠ 560000
      (err: unknown) => {
        const msg = (err as Error).message;
        assert.match(msg, /550000/, "названа сумма по купюрам");
        assert.match(msg, /560000/, "названа заявленная сумма");
        return true;
      },
    );
  });

  it("разбивка купюр: незнакомый номинал отбивает приём понятной ошибкой", async () => {
    const { db } = stub({ existing: { id: "c1", status: "collected" } });
    const s = new CollectionsService(db);
    await assert.rejects(() => s.receive("c1", 2000, "owner", { "500": 4 }), /не в обороте/);
  });
});

/**
 * Заглушка для reconcile(): не транзакция, а select()+execute() напрямую.
 * `.from(table)` различает таблицы по ссылке — так же, как это делает
 * настоящий Drizzle-объект, только без похода в Postgres.
 */
function stubReconcile(opts: {
  collections?: Row[];
  coffeeOrders?: Row[];
  sales?: Row[];
  entities?: Row[];
  intervals?: Row[];
}) {
  const tables = new Map<unknown, Row[]>([
    [collectionTable, opts.collections ?? []],
    [coffeeOrderTable, opts.coffeeOrders ?? []],
    [saleTable, opts.sales ?? []],
    [entityTable, opts.entities ?? []],
  ]);
  const rowsFor = (table: unknown) => tables.get(table) ?? [];
  const db = {
    select: () => ({
      from: (table: unknown) =>
        Object.assign(Promise.resolve(rowsFor(table)), {
          where: async () => rowsFor(table),
        }),
    }),
    execute: async () => opts.intervals ?? [],
  } as never;
  return db;
}

describe("Сверка по автоматам (R-K11)", () => {
  it("даты обязательны и проверяются форматом", async () => {
    const s = new CollectionsService(stubReconcile({}));
    await assert.rejects(() => s.reconcile("", ""), /ГГГГ-ММ-ДД/);
    await assert.rejects(() => s.reconcile("2026-03-01", "01.03.2026"), /ГГГГ-ММ-ДД/);
  });

  it("начало периода позже конца — понятная ошибка", async () => {
    const s = new CollectionsService(stubReconcile({}));
    await assert.rejects(() => s.reconcile("2026-06-24", "2026-03-01"), /позже конца/);
  });

  it("пустой период отдаёт честный ноль, а не ошибку и не пустой объект", async () => {
    const s = new CollectionsService(stubReconcile({}));
    const r = await s.reconcile("2099-01-01", "2099-01-31");
    assert.ok(Object.keys(r).length > 0, "результат не пустой объект");
    assert.deepEqual(r.rows, []);
    assert.deepEqual(r.intervals, []);
    assert.equal(r.первыхИсключено, 0);
    assert.equal(r.from, "2099-01-01");
    assert.equal(r.to, "2099-01-31");
  });

  it("rows и intervals считаются по фактам, доля и медианы устойчивы к нулям", async () => {
    const day = 86_400_000;
    const base = new Date("2026-01-01T10:00:00+05:00").getTime();
    const at = (offsetDays: number) => new Date(base + offsetDays * day);

    // m1: 4 инкассации за всю историю → 3 периода (первая исключена).
    const m1c0 = { machineId: "m1", collectedAt: at(0), receivedAt: null, amount: null };
    const m1c1 = { machineId: "m1", collectedAt: at(7), receivedAt: at(7 + 2), amount: "50000" };
    const m1c2 = { machineId: "m1", collectedAt: at(7 + 83), receivedAt: at(7 + 83 + 2), amount: "90000" };
    const m1c3 = { machineId: "m1", collectedAt: at(7 + 83 + 365), receivedAt: at(7 + 83 + 365 + 1), amount: "10000" };
    // m2: одна инкассация за всю историю — интервалов нет вовсе.
    const m2c0 = { machineId: "m2", collectedAt: at(7 + 83), receivedAt: at(7 + 83 + 3), amount: "30000" };

    const db = stubReconcile({
      collections: [m1c0, m1c1, m1c2, m1c3, m2c0],
      coffeeOrders: [
        // период запроса — [7+83 дней ... 7+83+10 дней], в него попадает m1c2
        { machineId: "m1", ts: at(7 + 83 + 1), amount: "80000", res: "cash" },
        { machineId: "m1", ts: at(7 + 83 + 1), amount: "20000", res: "userDefined" }, // не наличные — не считается
        { machineId: "m3", ts: at(7 + 83 + 1), amount: "5000", res: "credit" }, // m3 не инкассировался ни разу
      ],
      sales: [{ machineId: "m1", dt: "2026-04-04", amount: "20000" }],
      entities: [{ id: "m1", name: "Автомат 1" }],
      intervals: [
        { id: "iv1", machineId: "m1", prev: at(0), collectedAt: at(7), amount: "50000", expected: "40000" },
        { id: "iv2", machineId: "m1", prev: at(7), collectedAt: at(7 + 83), amount: "90000", expected: "90000" },
        { id: "iv3", machineId: "m1", prev: at(7 + 83), collectedAt: at(7 + 83 + 365), amount: "10000", expected: "200000" },
      ],
    });

    const s = new CollectionsService(db);
    const from = "2026-04-01"; // ровно at(7+83) — период вокруг m1c2
    const to = "2026-04-15";
    const r = await s.reconcile(from, to);

    // intervals: три периода, медиана длительностей [7, 83, 365] = 83;
    // порог «пробел» — 166 дней; флаг только у последнего периода.
    assert.equal(r.intervals.length, 3);
    const iv1 = r.intervals.find((i) => i.id === "iv1")!;
    const iv2 = r.intervals.find((i) => i.id === "iv2")!;
    const iv3 = r.intervals.find((i) => i.id === "iv3")!;
    assert.equal(iv1.дней, 7);
    assert.equal(iv1.разница, 10000); // 50000 - 40000
    assert.equal(iv1.статус, "обычный");
    assert.equal(iv2.дней, 83);
    assert.equal(iv2.статус, "обычный");
    assert.equal(iv3.дней, 365);
    assert.equal(iv3.разница, -190000); // 10000 - 200000
    assert.equal(iv3.статус, "пробел в журнале", "365 дней > 2×медианы(83) — дисциплина ввода, не недостача");

    // первая инкассация на автомате исключена у обоих (m1 и m2), молча не теряется.
    assert.equal(r.первыхИсключено, 2);

    // rows: m1 — выручка = 80000 (cash) + 20000 (снек) = 100000; изъято — только m1c2 (90000) внутри периода.
    const m1 = r.rows.find((x) => x.machineId === "m1")!;
    assert.equal(m1.имя, "Автомат 1");
    assert.equal(m1.выручка, 100000);
    assert.equal(m1.изъято, 90000);
    assert.equal(m1.разница, -10000);
    assert.equal(m1.доля, -10);
    assert.equal(m1.инкассаций, 1);
    assert.equal(m1.медианныйИнтервалДней, 83, "медиана берётся по ВСЕЙ истории автомата, не по окну запроса");
    assert.ok(m1.медианныйЛагДней !== null && m1.медианныйЛагДней > 0);

    // m2: изъято есть (30000), выручки в периоде нет вовсе — доля не делится на ноль.
    const m2 = r.rows.find((x) => x.machineId === "m2")!;
    assert.equal(m2.выручка, 0);
    assert.equal(m2.изъято, 30000);
    assert.equal(m2.доля, null, "выручка ноль — доля не считается делением на ноль");
    assert.equal(m2.медианныйИнтервалДней, null, "у m2 нет ни одного периода — интервалов не было");
    assert.equal(m2.медианныйЛагДней, 3);

    // m3: выручка есть, инкассаций в периоде не было ни разу — видно как честный провал, не тихая пропажа.
    const m3 = r.rows.find((x) => x.machineId === "m3")!;
    assert.equal(m3.выручка, 5000);
    assert.equal(m3.изъято, 0);
    assert.equal(m3.доля, -100);
    assert.equal(m3.инкассаций, 0);
  });
});
