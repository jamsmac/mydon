import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { entity, person, stockBatch, stockMovement } from "@mydon/db";
import { StockService } from "./stock.service";

type Row = Record<string, unknown>;

/**
 * Значения, подставленные в условие: `eq(entity.id, "loc-1")` даёт ["loc-1"].
 * Основа — приём из coffee.service.test.ts (обход РЕКУРСИВНЫЙ: у составного
 * условия `and(eq(...), eq(...))` наверху лежат не параметры, а вложенные
 * SQL-объекты). Добавлена ветка для `inArray(...)`: список параметров у него
 * лежит НЕ в `.value` содержащего чанка, а сам чанк — обычный JS-массив из
 * `Param`-объектов (`{value: "a"}`, `{value: "b"}`, …) — без этой ветки
 * `условиеЗначения(inArray(entity.id, ids))` молча возвращала пусто.
 */
function условиеЗначения(cond: unknown): string[] {
  const out: string[] = [];
  const обойти = (узел: unknown, глубина: number): void => {
    if (узел == null || глубина > 8) return;
    if (Array.isArray(узел)) {
      for (const el of узел) обойти(el, глубина + 1);
      return;
    }
    const v = (узел as { value?: unknown }).value;
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === "string") out.push(x);
    for (const c of (узел as { queryChunks?: unknown[] }).queryChunks ?? []) обойти(c, глубина + 1);
  };
  обойти(cond, 0);
  return out;
}

/**
 * Строка подходит под условие: совпал id, type (entity), clientKey/ingredientId
 * (movement) или extId (batch — идемпотентность массового импорта, срез D
 * задача 3). ingredientId понадобился для `ingredientStock`/`consumption` —
 * без него `movementsOf(eq(stockMovement.ingredientId, id))` фильтровал ленту
 * в пустоту (id движения не совпадает ни с чем), и остаток молча считался
 * нулевым — баг стаба, не сервиса: он просто не был замечен раньше, потому
 * что старые тесты `ingredientStock` не звали.
 *
 * extId и ingredientId — приближённо: реальный запрос extId фильтрует ПАРОЙ
 * (source, extId), стаб же просто проверяет, что значение строки затесалось
 * среди значений условия (см. docstring `условиеЗначения` выше) — фикстур с
 * совпадающим extId у разных source или коллизией id/ingredientId в тестах
 * нет, так что приближение не даёт ложных совпадений.
 */
function rowMatches(row: Row, values: string[]): boolean {
  if (values.length === 0) return true;
  if (values.includes(row.id as string)) return true;
  if ("type" in row && values.includes(row.type as string)) return true;
  if ("clientKey" in row && row.clientKey != null && values.includes(row.clientKey as string)) return true;
  if ("extId" in row && row.extId != null && values.includes(row.extId as string)) return true;
  if ("ingredientId" in row && values.includes(row.ingredientId as string)) return true;
  return false;
}

/**
 * Стаб БД: различает таблицы по ссылке (тот же приём, что и в
 * coffee.service.test.ts). `.where()` фильтрует по id/type/clientKey — этого
 * достаточно для всех запросов, что делает StockService (карточки, партии,
 * поставщики). Запрос суммы расхода по batchId (`.groupBy()`) — особый путь:
 * where на нём не эмулируем (and+inArray), считаем сумму по kind='consumption'
 * прямо из ленты движений — тесты кормят уже подходящие движения.
 *
 * insert/update на `stock_batch`/`stock_movement` мутируют те же массивы
 * фикстур, чтобы последующий `computeBatchRows` (перечитывает таблицы) видел
 * только что созданную/изменённую партию — как в настоящей БД.
 */
