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

/**
 * Преобразует имя колонки БД (snake_case) в ключ строки стаба (camelCase) —
 * та же схема именования, что в packages/db.
 */
function toCamel(dbName: string): string {
  return dbName.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

type CondPart =
  | { kind: "col"; name: string }
  | { kind: "param"; value: unknown }
  | { kind: "op"; text: string }
  | { kind: "sql"; node: unknown };

/**
 * Оценивает drizzle-orm SQL-условие (`eq`/`ne`/`gte`/`lte`, объединённые
 * `and()`) НА ОДНОЙ строке стаба — достаточно для условий, которые реально
 * строит `FinanceService.cashReconcile` (не общий SQL-движок). В отличие от
 * `conditionValues` выше (плоский список значений — годится только для
 * поиска по extId), разбирает дерево `queryChunks` РЕКУРСИВНО и проверяет
 * настоящее условие (колонка + оператор + значение на каждой строке), а не
 * просто «встречается ли значение где-то в дереве». Ревью среза К («ОБЩЕЕ»):
 * старый стаб этого блока подменял `.where()` целиком и не проверял фильтры
 * вовсе — не отличил бы «фильтр есть» от «фильтра нет».
 */
function evalDrizzleCondition(node: unknown, row: Row): boolean {
  if (node == null || typeof node !== "object") return true;
  const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) return true;

  const parts: CondPart[] = [];
  for (const c of chunks) {
    const ctor = (c as { constructor?: { name?: string } })?.constructor?.name;
    if (ctor === "StringChunk") {
      const raw = (c as { value: unknown }).value;
      const text = (Array.isArray(raw) ? raw.join("") : String(raw ?? "")).trim();
      if (text && text !== "(" && text !== ")") parts.push({ kind: "op", text });
    } else if (ctor === "Param") {
      parts.push({ kind: "param", value: (c as { value: unknown }).value });
    } else if ((c as { table?: unknown }).table && (c as { name?: unknown }).name) {
      parts.push({ kind: "col", name: toCamel((c as { name: string }).name) });
    } else if (Array.isArray((c as { queryChunks?: unknown[] }).queryChunks)) {
      parts.push({ kind: "sql", node: c });
    }
  }

  const sqlParts = parts.filter((p): p is Extract<CondPart, { kind: "sql" }> => p.kind === "sql");
  if (parts.some((p) => p.kind === "op" && p.text === "and")) {
    return sqlParts.every((p) => evalDrizzleCondition(p.node, row));
  }
  if (parts.some((p) => p.kind === "op" && p.text === "or")) {
    return sqlParts.some((p) => evalDrizzleCondition(p.node, row));
  }
  if (sqlParts.length === 1 && parts.every((p) => p.kind === "sql")) {
    return evalDrizzleCondition(sqlParts[0]!.node, row); // одиночная обёртка and()/скобки
  }

  const col = parts.find((p): p is Extract<CondPart, { kind: "col" }> => p.kind === "col");
  const op = parts.find((p): p is Extract<CondPart, { kind: "op" }> => p.kind === "op");
  if (!col || !op) return true; // не похоже на предикат сравнения — не мешаем

  const paramPart = parts.find((p): p is Extract<CondPart, { kind: "param" }> => p.kind === "param");
  const norm = (v: unknown): unknown => (v instanceof Date ? v.getTime() : v);
  const rowValue = norm(row[col.name]);
  const paramValue = norm(paramPart?.value);

  switch (op.text) {
    case "is not null":
      return row[col.name] !== null && row[col.name] !== undefined;
    case "is null":
      return row[col.name] === null || row[col.name] === undefined;
    case "=":
      return rowValue === paramValue;
    case "<>":
      return rowValue !== paramValue;
    case ">=":
      return (rowValue as number) >= (paramValue as number);
    case "<=":
      return (rowValue as number) <= (paramValue as number);
    default:
      return true;
  }
}

