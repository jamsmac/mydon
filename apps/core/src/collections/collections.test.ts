import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";
import path from "node:path";
import { collection as collectionTable, coffeeOrder as coffeeOrderTable, entity as entityTable, sale as saleTable } from "@mydon/db";
import { CollectionsService } from "./collections.service";

type Row = Record<string, unknown>;

/**
 * Заглушка транзакции. Хитрость: create() сначала ищет автомат (entity),
 * receive/cancel ищут саму инкассацию — здесь это разводится флагом.
 *
 * `конфликт` — вторая инкассация с тем же `clientKey`: `onConflictDoNothing`
 * возвращает пустой `returning()`, и `create()` обязана сама дочитать уже
 * лежащую строку отдельным `select`. Разводится счётчиком: заглушка таблиц
 * не различает, ПЕРВЫЙ это select (ищет автомат) или ВТОРОЙ (ищет повтор).
 */
function stub(opts: { machine?: Row | null; existing?: Row | null; конфликт?: Row }) {
  const audit: Row[] = [];
  let выборок = 0;
  const базовые = () =>
    opts.machine !== undefined ? (opts.machine ? [opts.machine] : []) : opts.existing ? [opts.existing] : [];
  const withFor = (r: Row[]) =>
    Object.assign(Promise.resolve(r), { limit: async () => r, for: async () => r });
  const tx = {
    select: () => {
      выборок += 1;
      const строки = opts.конфликт && выборок > 1 ? [opts.конфликт] : базовые();
      return { from: () => ({ where: () => withFor(строки) }) };
    },
    insert: () => ({
      values: (v: Row) => {
        if (typeof v.action === "string") audit.push(v);
        const конфликт = opts.конфликт != null && v.clientKey === opts.конфликт.clientKey;
        const хвост = { returning: async () => (конфликт ? [] : [{ id: "c1", ...v }]) };
        return Object.assign(Promise.resolve(undefined), хвост, {
          onConflictDoNothing: () => Object.assign(Promise.resolve(undefined), хвост),
        });
      },
    }),
    update: () => ({
      set: (v: Row) => ({ where: () => ({ returning: async () => [{ ...(opts.existing ?? {}), ...v }] }) }),
    }),
  };
  const db = { transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx) } as never;
  return { db, audit };
}