function stockDb(tables: { entities?: Row[]; persons?: Row[]; batches?: Row[]; movements?: Row[] }) {
  const entities = tables.entities ?? [];
  const persons = tables.persons ?? [];
  const batches: Row[] = [...(tables.batches ?? [])];
  const movements: Row[] = [...(tables.movements ?? [])];
  const inserts: { table: string; values: Row }[] = [];
  const updates: { table: string; values: Row }[] = [];
  let nextId = 1;

  const tableOf = (t: unknown): Row[] => {
    if (t === entity) return entities;
    if (t === person) return persons;
    if (t === stockBatch) return batches;
    if (t === stockMovement) return movements;
    return [];
  };
  const nameOf = (t: unknown): string => {
    if (t === entity) return "entity";
    if (t === person) return "person";
    if (t === stockBatch) return "stock_batch";
    if (t === stockMovement) return "stock_movement";
    return "unknown";
  };

  const selectChain = (t: unknown) => {
    const original = tableOf(t);
    let rows = original;
    let grouped = false;
    const chain = {
      where: (cond?: unknown) => {
        const values = условиеЗначения(cond);
        rows = rows.filter((r) => rowMatches(r, values));
        return chain;
      },
      groupBy: () => {
        grouped = true;
        return chain;
      },
      orderBy: () => chain,
      limit: () => Promise.resolve(rows),
      then: (resolve: (v: unknown[]) => void) => {
        if (grouped) {
          // Особый путь: сумма qty по batchId для kind='consumption', из
          // ПОЛНОЙ (не where-урезанной) ленты — see docstring выше.
          const sums = new Map<string, number>();
          for (const m of original) {
            if ((m as { kind?: string }).kind !== "consumption") continue;
            const bid = (m as { batchId?: string | null }).batchId;
            if (!bid) continue;
            sums.set(bid, (sums.get(bid) ?? 0) + Number((m as { qty?: unknown }).qty ?? 0));
          }
          resolve([...sums.entries()].map(([batchId, sum]) => ({ batchId, sum: String(sum) })));
          return;
        }
        resolve(rows);
      },
    };
    return chain;
  };

  const insertHandler = (t: unknown) => ({
    values: (v: Row) => ({
      onConflictDoNothing: (opts?: { target?: unknown }) => ({
        returning: async (): Promise<Row[]> => {
          // Симулируем уникальный индекс по clientKey: непустой clientKey,
          // уже встречавшийся у другого движения — "ничего не вставили".
          if (t === stockMovement && v.clientKey != null) {
            const dup = movements.some((m) => m.clientKey === v.clientKey);
            if (dup) return [];
          }
          void opts;
          const row = { id: `new-${nameOf(t)}-${nextId++}`, ...v };
          inserts.push({ table: nameOf(t), values: row });
          tableOf(t).push(row);
          return [row];
        },
      }),
      returning: async (): Promise<Row[]> => {
        const row = { id: `new-${nameOf(t)}-${nextId++}`, ...v };
        inserts.push({ table: nameOf(t), values: row });
        tableOf(t).push(row);
        return [row];
      },
    }),
  });

  const db = {
    select: (_cols?: unknown) => ({ from: (t: unknown) => selectChain(t) }),
    insert: insertHandler,
    update: (t: unknown) => ({
      set: (v: Row) => ({
        where: (cond?: unknown) => {
          updates.push({ table: nameOf(t), values: v });
          const values = условиеЗначения(cond);
          for (const row of tableOf(t)) if (rowMatches(row, values)) Object.assign(row, v);
          return Promise.resolve(undefined);
        },
      }),
    }),
    transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb(db),
  } as never;

  return { db, inserts, updates, batches, movements };
}

// ── карточки-фикстуры ──
const кофе = { id: "ing-coffee", type: "ingredient", name: "Кофе", attrs: { "единица": "кг" } };
const кофеСоСроком = {
  id: "ing-coffee-shelf",
  type: "ingredient",
  name: "Кофе (норматив 5 дней)",
  attrs: { "единица": "кг", "срок годности, дней": 5 },
};
const склад = { id: "wh-main", type: "warehouse", name: "Основной склад", attrs: {} };
const ауратрейд = { id: "ent-auratrade", type: "contractor", name: '"AURATRADE 18" MCHJ', attrs: {} };
const сотрудник = { id: "per-1", name: "Кладовщик" };

describe("StockService: остаток партии — леджером", () => {
  it("без расходных движений — остаток равен qtyReceived", async () => {
    const batch = { id: "b1", ingredientId: "ing-coffee", warehouseId: "wh-main", batchCode: null, expiryDate: null, manufactureDate: null, receivedOn: "2026-08-01", qtyReceived: "10.000", unit: "кг", openedOn: null, openedBy: null, personId: null, supplierId: null, invoiceNo: null, invoiceDate: null, note: null, source: "manual" };
    const { db } = stockDb({ entities: [кофе, склад], batches: [batch] });
    const svc = new StockService(db);
    const res = await svc.listBatches({});
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0]!.remaining, 10);
  });

  it("расходное (consumption) движение с этим batchId уменьшает остаток партии", async () => {
    const batch = { id: "b1", ingredientId: "ing-coffee", warehouseId: "wh-main", batchCode: null, expiryDate: null, manufactureDate: null, receivedOn: "2026-08-01", qtyReceived: "10.000", unit: "кг", openedOn: null, openedBy: null, personId: null, supplierId: null, invoiceNo: null, invoiceDate: null, note: null, source: "manual" };
    const movements = [{ id: "mv1", kind: "consumption", batchId: "b1", qty: "3.500" }];
    const { db } = stockDb({ entities: [кофе, склад], batches: [batch], movements });
    const svc = new StockService(db);
    const res = await svc.listBatches({});
    assert.equal(res.rows[0]!.remaining, 6.5);
  });

  it("движение БЕЗ batchId (снимок владельца — adjustment) остаток партии не трогает", async () => {
    // Ровно факт с прода 21.08: adjustment без партии относится к ингредиенту
    // целиком, не к конкретной партии (шаг 1 брифа).
    const batch = { id: "b1", ingredientId: "ing-coffee", warehouseId: "wh-main", batchCode: null, expiryDate: null, manufactureDate: null, receivedOn: "2026-08-01", qtyReceived: "10.000", unit: "кг", openedOn: null, openedBy: null, personId: null, supplierId: null, invoiceNo: null, invoiceDate: null, note: null, source: "manual" };
    const movements = [{ id: "mv-snap", kind: "adjustment", batchId: null, qty: "43000.000" }];
    const { db } = stockDb({ entities: [кофе, склад], batches: [batch], movements });
    const svc = new StockService(db);
    const res = await svc.listBatches({});
    assert.equal(res.rows[0]!.remaining, 10, "снимок владельца без партии не должен обнулять остаток партии");
  });
});

