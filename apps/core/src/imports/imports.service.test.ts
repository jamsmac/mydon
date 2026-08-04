import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ImportsService } from "./imports.service";

type Row = Record<string, unknown>;

/** Guard'ы импортного контракта: валидация и статусные отказы до записи. */
function stubDb(opts: { existing?: Row }) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => (opts.existing ? [opts.existing] : []),
    for: async () => (opts.existing ? [opts.existing] : []),
    orderBy: () => chain,
    groupBy: () => chain,
    leftJoin: () => chain,
  };
  const tx = {
    select: () => chain,
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ ...opts.existing }] }) }) }),
    insert: () => ({ values: () => ({ returning: async () => [{}] }) }),
  };
  return {
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
    select: () => chain,
    update: tx.update,
    insert: tx.insert,
  } as never;
}

const noopEvents = { record: async () => undefined } as never;
const noopFinance = { createFlow: async () => ({ id: "f1" }), markPaid: async () => ({}) } as never;

function service(opts: { existing?: Row }): ImportsService {
  return new ImportsService(stubDb(opts), noopEvents, noopFinance);
}

describe("ImportsService.create — валидация до базы", () => {
  const base = {
    domain: "globerent" as const,
    contractNo: "HL-2026-01",
    contractDate: "2026-08-04",
    items: [{ name: "HELI CPCD30", qty: 2, price: 15000 }],
  };
  it("дробное или нулевое количество — отказ", async () => {
    const s = service({});
    await assert.rejects(
      () => s.create({ ...base, items: [{ name: "X", qty: 1.5, price: 10 }] }),
      /целое больше нуля/,
    );
  });
  it("CHECK донора: предоплата + баланс больше суммы контракта — отказ", async () => {
    const s = service({});
    await assert.rejects(
      () => s.create({ ...base, prepaymentAmount: 20000, balanceAmount: 15000 }),
      /больше суммы контракта/,
    );
  });
  it("допуск округления 0.01 работает: ровно сумма проходит валидацию сумм", async () => {
    // 2 × 15000 = 30000; график 30000.005 — в допуске, отказ придёт не от сумм.
    const s = service({});
    await assert.rejects(
      () => s.create({ ...base, prepaymentAmount: 15000.005, balanceAmount: 15000, prepaymentDueDate: "кривая" }),
      /ГГГГ-ММ-ДД/,
    );
  });
  it("контракт под договор продажи без ссылки на договор — отказ (CHECK донора)", async () => {
    const s = service({});
    await assert.rejects(() => s.create({ ...base, purpose: "for_sum_contract" }), /укажи сам договор/);
  });
});

describe("ImportsService.sign — статусный guard", () => {
  it("повторное подписание — отказ", async () => {
    const s = service({ existing: { id: "i1", status: "in_progress" } });
    await assert.rejects(() => s.sign("i1"), /уже подписан/);
  });
});

describe("ImportsService.markPaid — идемпотентность оплат графика", () => {
  it("повторная отметка предоплаты — отказ", async () => {
    const s = service({
      existing: { id: "i1", status: "in_progress", prepaymentPaidAt: new Date(), balancePaidAt: null },
    });
    await assert.rejects(() => s.markPaid("i1", "prepayment"), /уже отмечена/);
  });
});

describe("ImportsService.bulkUnitAction — валидация массовых действий", () => {
  it("неизвестное массовое действие — отказ со списком допустимых", async () => {
    const s = service({});
    await assert.rejects(() => s.bulkUnitAction("i1", "mark-sold"), /Массовые действия/);
  });
  it("ГТД без номера — отказ; «в пути» без перевозчика — отказ", async () => {
    const s = service({});
    await assert.rejects(() => s.bulkUnitAction("i1", "mark-customs-im40", {}), /номер ГТД/);
    await assert.rejects(() => s.bulkUnitAction("i1", "mark-in-transit", {}), /перевозчика/);
  });
});