describe("Инкассация: ключ идемпотентности (R-I-2)", () => {
  it("`create` без ключа пишет строку и `NULL` в `client_key` — ключ обязателен только там, где его дал клиент", async () => {
    const { db } = stub({ machine: { id: "m1", type: "machine" } });
    const c = await new CollectionsService(db).create({ machineId: "m1", operatorId: "p1" });
    assert.equal((c as unknown as Row).clientKey, null);
  });

  it("`create` кладёт переданный ключ полем, а не выдумывает свой", async () => {
    // Синтетический `mydon:collection:<uuid>` уникален по построению и не
    // защищает НИ ОТ ЧЕГО: повтор нажатия получил бы новый uuid и лёг бы
    // второй строкой — ровно то, против чего ключ заводят.
    const { db } = stub({ machine: { id: "m1", type: "machine" } });
    const c = await new CollectionsService(db).create({ machineId: "m1", operatorId: "p1", clientKey: "bot:collect:p1:m1:2026-08-26T14:07" });
    assert.equal((c as unknown as Row).clientKey, "bot:collect:p1:m1:2026-08-26T14:07");
  });

  it("повтор с тем же `clientKey` возвращает ПЕРВУЮ строку, второй строки нет", async () => {
    const первая = { id: "c1", clientKey: "bot:collect:p1:m1:2026-08-26T14:07", collectedAt: new Date("2026-08-26T09:07:00Z") };
    const { db } = stub({ machine: { id: "m1", type: "machine" }, конфликт: первая });
    const c = await new CollectionsService(db).create({ machineId: "m1", operatorId: "p1", clientKey: первая.clientKey });
    assert.equal(c.id, "c1");
    // Момент ПЕРВОГО сбора, а не времени повторного нажатия: человек увидит,
    // что уже записано, и не станет писать второй раз.
    assert.equal(String(c.collectedAt), String(первая.collectedAt));
  });

  it("повтор с тем же `clientKey` не пишет вторую запись в `audit_log`", async () => {
    const первая = { id: "c1", clientKey: "bot:collect:p1:m1:2026-08-26T14:07" };
    const { db, audit } = stub({ machine: { id: "m1", type: "machine" }, конфликт: первая });
    await new CollectionsService(db).create({ machineId: "m1", operatorId: "p1", clientKey: первая.clientKey });
    assert.equal(audit.filter((a) => a.action === "collection.collected").length, 0, "о том же событии журнал пишут один раз");
  });

  it("разные нажатия (разные ключи) дают две инкассации — за сутки бывает два сбора", async () => {
    const s = new CollectionsService(stub({ machine: { id: "m1", type: "machine" } }).db);
    const a = await s.create({ machineId: "m1", operatorId: "p1", clientKey: "bot:collect:p1:m1:2026-08-26T09:07" });
    const b = await s.create({ machineId: "m1", operatorId: "p1", clientKey: "bot:collect:p1:m1:2026-08-26T17:31" });
    assert.notEqual((a as unknown as Row).clientKey, (b as unknown as Row).clientKey);
  });

  it("писатель `collection` в Core ровно один — второй не имеет права появиться без ключа незаметно", () => {
    // Поведенческие тесты выше проверяют ЭТОТ путь. Они ничего не скажут про
    // новый сервис, который начнёт писать инкассации своим insert'ом мимо
    // clientKey — а именно так ключ идемпотентности и перестаёт работать.
    // Исходники читаются относительно dist: тесты пакета исполняются оттуда.
    const корень = path.resolve(__dirname, "..", "..", "src");
    const файлы: string[] = [];
    const обойти = (dir: string) => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, d.name);
        if (d.isDirectory()) обойти(p);
        else if (d.name.endsWith(".ts") && !d.name.endsWith(".test.ts")) файлы.push(p);
      }
    };
    обойти(корень);
    const писатели = файлы.filter((f) => /\binsert\(\s*collection\s*\)/.test(readFileSync(f, "utf8")));
    assert.deepEqual(
      писатели.map((f) => path.relative(корень, f)),
      ["collections/collections.service.ts"],
      "появился второй писатель collection — он обязан принимать clientKey и звать onConflictDoNothing",
    );
  });
});

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
    // итог/внеИтога — тоже честный ноль, а не undefined и не деление на ноль.
    assert.deepEqual(r.итог, { выручка: 0, изъято: 0, разница: 0, доля: null, автоматов: 0 });
    assert.deepEqual(r.внеИтога, { автоматов: 0, выручка: 0 });
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
    assert.equal(iv1.доля, 25); // 10000 / 40000
    assert.equal(iv1.статус, "обычный");
    assert.equal(iv2.дней, 83);
    assert.equal(iv2.статус, "обычный");
    assert.equal(iv3.дней, 365);
    assert.equal(iv3.разница, -190000); // 10000 - 200000
    assert.equal(iv3.доля, -95); // -190000 / 200000
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

    // Статусы: m1 — обычная строка; m2 инкассировался, но выручки нет;
    // m3 — выручка есть, но инкассаций не заводили ни разу (не недостача).
    assert.equal(m1.статус, "обычный");
    assert.equal(m2.статус, "выручки нет");
    assert.equal(m3.статус, "инкассаций нет вовсе");

    // Итог считается ТОЛЬКО по «обычным» строкам (здесь — один m1), m2/m3
    // видны отдельно, числом, а не растворены молча в общей сумме.
    assert.deepEqual(r.итог, { выручка: 100000, изъято: 90000, разница: -10000, доля: -10, автоматов: 1 });
    assert.deepEqual(r.внеИтога, { автоматов: 2, выручка: 5000 }); // m2.выручка(0) + m3.выручка(5000)

    // Если бы m2/m3 попали в итог наравне с m1, доля сдвинулась бы и даже
    // сменила знак — доказательство, что фильтр по статусу обязателен.
    const наивнаяВыручка = r.rows.reduce((s, x) => s + x.выручка, 0); // 100000+0+5000
    const наивноеИзъято = r.rows.reduce((s, x) => s + x.изъято, 0); // 90000+30000+0
    const наивнаяДоля = Math.round(((наивноеИзъято - наивнаяВыручка) / наивнаяВыручка) * 10000) / 100;
    assert.equal(наивнаяДоля, 14.29);
    assert.notEqual(наивнаяДоля, r.итог.доля, "наивная сумма по ВСЕМ строкам даёт другую (и другого знака) долю");
  });

  it("intervals: доля — null при нулевом ожидании, а не 0 и не Infinity", async () => {
    // Период, за который выручки не было вовсе (ожидалось = 0), но инкассация
    // прошла: делить разницу не на что, и доля обязана быть null, а не
    // ноль (что скрыло бы отклонение) и не бесконечность (что сломало бы витрину).
    const at = (d: string) => new Date(`${d}T10:00:00+05:00`);
    const db = stubReconcile({
      entities: [{ id: "m1", name: "Автомат 1" }],
      intervals: [{ id: "iv0", machineId: "m1", prev: at("2026-04-01"), collectedAt: at("2026-04-05"), amount: "15000", expected: "0" }],
    });
    const s = new CollectionsService(db);
    const r = await s.reconcile("2026-04-01", "2026-04-30");

    const iv0 = r.intervals.find((i) => i.id === "iv0")!;
    assert.equal(iv0.ожидалось, 0);
    assert.equal(iv0.изъято, 15000);
    assert.equal(iv0.разница, 15000);
    assert.equal(iv0.доля, null, "ожидание ноль — доля не считается делением на ноль");
  });
});