describe("StockService: срок годности партии", () => {
  it("нет expiryDate, нет manufactureDate, карточка без норматива — флаг none, срок не выдуман", async () => {
    const batch = { id: "b1", ingredientId: "ing-coffee", warehouseId: "wh-main", batchCode: null, expiryDate: null, manufactureDate: null, receivedOn: "2026-08-01", qtyReceived: "5.000", unit: "кг", openedOn: null, openedBy: null, personId: null, supplierId: null, invoiceNo: null, invoiceDate: null, note: null, source: "manual" };
    const { db } = stockDb({ entities: [кофе, склад], batches: [batch] });
    const svc = new StockService(db);
    const res = await svc.listBatches({});
    assert.equal(res.rows[0]!.expiry, null);
    assert.equal(res.rows[0]!.flag, "none");
  });

  it("нет expiryDate — считается от manufactureDate + карточный «срок годности, дней»", async () => {
    const batch = {
      id: "b1",
      ingredientId: "ing-coffee-shelf",
      warehouseId: "wh-main",
      batchCode: null,
      expiryDate: null,
      manufactureDate: "2026-08-20",
      receivedOn: "2026-08-21",
      qtyReceived: "5.000",
      unit: "кг",
      openedOn: null,
      openedBy: null,
      personId: null,
      supplierId: null,
      invoiceNo: null,
      invoiceDate: null,
      note: null,
      source: "manual",
    };
    const { db } = stockDb({ entities: [кофеСоСроком, склад], batches: [batch] });
    const svc = new StockService(db);
    const res = await svc.listBatches({});
    // manufactureDate 2026-08-20 + 5 дней = 2026-08-25.
    assert.equal(res.rows[0]!.expiry, "2026-08-25");
    // Флаг считается от ТАШКЕНТСКИХ суток, а не от абсолютного момента, поэтому
    // он стабилен внутри дня и его можно проверять точно. Прежний assert
    // допускал сразу три значения «в зависимости от системных часов» — и ровно
    // этим замаскировал баг границы суток: партия со сроком «сегодня» краснела
    // с пяти утра. Ослабленный assert не ловит того, ради чего написан.
    const дней = Math.round(
      (new Date("2026-08-25T00:00:00Z").getTime() -
        new Date(`${new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" })}T00:00:00Z`).getTime()) /
        86400000,
    );
    const ожидание = дней < 0 ? "expired" : дней <= 14 ? "expiring" : "ok";
    assert.equal(res.rows[0]!.flag, ожидание, `срок 2026-08-25 — это ${дней} дн. от ташкентского сегодня`);
  });

  it("явная expiryDate партии побеждает норматив карточки", async () => {
    const batch = {
      id: "b1",
      ingredientId: "ing-coffee-shelf",
      warehouseId: "wh-main",
      batchCode: null,
      expiryDate: "2099-01-01",
      manufactureDate: "2026-08-20",
      receivedOn: "2026-08-21",
      qtyReceived: "5.000",
      unit: "кг",
      openedOn: null,
      openedBy: null,
      personId: null,
      supplierId: null,
      invoiceNo: null,
      invoiceDate: null,
      note: null,
      source: "manual",
    };
    const { db } = stockDb({ entities: [кофеСоСроком, склад], batches: [batch] });
    const svc = new StockService(db);
    const res = await svc.listBatches({});
    assert.equal(res.rows[0]!.expiry, "2099-01-01");
    assert.equal(res.rows[0]!.flag, "ok");
  });
});

