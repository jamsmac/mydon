import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { org } from "@mydon/db";
import { MAX_FIND_LIMIT } from "@mydon/shared";
import { ContractsService } from "./contracts.service";

type Row = Record<string, unknown>;

/**
 * Статусная машина договора и guard'ы операций — фиксация тестом (§11 спеки).
 * У донора guard'ов не было вовсе (PATCH принимал cancelled → closed) —
 * матрица переходов здесь строже донора, и это отличие задокументировано.
 */

/** Заглушка Drizzle: транзакция с select().for("update") → existing, update → returning. */
function stubDb(opts: { existing?: Row; updated?: Row }) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => (opts.existing ? [opts.existing] : []),
    for: async () => (opts.existing ? [opts.existing] : []),
    orderBy: () => chain,
  };
  const tx = {
    select: () => chain,
    update: () => ({
      set: () => ({
        where: () => ({ returning: async () => [opts.updated ?? { ...opts.existing }] }),
      }),
    }),
    insert: () => ({ values: () => ({ returning: async () => [opts.updated ?? {}] }) }),
  };
  return {
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
    select: () => chain,
    update: tx.update,
    insert: tx.insert,
  } as never;
}

const noopEvents = { record: async () => undefined } as never;
const noopFinance = { createFlow: async () => ({ id: "f1" }) } as never;

function service(opts: { existing?: Row; updated?: Row }): ContractsService {
  return new ContractsService(stubDb(opts), noopEvents, noopFinance);
}

describe("ContractsService.setStatus — матрица переходов", () => {
  const cases: [string, string, boolean][] = [
    ["active", "closed", true],
    ["active", "cancelled", true],
    ["closed", "active", true],
    ["cancelled", "active", true],
    ["cancelled", "closed", false], // главный антибаг: у донора проходил
    ["closed", "cancelled", false],
  ];
  for (const [from, to, ok] of cases) {
    it(`${from} → ${to}: ${ok ? "разрешён" : "запрещён"}`, async () => {
      const s = service({
        existing: { id: "c1", status: from },
        updated: { id: "c1", status: to },
      });
      if (ok) {
        const r = await s.setStatus("c1", to);
        assert.equal(r.status, to);
      } else {
        await assert.rejects(() => s.setStatus("c1", to), /запрещён/);
      }
    });
  }

  it("no-op: тот же статус возвращается без изменения", async () => {
    const s = service({ existing: { id: "c1", status: "active" } });
    const r = await s.setStatus("c1", "active");
    assert.equal(r.status, "active");
  });

  it("кривой статус отбивается словами", async () => {
    const s = service({ existing: { id: "c1", status: "active" } });
    await assert.rejects(() => s.setStatus("c1", "paid"), /active \| closed \| cancelled/);
  });
});

describe("ContractsService.addPayment — guard'ы по статусу", () => {
  it("по отменённому договору платёж не принимается (409 донора)", async () => {
    const s = service({ existing: { id: "c1", status: "cancelled" } });
    await assert.rejects(() => s.addPayment("c1", { amount: 100 }), /отменён/);
  });

  it("сбой записи денег откатывает операцию целиком", async () => {
    let committed = false;
    let selectCall = 0;
    const contractChain = {
      from: () => contractChain,
      where: () => contractChain,
      for: async () => [
        {
          id: "c1",
          status: "active",
          domain: "globerent",
          contractNo: "1",
          clientId: null,
          totalWithVat: "100",
        },
      ],
    };
    const paidChain = {
      from: () => paidChain,
      where: async () => [{ paid: "0" }],
    };
    const tx = {
      select: () => (++selectCall === 1 ? contractChain : paidChain),
    };
    const db = {
      transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => {
        const result = await cb(tx);
        committed = true;
        return result;
      },
    } as never;
    const finance = {
      createFlowInTransaction: async () => {
        throw new Error("finance down");
      },
    } as never;
    const s = new ContractsService(db, noopEvents, finance);

    await assert.rejects(() => s.addPayment("c1", { amount: 100 }), /finance down/);
    assert.equal(committed, false);
  });
});

describe("ContractsService.addAct — guard'ы", () => {
  it("акт по отменённому договору — отказ", async () => {
    const s = service({ existing: { id: "c1", status: "cancelled" } });
    await assert.rejects(() => s.addAct("c1", { actNo: "1", actDate: "2026-08-04" }), /отменён/);
  });
  it("акт без номера или с кривой датой — отказ до базы", async () => {
    const s = service({});
    await assert.rejects(() => s.addAct("c1", { actNo: "", actDate: "2026-08-04" }), /номер акта/);
    await assert.rejects(() => s.addAct("c1", { actNo: "1", actDate: "04.08.2026" }), /ГГГГ-ММ-ДД/);
  });
});

