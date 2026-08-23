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
    update: () => ({
      set: () => ({ where: () => ({ returning: async () => [{ ...opts.existing }] }) }),
    }),
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
const noopFinance = {
  createFlow: async () => ({ id: "f1" }),
  createFlowInTransaction: async () => ({ id: "f1" }),
  markPaid: async () => ({}),
  markPaidInTransaction: async () => ({}),
} as never;

function service(opts: { existing?: Row }, finance = noopFinance): ImportsService {
  return new ImportsService(stubDb(opts), noopEvents, finance);
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
      () =>
        s.create({
          ...base,
          prepaymentAmount: 15000.005,
          balanceAmount: 15000,
          prepaymentDueDate: "кривая",
        }),
      /ГГГГ-ММ-ДД/,
    );
  });
  it("контракт под договор продажи без ссылки на договор — отказ (CHECK донора)", async () => {
    const s = service({});
    await assert.rejects(
      () => s.create({ ...base, purpose: "for_sum_contract" }),
      /укажи сам договор/,
    );
  });
});

describe("ImportsService.sign — статусный guard", () => {
  it("повторное подписание — отказ", async () => {
    const s = service({ existing: { id: "i1", status: "in_progress" } });
    await assert.rejects(() => s.sign("i1"), /уже подписан/);
  });

  it("сбой обязательства откатывает подписание вместо частичного успеха", async () => {
    const finance = {
      createFlowInTransaction: async () => {
        throw new Error("finance down");
      },
    } as never;
    const s = service(
      {
        existing: {
          id: "i1",
          status: "draft",
          lifecycleStatus: "signed",
          orgId: "org1",
          domain: "globerent",
          contractNo: "HL-1",
          currency: "USD",
          items: [],
          prepaymentAmount: "100",
          prepaymentDueDate: "2026-08-10",
          balanceAmount: null,
          balanceDueDate: null,
        },
      },
      finance,
    );
    await assert.rejects(() => s.sign("i1"), /finance down/);
  });
});

describe("ImportsService.markPaid — идемпотентность оплат графика", () => {
  it("повторная отметка предоплаты — отказ", async () => {
    const s = service({
      existing: {
        id: "i1",
        status: "in_progress",
        prepaymentPaidAt: new Date(),
        balancePaidAt: null,
      },
    });
    await assert.rejects(() => s.markPaid("i1", "prepayment"), /уже отмечена/);
  });

  it("сбой закрытия обязательства откатывает флаг оплаты контракта", async () => {
    let committed = false;
    let selectCall = 0;
    const contractChain = {
      from: () => contractChain,
      where: () => contractChain,
      for: async () => [
        {
          id: "i1",
          status: "in_progress",
          lifecycleStatus: "signed",
          prepaymentPaidAt: null,
          balancePaidAt: null,
        },
      ],
    };
    const plannedChain = {
      from: () => plannedChain,
      where: () => plannedChain,
      limit: async () => [{ id: "flow-1", status: "planned" }],
    };
    const tx = {
      select: () => (++selectCall === 1 ? contractChain : plannedChain),
      update: () => ({
        set: () => ({
          where: () => ({ returning: async () => [{ id: "i1", prepaymentPaidAt: new Date() }] }),
        }),
      }),
      insert: () => ({ values: async () => undefined }),
    };
    const db = {
      transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => {
        const result = await cb(tx);
        committed = true;
        return result;
      },
    } as never;
    const finance = {
      markPaidInTransaction: async () => {
        throw new Error("finance down");
      },
    } as never;
    const s = new ImportsService(db, noopEvents, finance);

    await assert.rejects(() => s.markPaid("i1", "prepayment"), /finance down/);
    assert.equal(committed, false);
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