describe("StockService: флаг срока — по ташкентским суткам", () => {
  it("партия со сроком СЕГОДНЯ ещё не просрочена", async () => {
    // Дата из postgres приходит строкой, а `new Date("2026-08-21")` — это
    // UTC-полночь, то есть 05:00 по Ташкенту. Сравнение с реальным «сейчас»
    // краснило бы чип с пяти утра дня, в который партия ещё годна.
    const сегодня = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" });
    const batch = { id: "b1", ingredientId: "ing-coffee", warehouseId: "wh-main", batchCode: null, expiryDate: сегодня, manufactureDate: null, receivedOn: "2026-08-01", qtyReceived: "5.000", unit: "кг", openedOn: null, openedBy: null, personId: null, supplierId: null, invoiceNo: null, invoiceDate: null, note: null, source: "manual" };
    const { db } = stockDb({ entities: [кофе, склад], batches: [batch] });
    const svc = new StockService(db);
    const res = await svc.listBatches({});
    assert.equal(res.rows[0]!.flag, "expiring", "последний день годности — ещё не «Просрочено»");
  });

  it("вчерашний срок — просрочено", async () => {
    const вчера = new Date(Date.now() - 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" });
    const batch = { id: "b1", ingredientId: "ing-coffee", warehouseId: "wh-main", batchCode: null, expiryDate: вчера, manufactureDate: null, receivedOn: "2026-08-01", qtyReceived: "5.000", unit: "кг", openedOn: null, openedBy: null, personId: null, supplierId: null, invoiceNo: null, invoiceDate: null, note: null, source: "manual" };
    const { db } = stockDb({ entities: [кофе, склад], batches: [batch] });
    const svc = new StockService(db);
    const res = await svc.listBatches({});
    assert.equal(res.rows[0]!.flag, "expired");
  });
});

describe("StockService: вскрытие партии (openBatch)", () => {
  it("отмечает openedOn/openedBy, opened становится true", async () => {
    const batch = { id: "b1", ingredientId: "ing-coffee", warehouseId: "wh-main", batchCode: null, expiryDate: null, manufactureDate: null, receivedOn: "2026-08-01", qtyReceived: "5.000", unit: "кг", openedOn: null, openedBy: null, personId: null, supplierId: null, invoiceNo: null, invoiceDate: null, note: null, source: "manual" };
    const { db } = stockDb({ entities: [кофе, склад], persons: [сотрудник], batches: [batch] });
    const svc = new StockService(db);
    const res = await svc.openBatch("b1", { openedOn: "2026-08-21", openedBy: "per-1" });
    assert.equal(res.opened, true);
    assert.equal(res.openedOn, "2026-08-21");
  });

  it("повторное вскрытие не переписывает дату и не стирает человека", async () => {
    // Пачку вскрывают один раз (§4.3). Второе нажатие — это второе нажатие, а
    // не второе вскрытие: иначе дата уехала бы на сегодня, а openedBy обнулился
    // бы у уже записанного человека.
    const batch = { id: "b1", ingredientId: "ing-coffee", warehouseId: "wh-main", batchCode: null, expiryDate: null, manufactureDate: null, receivedOn: "2026-08-01", qtyReceived: "5.000", unit: "кг", openedOn: "2026-08-10", openedBy: "per-1", personId: null, supplierId: null, invoiceNo: null, invoiceDate: null, note: null, source: "manual" };
    const { db } = stockDb({ entities: [кофе, склад], persons: [сотрудник], batches: [batch] });
    const svc = new StockService(db);
    const res = await svc.openBatch("b1", {});
    assert.equal(res.openedOn, "2026-08-10", "дата вскрытия осталась прежней");
    assert.equal(res.opened, true);
    assert.equal(batch.openedBy, "per-1", "человек не стёрт");
  });

  it("неизвестная партия — 404, не молчаливый успех", async () => {
    const { db } = stockDb({ entities: [кофе, склад], batches: [] });
    const svc = new StockService(db);
    await assert.rejects(svc.openBatch("missing", {}));
  });
});

describe("StockService: партия и поставщик (matchContractorByName, R-C4)", () => {
  it("поставщик не указан — supplierId null, без выдумок", async () => {
    const { db } = stockDb({ entities: [кофе, склад] });
    const svc = new StockService(db);
    const res = await svc.createBatch({
      ingredientId: "ing-coffee",
      warehouseId: "wh-main",
      qtyReceived: 5,
      unit: "кг",
    });
    assert.equal(res.supplierId, null);
    assert.equal(res.supplierName, null);
  });

  it("имя поставщика совпадает с карточкой контрагента после нормализации (снята юрформа/кавычки)", async () => {
    const { db } = stockDb({ entities: [кофе, склад, ауратрейд] });
    const svc = new StockService(db);
    const res = await svc.createBatch({
      ingredientId: "ing-coffee",
      warehouseId: "wh-main",
      qtyReceived: 5,
      unit: "кг",
      supplier: "AURATRADE 18",
    });
    assert.equal(res.supplierId, "ent-auratrade");
    assert.equal(res.supplierName, '"AURATRADE 18" MCHJ');
  });

  it("имя поставщика не совпало ни с одной карточкой — supplierId null, а не первая попавшаяся", async () => {
    const { db } = stockDb({ entities: [кофе, склад, ауратрейд] });
    const svc = new StockService(db);
    const res = await svc.createBatch({
      ingredientId: "ing-coffee",
      warehouseId: "wh-main",
      qtyReceived: 5,
      unit: "кг",
      supplier: "Совсем другой поставщик",
    });
    assert.equal(res.supplierId, null);
  });
});

describe("StockService: createBatch — приход партии заводит и связанное движение", () => {
  it("создаёт stock_batch И приходное stock_movement с тем же batchId", async () => {
    const { db, inserts } = stockDb({ entities: [кофе, склад] });
    const svc = new StockService(db);
    const res = await svc.createBatch({
      ingredientId: "ing-coffee",
      warehouseId: "wh-main",
      qtyReceived: 12.5,
      unit: "кг",
      receivedOn: "2026-08-21",
    });
    assert.equal(res.qtyReceived, 12.5);
    assert.equal(res.remaining, 12.5);
    const batchInsert = inserts.find((i) => i.table === "stock_batch");
    const movementInsert = inserts.find((i) => i.table === "stock_movement");
    assert.ok(batchInsert);
    assert.ok(movementInsert);
    assert.equal(movementInsert!.values.kind, "intake");
    assert.equal(movementInsert!.values.batchId, batchInsert!.values.id);
  });

  it("повтор по clientKey возвращает ТУ ЖЕ партию, а не ошибку", async () => {
    // Клиент повторяет запрос, когда не дождался ответа по таймауту, — а запись
    // при этом прошла. Ответить ошибкой значит подтолкнуть оператора нажать ещё
    // раз с НОВЫМ ключом, и вот тогда партия действительно задвоится.
    const { db, inserts } = stockDb({ entities: [кофе, склад] });
    const svc = new StockService(db);
    const первый = await svc.createBatch({
      ingredientId: "ing-coffee",
      warehouseId: "wh-main",
      qtyReceived: 12.5,
      unit: "кг",
      receivedOn: "2026-08-21",
      clientKey: "intake-2026-08-21-coffee",
    });
    const повтор = await svc.createBatch({
      ingredientId: "ing-coffee",
      warehouseId: "wh-main",
      qtyReceived: 12.5,
      unit: "кг",
      receivedOn: "2026-08-21",
      clientKey: "intake-2026-08-21-coffee",
    });
    assert.equal(повтор.id, первый.id, "та же партия, а не новая");
    assert.equal(повтор.remaining, первый.remaining, "и остаток тот же");
    assert.equal(inserts.filter((i) => i.table === "stock_batch").length, 1, "второй партии не завелось");
  });

  it("количество ≤ 0 отклоняется", async () => {
    const { db } = stockDb({ entities: [кофе, склад] });
    const svc = new StockService(db);
    await assert.rejects(
      svc.createBatch({ ingredientId: "ing-coffee", warehouseId: "wh-main", qtyReceived: 0, unit: "кг" }),
    );
  });

  it("неизвестная единица отклоняется", async () => {
    const { db } = stockDb({ entities: [кофе, склад] });
    const svc = new StockService(db);
    await assert.rejects(
      svc.createBatch({ ingredientId: "ing-coffee", warehouseId: "wh-main", qtyReceived: 1, unit: "чашка" }),
    );
  });
});

describe("StockService: GET /stock/batches — фильтр по флагу", () => {
  it("неизвестный флаг отклоняется", async () => {
    const { db } = stockDb({ entities: [кофе, склад] });
    const svc = new StockService(db);
    await assert.rejects(svc.listBatches({ flag: "просрочено" }));
  });

  it("флаг сужает список", async () => {
    const b1 = { id: "b1", ingredientId: "ing-coffee", warehouseId: "wh-main", batchCode: null, expiryDate: "2020-01-01", manufactureDate: null, receivedOn: "2026-08-01", qtyReceived: "5.000", unit: "кг", openedOn: null, openedBy: null, personId: null, supplierId: null, invoiceNo: null, invoiceDate: null, note: null, source: "manual" };
    const b2 = { id: "b2", ingredientId: "ing-coffee", warehouseId: "wh-main", batchCode: null, expiryDate: "2099-01-01", manufactureDate: null, receivedOn: "2026-08-01", qtyReceived: "5.000", unit: "кг", openedOn: null, openedBy: null, personId: null, supplierId: null, invoiceNo: null, invoiceDate: null, note: null, source: "manual" };
    const { db } = stockDb({ entities: [кофе, склад], batches: [b1, b2] });
    const svc = new StockService(db);
    const res = await svc.listBatches({ flag: "expired" });
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0]!.id, "b1");
  });
});

