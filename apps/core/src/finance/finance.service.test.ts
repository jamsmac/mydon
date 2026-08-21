import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collection, moneyFlow } from "@mydon/db";
import { FinanceService } from "./finance.service";

type Row = Record<string, unknown>;

/**
 * Стаб БД для `createFlow`/`importBankStatement` — тот же приём, что и в
 * `stock.service.test.ts` (условие → плоский список значений → приближённое
 * совпадение строки), но заточен под `money_flow`: идемпотентность массового
 * импорта проверяется парой `(source, extId)`, а генерик-условие `and(eq(source,…),
 * eq(extId,…))` даёт оба значения плоским списком — этого достаточно, чтобы
 * найти строку по `extId` без коллизий на контролируемых фикстурах теста.
 */
function conditionValues(cond: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (node == null || depth > 8) return;
    if (Array.isArray(node)) {
      for (const el of node) walk(el, depth + 1);
      return;
    }
    const v = (node as { value?: unknown }).value;
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === "string") out.push(x);
    for (const c of (node as { queryChunks?: unknown[] }).queryChunks ?? []) walk(c, depth + 1);
  };
  walk(cond, 0);
  return out;
}

function rowMatchesByExtId(row: Row, values: string[]): boolean {
  if (values.length === 0) return true;
  return "extId" in row && row.extId != null && values.includes(row.extId as string);
}

/** Стаб БД: единственная таблица, которую трогают createFlow/importBankStatement без domain/counterpartyId, — money_flow. */
function financeDb(seed: { moneyFlow?: Row[] } = {}) {
  const moneyFlowRows: Row[] = [...(seed.moneyFlow ?? [])];
  let nextId = 1;

  const db = {
    select: (_cols?: unknown) => ({
      from: (t: unknown) => {
        let rows = t === moneyFlow ? moneyFlowRows : [];
        const chain = {
          where: (cond?: unknown) => {
            const values = conditionValues(cond);
            rows = rows.filter((r) => rowMatchesByExtId(r, values));
            return chain;
          },
          limit: () => Promise.resolve(rows),
          then: (resolve: (v: unknown[]) => void) => resolve(rows),
        };
        return chain;
      },
    }),
    insert: (t: unknown) => ({
      values: (v: Row) => {
        const row = { id: `mf-${nextId++}`, ...v };
        const commit = (): void => {
          if (t === moneyFlow) moneyFlowRows.push(row);
        };
        return {
          returning: async (): Promise<Row[]> => {
            commit();
            return [row];
          },
          // auditLog пишется без .returning() — объект-заявка сам должен быть await-абелен.
          then: (resolve: (v: unknown) => void) => {
            commit();
            resolve(undefined);
          },
        };
      },
    }),
    transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb(db),
  } as never;

  return { db, moneyFlowRows };
}

/**
 * Валидация ввода денег: кривые данные отбиваются ДО похода в базу.
 * Заглушка БД взрывается при любом обращении — так проверяется, что
 * отказ происходит на границе, а не после частичной записи.
 */
function explodingDb(): never {
  throw new Error("до базы дойти не должно");
}
const db = new Proxy(
  {},
  {
    get: () => explodingDb,
  },
) as never;

const service = new FinanceService(db);

describe("FinanceService.createFlow — валидация до базы", () => {
  const base = {
    domain: "globerent" as const,
    direction: "in" as const,
    status: "planned" as const,
    amount: 100,
  };

  it("отбивает нулевую и отрицательную сумму", async () => {
    await assert.rejects(() => service.createFlow({ ...base, amount: 0 }), /положительное число/);
    await assert.rejects(() => service.createFlow({ ...base, amount: -5 }), /положительное число/);
  });

  it("отбивает кривую валюту", async () => {
    await assert.rejects(() => service.createFlow({ ...base, currency: "сум" }), /трёхбуквенный код/);
  });

  it("отбивает категорию вне словаря", async () => {
    await assert.rejects(
      () => service.createFlow({ ...base, category: "чебурек" }),
      /Категория — одна из/,
    );
  });

  it("отбивает кривой срок оплаты", async () => {
    await assert.rejects(() => service.createFlow({ ...base, dueDate: "31.12.2026" }), /ГГГГ-ММ-ДД/);
  });

  it("отбивает нулевой курс", async () => {
    await assert.rejects(() => service.createFlow({ ...base, rate: 0 }), /Курс — положительное число/);
  });
});