describe("ContractsService.create — валидация до базы", () => {
  const base = {
    domain: "globerent" as const,
    contractDate: "2026-08-04",
    items: [{ name: "HELI CPCD30", qty: 1, price: 100 }],
  };
  it("кривая дата — отказ", async () => {
    const s = service({});
    await assert.rejects(() => s.create({ ...base, contractDate: "04.08.2026" }), /ГГГГ-ММ-ДД/);
  });
  it("без позиций — отказ", async () => {
    const s = service({});
    await assert.rejects(() => s.create({ ...base, items: [] }), /хотя бы одну позицию/);
  });
  it("нулевая цена или количество позиции — отказ", async () => {
    const s = service({});
    await assert.rejects(
      () => s.create({ ...base, items: [{ name: "X", qty: 0, price: 100 }] }),
      /количество/,
    );
    await assert.rejects(
      () => s.create({ ...base, items: [{ name: "X", qty: 1, price: 0 }] }),
      /цена/,
    );
  });
  it("кривой тип оплаты — отказ", async () => {
    const s = service({});
    await assert.rejects(
      () => s.create({ ...base, payType: "credit" as never }),
      /100 \| partial \| install \| post/,
    );
  });

  it("сбой графика откатывает создание договора, а не возвращает ложный успех", async () => {
    let committed = false;
    const outerChain = {
      from: () => outerChain,
      where: async () => [{ id: "org1" }],
    };
    const duplicateChain = {
      from: () => duplicateChain,
      where: () => duplicateChain,
      limit: async () => [],
    };
    const contract = {
      id: "c1",
      orgId: "org1",
      domain: "globerent",
      contractNo: "77",
      contractDate: "2026-08-04",
      totalWithVat: "112",
      payType: "100",
      docParams: {},
      clientId: null,
      agentId: null,
      agentCommissionAmount: null,
      agentCommissionCurrency: null,
    };
    const tx = {
      select: () => duplicateChain,
      insert: () => ({ values: () => ({ returning: async () => [contract] }) }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    };
    const db = {
      select: () => outerChain,
      transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => {
        const result = await cb(tx);
        committed = true;
        return result;
      },
    } as never;
    const finance = {
      createFlowInTransaction: async () => {
        throw new Error("finance down");
      },
    } as never;
    const s = new ContractsService(db, noopEvents, finance);

    await assert.rejects(
      () => s.create({ ...base, contractNo: "77", payType: "100" }),
      /finance down/,
    );
    assert.equal(committed, false);
  });
});

/**
 * Стаб под `list`: сначала запрос организации (from(org)), затем выборка
 * договоров с цепочкой leftJoin → where → groupBy → orderBy → limit.
 * Переданный предел перехватывается — ровно он и есть предмет теста:
 * на этом списке плитка «Действующие договоры» считает active/closed/total.
 */
function listDb(opts: { onLimit?: (n: number) => void }) {
  const chain = {
    leftJoin: () => chain,
    where: () => chain,
    groupBy: () => chain,
    orderBy: () => chain,
    limit: async (n: number) => {
      opts.onLimit?.(n);
      return [];
    },
  };
  return {
    select: () => ({
      from: (t: unknown) => {
        if (t === org) return { where: async () => [{ id: "11111111-1111-4111-8111-111111111111" }] };
        return chain;
      },
    }),
  } as never;
}

describe("Договоры: список не режется молча", () => {
  it("предел выборки — общий потолок MAX_FIND_LIMIT, а не зашитые 500", async () => {
    let передан = 0;
    const db = listDb({ onLimit: (n) => { передан = n; } });
    await new ContractsService(db, noopEvents, noopFinance).list("globerent");
    assert.equal(передан, MAX_FIND_LIMIT);
    // Тот же класс дефекта, что резал реестр (аудит 31.08, п. 6): на пределе
    // в 500 счётчики «закрыто N · всего M» молча застыли бы при росте таблицы —
    // сегодня договоров 265, запас на умолчании был меньше двух крат.
    assert.ok(передан >= 500 * 2, "потолок обязан держать кратный запас против 500");
  });
});