describe("StockService: израсходованная партия не попадает в сроки годности", () => {
  it("партия с нулевым остатком не считается и не показывается", async () => {
    // Импорт истории заводит партию прошлого года и тут же закрывает её
    // расходом: на полке её нет. Показать такую среди сроков значит позвать
    // разбираться с несуществующим товаром — а после загрузки реестра таких
    // партий сразу десятки.
    const просрочена = { id: "b1", ingredientId: "ing-coffee", warehouseId: "wh-main", batchCode: null, expiryDate: "2025-01-01", manufactureDate: null, receivedOn: "2024-12-01", qtyReceived: "10.000", unit: "кг", openedOn: null, openedBy: null, personId: null, supplierId: null, invoiceNo: null, invoiceDate: null, note: null, source: "excel" };
    const { db } = stockDb({
      entities: [кофе, склад],
      batches: [просрочена],
      movements: [
        { id: "m1", kind: "intake", ingredientId: "ing-coffee", warehouseId: "wh-main", batchId: "b1", qty: "10.000", unit: "кг", dt: "2024-12-01" },
        { id: "m2", kind: "consumption", ingredientId: "ing-coffee", warehouseId: "wh-main", batchId: "b1", qty: "10.000", unit: "кг", dt: "2026-08-21" },
      ],
    });
    const svc = new StockService(db);
    const отчёт = await svc.expiryReport();
    assert.equal(отчёт.rows.length, 0, "израсходованной партии в сроках нет");
    assert.equal(отчёт.counts.expired, 0, "и в счётчике «просрочено» её тоже нет");
  });
});