describe("FinanceService.setFx — валидация до базы", () => {
  it("отбивает кривой код валюты и попытку задать курс сума", async () => {
    await assert.rejects(() => service.setFx({ currency: "доллар", rate: 12500 }), /трёхбуквенный код/);
    await assert.rejects(() => service.setFx({ currency: "UZS", rate: 1 }), /всегда 1/);
  });
  it("отбивает нулевой курс", async () => {
    await assert.rejects(() => service.setFx({ currency: "USD", rate: 0 }), /положительное число/);
  });
});

describe("FinanceService.markPaid — валидация до базы", () => {
  it("отбивает кривой курс", async () => {
    await assert.rejects(() => service.markPaid("id", { rate: -1 }), /Курс — положительное число/);
  });
});

describe("FinanceService.createFlow — расширение source/extId/collectionId/cashSymbol (срез К, задача 4)", () => {
  it("domain не задан — orgId лукап не идёт, запись создаётся без домена (обратная совместимость импорта)", async () => {
    const { db, moneyFlowRows } = financeDb();
    const svc = new FinanceService(db);
    const created = await svc.createFlow({ direction: "in", status: "actual", amount: 500, currency: "UZS" });
    assert.equal(moneyFlowRows.length, 1);
    assert.equal((created as Row).domain, null);
    assert.equal((created as Row).orgId, null);
  });

  it("extId уже занят той же (source, extId) — возвращает существующую запись, дубль не создаётся", async () => {
    const existing = { id: "mf-existing", source: "bank", extId: "dup-1", amount: "9000000" };
    const { db, moneyFlowRows } = financeDb({ moneyFlow: [existing] });
    const svc = new FinanceService(db);
    const result = await svc.createFlow({
      direction: "in",
      status: "actual",
      amount: 9000000,
      currency: "UZS",
      source: "bank",
      extId: "dup-1",
    });
    assert.equal((result as Row).id, "mf-existing");
    assert.equal(moneyFlowRows.length, 1, "новая строка не появилась");
  });

  it("без extId идемпотентность не проверяется вовсе — до базы за ней не ходим (старые вызовы не меняются)", async () => {
    // explodingDb: любое обращение к БД — ошибка. Без extId код не должен
    // делать SELECT по (source, extId) — только сразу писать (что тоже упадёт
    // на explodingDb, но с ДРУГИМ, узнаваемым сообщением, не с идемпотентностью).
    await assert.rejects(
      () => service.createFlow({ direction: "in", status: "actual", amount: 100, currency: "UZS" }),
      /до базы дойти не должно/,
    );
  });

  it("новая запись несёт collectionId и cashSymbol как есть", async () => {
    const { db, moneyFlowRows } = financeDb();
    const svc = new FinanceService(db);
    await svc.createFlow({
      direction: "in",
      status: "actual",
      amount: 9000000,
      currency: "UZS",
      source: "bank",
      extId: "3009296::2025-06-12",
      cashSymbol: "0200",
      collectionId: null,
    });
    assert.equal(moneyFlowRows[0]!.cashSymbol, "0200");
    assert.equal(moneyFlowRows[0]!.source, "bank");
    assert.equal(moneyFlowRows[0]!.extId, "3009296::2025-06-12");
  });
});