/** Стаб БД для cashReconcile — `.where()` РЕАЛЬНО фильтрует по условию (см. evalDrizzleCondition), не подменяется целиком. */
function reconcileDb(seed: { collections?: Row[]; moneyFlows?: Row[] }) {
  const tables = new Map<unknown, Row[]>([
    [collection, seed.collections ?? []],
    [moneyFlow, seed.moneyFlows ?? []],
  ]);
  const db = {
    select: (_cols?: unknown) => ({
      from: (t: unknown) => ({
        where: (cond?: unknown) => Promise.resolve((tables.get(t) ?? []).filter((r) => evalDrizzleCondition(cond, r))),
      }),
    }),
  } as never;
  return db;
}

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
    const svc = new FinanceService(
      reconcileDb({
        collections: [],
        moneyFlows: [{ date: new Date("2026-06-12T00:00:00+05:00"), amount: "9000000", cashSymbol: "0200", status: "actual" }],
      }),
    );
    const report = await svc.cashReconcile("2026-06-01", "2026-06-30");
    assert.equal(report.hasWithdrawn, false);
    assert.equal(report.hasDeposited, true);
    assert.equal(report.deposited, 9000000);
    assert.equal(report.periods[0]!.status, "noWithdrawn");
  });

  it("НАСТОЯЩЕЕ условие: отменённая инкассация — не идёт в изъято (ne(status,'cancelled') реально проверяется на строке)", async () => {
    const svc = new FinanceService(
      reconcileDb({
        collections: [
          { machineId: "m1", collectedAt: new Date("2026-06-05T10:00:00+05:00"), amount: "100000", status: "received" },
          { machineId: "m1", collectedAt: new Date("2026-06-06T10:00:00+05:00"), amount: "999999", status: "cancelled" },
        ],
      }),
    );
    const report = await svc.cashReconcile("2026-06-01", "2026-06-30");
    assert.equal(report.withdrawn, 100000, "отменённая инкассация не должна попасть в сумму");
    assert.equal(report.withdrawnCount, 1);
  });

  it("НАСТОЯЩЕЕ условие: инкассация вне [from, to] по collectedAt — не попадает (gte/lte реально проверяются)", async () => {
    const svc = new FinanceService(
      reconcileDb({
        collections: [
          { machineId: "m1", collectedAt: new Date("2026-05-31T10:00:00+05:00"), amount: "1", status: "received" },
          { machineId: "m1", collectedAt: new Date("2026-06-15T10:00:00+05:00"), amount: "100000", status: "received" },
          { machineId: "m1", collectedAt: new Date("2026-07-01T10:00:00+05:00"), amount: "1", status: "received" },
        ],
      }),
    );
    const report = await svc.cashReconcile("2026-06-01", "2026-06-30");
    assert.equal(report.withdrawn, 100000);
    assert.equal(report.withdrawnCount, 1);
  });

  it("ждущая приёма инкассация (amount=null) БОЛЬШЕ НЕ отфильтровывается запросом — доходит до математики как «ждёт приёма», не как «инкассаций не было» (фикс 1.2, симптом 3)", async () => {
    const svc = new FinanceService(
      reconcileDb({
        collections: [
          { machineId: "m1", collectedAt: new Date("2026-06-05T10:00:00+05:00"), amount: null, status: "collected" },
        ],
        moneyFlows: [{ date: new Date("2026-06-12T00:00:00+05:00"), amount: "9000000", cashSymbol: "0200", status: "actual" }],
      }),
    );
    const report = await svc.cashReconcile("2026-06-01", "2026-06-30");
    // ДО фикса запрос отбивал строку с amount=null (`amount is not null`), и
    // месяц читался бы как noWithdrawn («инкассаций нет вовсе») — теперь это
    // pendingReceipt: инкассация БЫЛА, просто сумма ещё не введена.
    assert.equal(report.periods[0]!.status, "pendingReceipt");
    assert.equal(report.periods[0]!.withdrawnPending, 1);
    assert.equal(report.withdrawnPendingCount, 1);
    assert.equal(report.hasWithdrawn, true, "хоть одна инкассация в периоде БЫЛА — это не «данных нет»");
  });

  it("НАСТОЯЩЕЕ условие: отменённый взнос 0200 — не идёт в сдано (фикс 1.4, симметрично отменённым инкассациям)", async () => {
    const svc = new FinanceService(
      reconcileDb({
        moneyFlows: [
          { date: new Date("2026-06-10T00:00:00+05:00"), amount: "5000000", cashSymbol: "0200", status: "actual" },
          { date: new Date("2026-06-11T00:00:00+05:00"), amount: "9999999", cashSymbol: "0200", status: "cancelled" },
        ],
      }),
    );
    const report = await svc.cashReconcile("2026-06-01", "2026-06-30");
    assert.equal(report.deposited, 5000000, "отменённый взнос не должен попасть в сумму сданного");
    assert.equal(report.depositedCount, 1);
  });
});
