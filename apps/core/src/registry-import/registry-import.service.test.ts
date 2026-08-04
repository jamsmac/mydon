import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  modelKey,
  RegistryImportService,
  unitImportError,
  type ImportUnit,
} from "./registry-import.service";

type Row = Record<string, unknown>;

/**
 * Заглушка Drizzle для импорта: select-цепочки отдают подготовленные ответы
 * ПО ПОРЯДКУ вызовов, insert копит вставленные values — тесты фиксируют
 * идемпотентность (пропуск существующих) и связи по FK, не по имени.
 */
function stubDb(selects: Row[][]) {
  const inserted: { rows: Row[] }[] = [];
  let call = 0;
  const makeChain = () => {
    const result = selects[call] ?? [];
    call += 1;
    const p = Promise.resolve(result);
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => chain,
      then: p.then.bind(p),
      catch: p.catch.bind(p),
    };
    return chain;
  };
  const tx = {
    select: makeChain,
    insert: () => ({
      values: async (rows: Row | Row[]) => {
        inserted.push({ rows: Array.isArray(rows) ? rows : [rows] });
      },
    }),
  };
  const db = {
    select: makeChain,
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
  } as never;
  return { db, inserted };
}

const ORG = [{ id: "org-1" }];

describe("импорт реестра из книги владельца", () => {
  it("контрагенты: существующий ИНН и дубль внутри партии пропускаются", async () => {
    const { db, inserted } = stubDb([ORG, [{ ref: "111111111" }]]);
    const s = new RegistryImportService(db);
    const r = await s.importGloberent({
      contractors: [
        { name: "АГМК", inn: "111111111" }, // уже есть
        { name: "OLMA", inn: "222222222" },
        { name: "OLMA (дубль)", inn: "222222222" }, // дубль в партии
      ],
    });
    assert.deepEqual(r.contractors, { created: 1, skipped: 2 });
    const rows = inserted[0]?.rows ?? [];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.externalRef, "222222222");
    // Слово владельца + провенанс: карточка утверждена И несёт createdFrom.
    assert.ok(rows[0]?.approvedAt instanceof Date);
    assert.equal(typeof rows[0]?.createdFrom, "string");
  });

  it("контрагент с кривым ИНН — отказ всей партии словами, а не тихая порча", async () => {
    const { db } = stubDb([ORG]);
    const s = new RegistryImportService(db);
    await assert.rejects(
      () => s.importGloberent({ contractors: [{ name: "X", inn: "12345" }] }),
      /кривым ИНН/,
    );
  });

  it("счета-фактуры: дедуп по externalRef", async () => {
    const { db, inserted } = stubDb([ORG, [{ ref: "СФ 2026-1" }]]);
    const s = new RegistryImportService(db);
    const r = await s.importGloberent({
      invoices: [
        { ref: "СФ 2026-1", name: "СФ №1", attrs: {} },
        { ref: "СФ 2026-2", name: "СФ №2", attrs: { сумма: 100 } },
      ],
    });
    assert.deepEqual(r.invoices, { created: 1, skipped: 1 });
    assert.equal(inserted[0]?.rows[0]?.externalRef, "СФ 2026-2");
  });

  it("модели: имя сравнивается без регистра и лишних пробелов", async () => {
    const { db, inserted } = stubDb([ORG, [{ name: "CPD15GB3LI-ZSM450" }]]);
    const s = new RegistryImportService(db);
    const r = await s.importGloberent({
      models: [{ name: "cpd15gb3li-zsm450" }, { name: "CPD30  GB3LI" }, { name: "CPD30 GB3LI" }],
    });
    assert.deepEqual(r.models, { created: 1, skipped: 2 });
    assert.equal(inserted[0]?.rows[0]?.name, "CPD30 GB3LI");
  });

  it("машины: существующий VIN пропускается, модель и клиент связываются по FK", async () => {
    const { db, inserted } = stubDb([
      ORG,
      [{ vin: "8910" }], // уже на складе
      [{ id: "model-1", name: "CPD15GB3LI-ZSM450" }],
      [{ id: "client-1", ref: "200640797" }],
      [{ n: "7" }], // max WH-код
    ]);
    const s = new RegistryImportService(db);
    const unit: ImportUnit = {
      name: "CBS20J — 659",
      vin: "659",
      modelName: "cpd15gb3li-zsm450",
      status: "DELIVERED_TO_CLIENT",
      arrivalDate: "2024-11-18",
      clientInn: "200640797",
      salesPrice: 17678571.43,
    };
    const r = await s.importGloberent({
      units: [{ name: "CPD15 — 8910", vin: "8910", status: "IN_STOCK" }, unit],
    });
    assert.equal(r.units.created, 1);
    assert.equal(r.units.skipped, 1);
    assert.deepEqual(r.units.errors, []);
    const rows = inserted[0]?.rows ?? [];
    assert.equal(rows[0]?.code, "WH-0008");
    assert.equal(rows[0]?.modelId, "model-1");
    assert.equal(rows[0]?.clientId, "client-1");
    assert.equal(rows[0]?.status, "DELIVERED_TO_CLIENT");
  });

  it("кривая единица падает в errors, остальные создаются", async () => {
    const { db } = stubDb([ORG, [], [], [], [{ n: "0" }]]);
    const s = new RegistryImportService(db);
    const r = await s.importGloberent({
      units: [
        { name: "Без серийника", vin: "", status: "IN_STOCK" },
        { name: "Кривой статус", vin: "1", status: "SOLD" as never },
        { name: "Живая — 2", vin: "2", status: "IN_STOCK" },
      ],
    });
    assert.equal(r.units.created, 1);
    assert.equal(r.units.errors.length, 2);
  });
});

describe("чистые правила импорта", () => {
  it("unitImportError: даты только ГГГГ-ММ-ДД, статусы из белого списка", () => {
    const base: ImportUnit = { name: "CPD15", vin: "1", status: "IN_STOCK" };
    assert.equal(unitImportError(base), null);
    assert.match(unitImportError({ ...base, arrivalDate: "12.03.2024" }) ?? "", /ГГГГ-ММ-ДД/);
    assert.match(unitImportError({ ...base, status: "ARCHIVED" as never }) ?? "", /статус импорта/);
    assert.match(unitImportError({ ...base, salesPrice: -1 }) ?? "", /больше нуля/);
  });
  it("modelKey сводит регистр и пробелы", () => {
    assert.equal(modelKey("  CPD15  GB3LI "), modelKey("cpd15 gb3li"));
  });
});