describe("StockService: GET /stock/expiry — счётчики и порядок FEFO", () => {
  it("считает партии по флагам и определяет очередь FEFO внутри группы ингредиент×склад", async () => {
    // b1 истекает раньше (2026-09-01), b2 позже (2026-12-01) — b1 должен уйти первым.
    const b1 = { id: "b1", ingredientId: "ing-coffee", warehouseId: "wh-main", batchCode: null, expiryDate: "2026-09-01", manufactureDate: null, receivedOn: "2026-08-01", qtyReceived: "3.000", unit: "кг", openedOn: null, openedBy: null, personId: null, supplierId: null, invoiceNo: null, invoiceDate: null, note: null, source: "manual" };
    const b2 = { id: "b2", ingredientId: "ing-coffee", warehouseId: "wh-main", batchCode: null, expiryDate: "2026-12-01", manufactureDate: null, receivedOn: "2026-07-01", qtyReceived: "4.000", unit: "кг", openedOn: null, openedBy: null, personId: null, supplierId: null, invoiceNo: null, invoiceDate: null, note: null, source: "manual" };
    const { db } = stockDb({ entities: [кофе, склад], batches: [b1, b2] });
    const svc = new StockService(db);
    const res = await svc.expiryReport();
    assert.equal(res.counts.expired + res.counts.expiring + res.counts.ok + res.counts.none, 2);
    const r1 = res.rows.find((r) => r.id === "b1")!;
    const r2 = res.rows.find((r) => r.id === "b2")!;
    assert.equal(r1.fefoOrder, 1);
    assert.equal(r2.fefoOrder, 2);
  });

  it("партий нет вовсе — честный пустой отчёт, не падает", async () => {
    const { db } = stockDb({ entities: [кофе, склад] });
    const svc = new StockService(db);
    const res = await svc.expiryReport();
    assert.deepEqual(res.rows, []);
    assert.deepEqual(res.counts, { expired: 0, expiring: 0, ok: 0, none: 0 });
  });
});