describe("Сверка: состояние «ждёт приёма» не читается как недостача (ревью 1.2)", () => {
  it("intervals: инкассация, ЗАКРЫВАЮЩАЯ период, ещё не принята (amount=null) — изъято/разница/доля null, статус «ждёт приёма», а не изъято 0/разница -ожидалось", async () => {
    const at = (d: string) => new Date(`${d}T10:00:00+05:00`);
    const db = stubReconcile({
      entities: [{ id: "m1", name: "Автомат 1" }],
      intervals: [
        { id: "ivPending", machineId: "m1", prev: at("2026-04-01"), collectedAt: at("2026-04-05"), amount: null, expected: "40000" },
      ],
    });
    const s = new CollectionsService(db);
    const r = await s.reconcile("2026-04-01", "2026-04-30");

    const iv = r.intervals.find((i) => i.id === "ivPending")!;
    // ДО фикса: Number(null) === 0 → изъято 0, разница -40000, доля -100% —
    // ложное обвинение в недостаче в штатном окне 2–7 дней между сбором и приёмом.
    assert.equal(iv.изъято, null, "сумма ещё не известна — не 0");
    assert.equal(iv.разница, null, "делить не на что, раз само изъятое неизвестно");
    assert.equal(iv.доля, null);
    assert.equal(iv.статус, "ждёт приёма");
    assert.equal(iv.ожидалось, 40000, "ожидание всё равно посчитано — не пропадает вместе с изъятым");
  });

  it("rows: у автомата ВСЕ сборы периода ждут приёма — инкассаций считается верно (2, не 0), статус «ждёт приёма», а не «инкассаций нет вовсе»", async () => {
    const at = (d: string) => new Date(`${d}T10:00:00+05:00`);
    const db = stubReconcile({
      collections: [
        { machineId: "m1", collectedAt: at("2026-04-10"), receivedAt: null, amount: null },
        { machineId: "m1", collectedAt: at("2026-04-20"), receivedAt: null, amount: null },
      ],
      coffeeOrders: [{ machineId: "m1", ts: at("2026-04-05"), amount: "70000", res: "cash" }],
      entities: [{ id: "m1", name: "Автомат 1" }],
    });
    const s = new CollectionsService(db);
    const r = await s.reconcile("2026-04-01", "2026-04-30");

    const row = r.rows.find((x) => x.machineId === "m1")!;
    assert.equal(row.выручка, 70000);
    assert.equal(row.изъято, 0, "сумма пока неизвестна — 0, но статус объясняет почему, это не недостача");
    assert.equal(row.инкассаций, 2, "ДО фикса continue пропускал amount=null и давал 0 — ложное «инкассаций нет вовсе»");
    assert.equal(row.статус, "ждёт приёма");
    assert.equal(r.итог.автоматов, 0, "«ждёт приёма» — вне итога, как и другие небычные статусы");
    assert.equal(r.внеИтога.автоматов, 1);
  });

  it("rows: смесь принятых и ждущих приёма в одном окне — изъято считает ТОЛЬКО принятое, инкассаций — оба, статус «обычный»", async () => {
    const at = (d: string) => new Date(`${d}T10:00:00+05:00`);
    const db = stubReconcile({
      collections: [
        { machineId: "m1", collectedAt: at("2026-04-05"), receivedAt: at("2026-04-08"), amount: "60000" },
        { machineId: "m1", collectedAt: at("2026-04-20"), receivedAt: null, amount: null },
      ],
      coffeeOrders: [{ machineId: "m1", ts: at("2026-04-03"), amount: "60000", res: "cash" }],
      entities: [{ id: "m1", name: "Автомат 1" }],
    });
    const s = new CollectionsService(db);
    const r = await s.reconcile("2026-04-01", "2026-04-30");

    const row = r.rows.find((x) => x.machineId === "m1")!;
    assert.equal(row.изъято, 60000, "ждущая приёма инкассация не считается нулём внутри суммы принятых");
    assert.equal(row.инкассаций, 2, "оба сбора периода посчитаны, даже если один ещё не принят");
    assert.equal(row.статус, "обычный", "есть хотя бы один ПРИНЯТЫЙ сбор — это не «всё ждёт приёма»");
    assert.equal(r.итог.автоматов, 1, "обычная строка — в итоге");
  });
});