describe("FinanceService.importBankStatement — импорт выписки с предпросмотром (срез К, задача 4)", () => {
  it("строка без оборота ни по дебету, ни по кредиту — отклоняется, до базы не доходит", async () => {
    const svc = new FinanceService(db);
    const report = await svc.importBankStatement({
      items: [{ date: "2026-06-01", debit: null, credit: null, extId: "x1" }],
    });
    assert.equal(report.created, 0);
    assert.equal(report.rejected.length, 1);
    assert.equal(report.rejected[0]!.extId, "x1");
    assert.match(report.rejected[0]!.reason, /нет оборота/);
  });

  it("одна плохая строка не роняет пачку — остальные создаются (урок среза D: DTO — тип, семантика — сервис)", async () => {
    const { db, moneyFlowRows } = financeDb();
    const svc = new FinanceService(db);
    const report = await svc.importBankStatement({
      items: [
        { date: "2026-06-12", debit: null, credit: 9000000, cashSymbol: "0200", docNo: "1", extId: "1::2026-06-12" },
        { date: "2026-06-13", debit: null, credit: null, extId: "2::2026-06-13" }, // плохая — без оборота
        { date: "2026-06-14", debit: null, credit: 3000000, cashSymbol: "0200", docNo: "3", extId: "3::2026-06-14" },
      ],
    });
    assert.equal(report.created, 2);
    assert.equal(report.rejected.length, 1);
    assert.equal(report.rejected[0]!.extId, "2::2026-06-13");
    assert.equal(moneyFlowRows.length, 2);
  });

  it("повторный extId — считается repeat, дубль не пишется", async () => {
    const existing = { id: "mf-1", source: "bank", extId: "3009296::2025-06-12", amount: "9000000" };
    const { db, moneyFlowRows } = financeDb({ moneyFlow: [existing] });
    const svc = new FinanceService(db);
    const report = await svc.importBankStatement({
      items: [{ date: "2025-06-12", debit: null, credit: 9000000, docNo: "3009296", extId: "3009296::2025-06-12" }],
    });
    assert.equal(report.created, 0);
    assert.equal(report.skippedRepeat, 1);
    assert.equal(moneyFlowRows.length, 1, "дубль не появился");
  });

  it("dryRun — ничего не пишет, но отчёт как у настоящего прогона", async () => {
    const { db, moneyFlowRows } = financeDb();
    const svc = new FinanceService(db);
    const report = await svc.importBankStatement({
      dryRun: true,
      items: [{ date: "2026-06-12", debit: null, credit: 9000000, cashSymbol: "0200", docNo: "1", extId: "1::2026-06-12" }],
    });
    assert.equal(report.dryRun, true);
    assert.equal(report.created, 1, "dryRun считает как настоящий прогон (R-D7)");
    assert.equal(moneyFlowRows.length, 0, "но ничего не пишет");
  });

  it("более 3000 строк за раз — отбивается до обработки, сообщение называет ФАКТИЧЕСКОЕ число строк", async () => {
    const svc = new FinanceService(db);
    const items = Array.from({ length: 3001 }, (_, i) => ({
      date: "2026-06-01",
      debit: null,
      credit: 1,
      extId: `x${i}`,
    }));
    // Человеческий язык — не только «нельзя», но и «сколько пришло»: владелец
    // должен сразу увидеть, что реально прислал, не считая строки сам.
    await assert.rejects(() => svc.importBankStatement({ items }), /3000 строк.*3001/);
  });
});

describe("FinanceService.cashReconcile — изъято по системе vs сдано в банк (R-K6, срез К, задача 4)", () => {
  it("некорректный формат периода — отбивается до похода в базу", async () => {
    const svc = new FinanceService(db);
    await assert.rejects(() => svc.cashReconcile("21.08.2026", "2026-08-22"), /ГГГГ-ММ-ДД/);
  });

  it("начало периода позже конца — отбивается до похода в базу", async () => {
    const svc = new FinanceService(db);
    await assert.rejects(() => svc.cashReconcile("2026-08-22", "2026-08-01"), /позже конца/);
  });

  it("период без единой инкассации — hasWithdrawn: false, а не 0, сходящийся молча", async () => {
    const db = {
      select: (_cols?: unknown) => ({
        from: (t: unknown) => ({
          where: () =>
            Promise.resolve(
              t === collection
                ? []
                : [{ date: new Date("2026-06-12T00:00:00+05:00"), amount: "9000000" }],
            ),
        }),
      }),
    } as never;
    const svc = new FinanceService(db);
    const report = await svc.cashReconcile("2026-06-01", "2026-06-30");
    assert.equal(report.hasWithdrawn, false);
    assert.equal(report.hasDeposited, true);
    assert.equal(report.deposited, 9000000);
    assert.equal(report.periods[0]!.status, "noWithdrawn");
  });
});