describe("StockService: createBatch — повтор по (source, extId), R-D1 закрытие расходом", () => {
  it("повтор по (source, extId) возвращает ТУ ЖЕ партию, вторая не заводится", async () => {
    // Тот же принцип, что и у clientKey: у stock_batch есть уникальный индекс
    // stock_batch_ext_key на (source, ext_id), но раньше сервис его не
    // проверял — повтор падал сырой ошибкой Postgres (факт 9 брифа).
    const { db, inserts } = stockDb({ entities: [кофе, склад] });
    const svc = new StockService(db);
    const первый = await svc.createBatch({
      ingredientId: "ing-coffee",
      warehouseId: "wh-main",
      qtyReceived: 43,
      unit: "кг",
      receivedOn: "2025-05-17",
      source: "purchase-register",
      extId: "register:12",
    });
    const повтор = await svc.createBatch({
      ingredientId: "ing-coffee",
      warehouseId: "wh-main",
      qtyReceived: 43,
      unit: "кг",
      receivedOn: "2025-05-17",
      source: "purchase-register",
      extId: "register:12",
    });
    assert.equal(повтор.id, первый.id, "та же партия, а не новая");
    assert.equal(
      inserts.filter((i) => i.table === "stock_batch").length,
      1,
      "второй партии не завелось",
    );
  });

  it("closeOn закрывает партию расходом: remaining партии — 0, баланс ингредиента не изменился (R-D1)", async () => {
    // Ruling R-D1: импорт истории закупок БЕЗ закрытия расходом задвоил бы
    // остаток (кофе стал бы ~293 кг вместо реальных 43 на живом складе).
    const { db } = stockDb({ entities: [кофе, склад] });
    const svc = new StockService(db);
    const before = await svc.ingredientStock("ing-coffee");
    assert.equal(before.total, 0, "движений ещё нет — остаток нулевой");

    const batch = await svc.createBatch({
      ingredientId: "ing-coffee",
      warehouseId: "wh-main",
      qtyReceived: 43,
      unit: "кг",
      receivedOn: "2025-05-17",
      source: "purchase-register",
      extId: "register:12",
      closeOn: "2026-08-01",
    });
    assert.equal(batch.qtyReceived, 43, "приход партии записан как есть");
    assert.equal(batch.remaining, 0, "партия закрыта расходом — остаток партии обнулён");

    const after = await svc.ingredientStock("ing-coffee");
    assert.equal(after.total, 0, "приход (+43) и закрывающий расход (−43) гасят друг друга — итог 0");
    assert.equal(
      after.total,
      before.total,
      "приход и закрывающий расход гасят друг друга — баланс ингредиента не изменился",
    );
  });

  it("без closeOn партия остаётся открытой — обычный приход, поведение не изменилось", async () => {
    const { db } = stockDb({ entities: [кофе, склад] });
    const svc = new StockService(db);
    const batch = await svc.createBatch({
      ingredientId: "ing-coffee",
      warehouseId: "wh-main",
      qtyReceived: 12,
      unit: "кг",
      receivedOn: "2025-05-17",
    });
    assert.equal(batch.remaining, 12, "без closeOn — партия открыта, остаток равен приходу");
    const stock = await svc.ingredientStock("ing-coffee");
    assert.equal(stock.total, 12);
  });
});