describe("Сверка: итог не искажается пробелом ввода (фикс — 3 снек-автомата, 17 061 000)", () => {
  it("автомат с выручкой и нулём инкассаций исключён из итога, но виден во внеИтога", async () => {
    // Ровно ситуация с прода: American Hospital · snack — продажи есть,
    // инкассаций не заводили НИ РАЗУ за всю историю. Без фильтра такая
    // строка даёт -100% и топит здоровый сигнал по остальному парку.
    const db = stubReconcile({
      collections: [],
      sales: [{ machineId: "snack1", dt: "2026-04-04", amount: "5258000" }],
      entities: [{ id: "snack1", name: "American Hospital · snack" }],
    });
    const s = new CollectionsService(db);
    const r = await s.reconcile("2026-04-01", "2026-04-30");

    const row = r.rows.find((x) => x.machineId === "snack1")!;
    assert.equal(row.выручка, 5258000);
    assert.equal(row.инкассаций, 0);
    assert.equal(row.статус, "инкассаций нет вовсе");

    assert.equal(r.итог.автоматов, 0, "единственная строка — пробел ввода, в итог не входит");
    assert.equal(r.итог.выручка, 0);
    assert.deepEqual(r.внеИтога, { автоматов: 1, выручка: 5258000 });
  });

  it("автомат с инкассациями и нулевой выручкой получает «выручки нет» и тоже вне итога", async () => {
    const at = (d: string) => new Date(`${d}T10:00:00+05:00`);
    const db = stubReconcile({
      collections: [{ machineId: "m9", collectedAt: at("2026-04-10"), receivedAt: at("2026-04-12"), amount: "40000" }],
      entities: [{ id: "m9", name: "Автомат 9" }],
    });
    const s = new CollectionsService(db);
    const r = await s.reconcile("2026-04-01", "2026-04-30");

    const row = r.rows.find((x) => x.machineId === "m9")!;
    assert.equal(row.выручка, 0);
    assert.equal(row.инкассаций, 1);
    assert.equal(row.статус, "выручки нет");

    assert.equal(r.итог.автоматов, 0);
    assert.deepEqual(r.внеИтога, { автоматов: 1, выручка: 0 });
  });

  it("итог.доля считается только по обычным строкам — исключённая строка не должна её сдвигать", async () => {
    const at = (d: string) => new Date(`${d}T10:00:00+05:00`);
    const db = stubReconcile({
      collections: [{ machineId: "healthy", collectedAt: at("2026-04-10"), receivedAt: at("2026-04-12"), amount: "90000" }],
      coffeeOrders: [{ machineId: "healthy", ts: at("2026-04-05"), amount: "100000", res: "cash" }],
      sales: [{ machineId: "snackGhost", dt: "2026-04-06", amount: "17061000" }], // продажи есть, инкассаций нет вовсе
      entities: [
        { id: "healthy", name: "Здоровый автомат" },
        { id: "snackGhost", name: "Снек-фантом" },
      ],
    });
    const s = new CollectionsService(db);
    const r = await s.reconcile("2026-04-01", "2026-04-30");

    // Изолированный сигнал: один нормальный автомат, -10%.
    assert.deepEqual(r.итог, { выручка: 100000, изъято: 90000, разница: -10000, доля: -10, автоматов: 1 });
    assert.equal(r.внеИтога.выручка, 17061000, "17 061 000 никогда не собиравшейся выручки — вне итога, а не растворены в нём");

    // Если бы snackGhost попал в общую сумму, доля утонула бы в -100%-подобном сигнале фантома.
    const наивнаяВыручка = r.rows.reduce((s, x) => s + x.выручка, 0); // 100000 + 17061000
    const наивноеИзъято = r.rows.reduce((s, x) => s + x.изъято, 0); // 90000
    const наивнаяДоля = Math.round(((наивноеИзъято - наивнаяВыручка) / наивнаяВыручка) * 10000) / 100;
    assert.notEqual(наивнаяДоля, r.итог.доля);
    assert.ok(наивнаяДоля < -99, "фантомная выручка без единой инкассации топит здоровый -10% сигнал почти до -100%");
  });
});