describe("StockService: importBatches — массовый импорт с предпросмотром (срез D, задача 3)", () => {
  it("создаёт партии по валидным строкам и считает отчёт", async () => {
    const { db } = stockDb({ entities: [кофе, склад] });
    const svc = new StockService(db);
    const res = await svc.importBatches({
      source: "purchase-register",
      items: [
        {
          fileRow: 3,
          ingredientId: "ing-coffee",
          warehouseId: "wh-main",
          qtyReceived: 10,
          unit: "кг",
          receivedOn: "2025-05-17",
        },
        {
          fileRow: 4,
          ingredientId: "ing-coffee",
          warehouseId: "wh-main",
          qtyReceived: 5,
          unit: "кг",
          receivedOn: "2025-06-01",
        },
      ],
    });
    assert.equal(res.dryRun, false);
    assert.equal(res.created, 2);
    assert.equal(res.skippedRepeat, 0);
    assert.deepEqual(res.noDate, []);
    assert.deepEqual(res.unmatched, []);
    assert.deepEqual(res.rejected, []);
    const batches = await svc.listBatches({});
    assert.equal(batches.rows.length, 2);
  });

  it("повтор по (source, extId): второй прогон той же строки — пропущено, партия не задвоена", async () => {
    const { db } = stockDb({ entities: [кофе, склад] });
    const svc = new StockService(db);
    const item = {
      fileRow: 3,
      ingredientId: "ing-coffee",
      warehouseId: "wh-main",
      qtyReceived: 10,
      unit: "кг",
      receivedOn: "2025-05-17",
    };
    const первый = await svc.importBatches({ source: "purchase-register", items: [item] });
    assert.equal(первый.created, 1);
    const второй = await svc.importBatches({ source: "purchase-register", items: [item] });
    assert.equal(второй.created, 0);
    assert.equal(второй.skippedRepeat, 1);
    const batches = await svc.listBatches({});
    assert.equal(batches.rows.length, 1, "партия не задвоилась повторным импортом того же файла");
  });

  it("closeOn у импорта закрывает партии расходом: баланс ингредиента не меняется", async () => {
    const { db } = stockDb({ entities: [кофе, склад] });
    const svc = new StockService(db);
    await svc.importBatches({
      source: "purchase-register",
      closeOn: "2026-08-01",
      items: [
        {
          fileRow: 3,
          ingredientId: "ing-coffee",
          warehouseId: "wh-main",
          qtyReceived: 43,
          unit: "кг",
          receivedOn: "2025-05-17",
        },
      ],
    });
    const stock = await svc.ingredientStock("ing-coffee");
    assert.equal(stock.total, 0, "приход и закрывающий расход гасят друг друга");
    const batches = await svc.listBatches({});
    assert.equal(batches.rows[0]!.remaining, 0);
  });

  it("dryRun ничего не пишет, но отчёт совпадает с настоящим прогоном (R-D7)", async () => {
    const { db } = stockDb({ entities: [кофе, склад] });
    const svc = new StockService(db);
    const items = [
      {
        fileRow: 3,
        ingredientId: "ing-coffee",
        warehouseId: "wh-main",
        qtyReceived: 10,
        unit: "кг",
        receivedOn: "2025-05-17",
      },
    ];
    const preview = await svc.importBatches({ source: "purchase-register", dryRun: true, items });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.created, 1);
    assert.equal(preview.skippedRepeat, 0);
    const afterPreview = await svc.listBatches({});
    assert.equal(afterPreview.rows.length, 0, "dryRun ничего не записал");

    const real = await svc.importBatches({ source: "purchase-register", items });
    assert.equal(real.dryRun, false);
    assert.equal(real.created, preview.created, "отчёт dryRun совпадает с настоящим прогоном");
    assert.equal(real.skippedRepeat, preview.skippedRepeat);
    const afterReal = await svc.listBatches({});
    assert.equal(afterReal.rows.length, 1, "а настоящий прогон партию всё же завёл");
  });

  it("строка без receivedOn не создаёт партию и уходит в «без даты»", async () => {
    const { db } = stockDb({ entities: [кофе, склад] });
    const svc = new StockService(db);
    const res = await svc.importBatches({
      source: "purchase-register",
      items: [
        {
          fileRow: 5,
          ingredientId: "ing-coffee",
          warehouseId: "wh-main",
          qtyReceived: 2,
          unit: "кг",
          receivedOn: null,
          name: "Молоко без даты",
        },
      ],
    });
    assert.equal(res.created, 0);
    assert.deepEqual(res.noDate, [{ fileRow: 5, name: "Молоко без даты" }]);
    const batches = await svc.listBatches({});
    assert.equal(batches.rows.length, 0, "строка без даты не создала партию");
  });

  it("строка без сопоставленной карточки уходит в «не сопоставлено»", async () => {
    const { db } = stockDb({ entities: [кофе, склад] });
    const svc = new StockService(db);
    const res = await svc.importBatches({
      source: "purchase-register",
      items: [
        {
          fileRow: 6,
          ingredientId: null,
          warehouseId: "wh-main",
          qtyReceived: 2,
          unit: "кг",
          receivedOn: "2025-05-17",
          name: "Loramon вода",
        },
      ],
    });
    assert.equal(res.created, 0);
    assert.deepEqual(res.unmatched, [{ fileRow: 6, name: "Loramon вода" }]);
  });

  it("товарная карточка (не ingredient, R-D2) отклоняется с причиной — импорт продолжается для остальных строк", async () => {
    const товар = { id: "prod-snack", type: "product", name: "Сникерс", attrs: {} };
    const { db } = stockDb({ entities: [кофе, склад, товар] });
    const svc = new StockService(db);
    const res = await svc.importBatches({
      source: "purchase-register",
      items: [
        {
          fileRow: 7,
          ingredientId: "prod-snack",
          warehouseId: "wh-main",
          qtyReceived: 3,
          unit: "шт",
          receivedOn: "2025-05-17",
          name: "Сникерс",
        },
        {
          fileRow: 8,
          ingredientId: "ing-coffee",
          warehouseId: "wh-main",
          qtyReceived: 4,
          unit: "кг",
          receivedOn: "2025-05-18",
        },
      ],
    });
    assert.equal(res.created, 1, "вторая строка всё же создала партию — падение первой не роняет пачку");
    assert.equal(res.rejected.length, 1);
    assert.equal(res.rejected[0]!.fileRow, 7);
    assert.ok(res.rejected[0]!.reason.length > 0, "причина отклонения не пуста");
    const batches = await svc.listBatches({});
    assert.equal(batches.rows.length, 1);
  });

  it("пачка больше 500 строк отклоняется", async () => {
    const { db } = stockDb({ entities: [кофе, склад] });
    const svc = new StockService(db);
    const items = Array.from({ length: 501 }, (_, i) => ({
      fileRow: i + 1,
      ingredientId: "ing-coffee",
      warehouseId: "wh-main",
      qtyReceived: 1,
      unit: "кг",
      receivedOn: "2025-05-17",
    }));
    await assert.rejects(svc.importBatches({ source: "purchase-register", items }));
  });
});
