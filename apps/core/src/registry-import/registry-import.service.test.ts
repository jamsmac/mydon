import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  contractImportError,
  flowImportError,
  modelKey,
  RegistryImportService,
  unitImportError,
  type ImportContract,
  type ImportFlow,
  type ImportUnit,
} from "./registry-import.service";

type Row = Record<string, unknown>;

/**
 * Заглушка Drizzle для импорта: select-цепочки отдают подготовленные ответы
 * ПО ПОРЯДКУ вызовов, insert копит вставленные values — тесты фиксируют
 * идемпотентность (пропуск существующих) и связи по FK, не по имени.
 */
function stubDb(selects: Row[][], updateResults: Row[][] = []) {
  const inserted: { rows: Row[] }[] = [];
  const updated: { set: Row }[] = [];
  const deletes: number[] = [];
  let call = 0;
  let updCall = 0;
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
      // Ожидаемо и как await values(...), и как values(...).returning(...).
      values: (rows: Row | Row[]) => {
        inserted.push({ rows: Array.isArray(rows) ? rows : [rows] });
        const p = Promise.resolve();
        return {
          then: p.then.bind(p),
          catch: p.catch.bind(p),
          returning: async () => [{ id: `ins-${inserted.length}` }],
        };
      },
    }),
    update: () => ({
      set: (set: Row) => {
        updated.push({ set });
        const result = updateResults[updCall] ?? [];
        updCall += 1;
        const p = Promise.resolve();
        return {
          where: () => ({
            returning: async () => result,
            then: p.then.bind(p),
            catch: p.catch.bind(p),
          }),
        };
      },
    }),
    delete: () => ({ where: async () => deletes.push(1) }),
  };
  const db = {
    select: makeChain,
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
  } as never;
  return { db, inserted, updated, deletes };
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

describe("своя компания (own_company)", () => {
  it("создаётся с ИНН как номером записи, утверждённая и с провенансом", async () => {
    const { db, inserted } = stubDb([ORG, []]);
    const s = new RegistryImportService(db);
    const r = await s.importGloberent({
      ownCompany: { name: 'OOO "GLOBERENT FINANCE"', attrs: { inn: "303736663", mfo: "01145" } },
    });
    assert.deepEqual(r.ownCompany, { created: 1, skipped: 0 });
    const row = inserted[0]?.rows[0];
    assert.equal(row?.type, "own_company");
    assert.equal(row?.externalRef, "303736663");
    assert.ok(row?.approvedAt instanceof Date);
  });

  it("существующая карточка НЕ перезаписывается — правки из панели важнее сида", async () => {
    const { db, inserted } = stubDb([ORG, [{ id: "own-1" }]]);
    const s = new RegistryImportService(db);
    const r = await s.importGloberent({
      ownCompany: { name: "Другое имя", attrs: {} },
    });
    assert.deepEqual(r.ownCompany, { created: 0, skipped: 1 });
    assert.equal(inserted.length, 0);
  });
});

describe("денежные записи (flows)", () => {
  const flow = (over: Partial<ImportFlow>): ImportFlow => ({
    direction: "in",
    amount: 327040000,
    category: "sale",
    date: "2026-01-08",
    purpose: "CPD35GC6LI-S-M300 - 1167",
    docNo: "СФ 2026-2",
    ...over,
  });

  it("дедуп по docNo+purpose; контрагент и машина связываются по FK", async () => {
    const { db, inserted } = stubDb([
      ORG,
      [{ docNo: "СФ 2026-2", purpose: "CPD35GC6LI-S-M300 - 1167" }], // уже есть
      [{ id: "client-1", ref: "202328794" }],
      [{ id: "unit-1", vin: "1168" }],
    ]);
    const s = new RegistryImportService(db);
    const r = await s.importGloberent({
      flows: [
        flow({}), // дубль — пропуск
        flow({
          docNo: "СФ 2026-3",
          purpose: "CPD35GC6LI-S-M300 - 1168",
          counterpartyInn: "202328794",
          unitVin: "1168",
        }),
      ],
    });
    assert.equal(r.flows.created, 1);
    assert.equal(r.flows.skipped, 1);
    assert.deepEqual(r.flows.errors, []);
    const rows = inserted.flatMap((i) => i.rows).filter((x) => x.docNo !== undefined);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.counterpartyId, "client-1");
    assert.equal(rows[0]?.unitId, "unit-1");
    assert.equal(rows[0]?.status, "actual");
    assert.equal(rows[0]?.currency, "UZS");
  });

  it("кривые записи падают в errors словами, не в базу", () => {
    assert.match(flowImportError(flow({ amount: 0 })) ?? "", /больше нуля/);
    assert.match(flowImportError(flow({ category: "прибыль" })) ?? "", /словаря/);
    assert.match(flowImportError(flow({ date: "08.01.2026" })) ?? "", /ГГГГ-ММ-ДД/);
    assert.match(flowImportError(flow({ docNo: "" })) ?? "", /docNo/);
    assert.equal(flowImportError(flow({})), null);
  });

  it("дубль ключа внутри одной партии тоже пропускается", async () => {
    const { db, inserted } = stubDb([ORG, [], [], []]);
    const s = new RegistryImportService(db);
    const r = await s.importGloberent({ flows: [flow({}), flow({})] });
    assert.equal(r.flows.created, 1);
    assert.equal(r.flows.skipped, 1);
    assert.equal(inserted.flatMap((i) => i.rows).filter((x) => x.docNo !== undefined).length, 1);
  });
});

describe("договоры (contracts)", () => {
  const base: ImportContract = {
    contractNo: "GFH-04/0126",
    contractDate: "2026-01-28",
    buyerName: '"XALQ RETAIL" MCHJ XK',
    buyerInn: "306955509",
    totalWithVat: 5479488000,
    totalVat: 587088000,
    status: "active",
    flowDocNos: ["СФ 2026-15", "СФ 2026-31"],
  };

  // Порядок select-ов шага: свои карточки (провенанс), существующие по номеру,
  // клиенты по ИНН, своя компания.
  const SELECTS = (mine: Row[], existing: Row[]) => [
    ORG,
    mine,
    existing,
    [{ id: "client-1", ref: "306955509" }],
    [{ id: "own-1" }],
  ];

  it("новый договор создаётся: клиент и продавец по FK, приходы привязываются", async () => {
    const { db, inserted, updated } = stubDb(SELECTS([], []), [[{ id: "mf-1" }, { id: "mf-2" }]]);
    const s = new RegistryImportService(db);
    const r = await s.importGloberent({ contracts: [base] });
    assert.deepEqual(r.contracts, {
      created: 1,
      updated: 0,
      deleted: 0,
      skipped: 0,
      errors: [],
      flowsLinked: 2,
    });
    const row = inserted[0].rows[0];
    assert.equal(row.contractNo, "GFH-04/0126");
    assert.equal(row.clientId, "client-1");
    assert.equal(row.sellerCompanyId, "own-1");
    assert.equal(row.status, "active");
    assert.deepEqual(row.buyer, { name: '"XALQ RETAIL" MCHJ XK', inn: "306955509" });
    // Привязка — установка contract_id на money_flow, не вторая запись денег.
    assert.equal(updated.length, 1);
    assert.equal((updated[0].set as { contractId?: unknown }).contractId, "ins-1");
  });

  it("своя карточка обновляется: разбор выгрузки уточняется каждым прогоном", async () => {
    const mine = [{ id: "c-mine", no: "GFH-04/0126" }];
    const { db, updated } = stubDb(SELECTS(mine, mine), [[], [{ id: "mf-9" }]]);
    const s = new RegistryImportService(db);
    const r = await s.importGloberent({
      source: "Didox: реестры документов",
      contracts: [{ ...base, totalWithVat: 999, status: "closed" }],
    });
    assert.equal(r.contracts.updated, 1);
    assert.equal(r.contracts.created, 0);
    assert.equal(r.contracts.skipped, 0);
    const set = updated[0].set as { totalWithVat?: unknown; status?: unknown };
    assert.equal(set.totalWithVat, "999");
    assert.equal(set.status, "closed");
  });

  it("карточка владельца не трогается: правки из панели важнее сида", async () => {
    const { db, updated } = stubDb(SELECTS([], [{ id: "c-hand", no: "GFH-04/0126" }]), [
      [{ id: "mf-1" }],
    ]);
    const s = new RegistryImportService(db);
    const r = await s.importGloberent({ contracts: [base] });
    assert.equal(r.contracts.skipped, 1);
    assert.equal(r.contracts.updated, 0);
    // Единственный update — привязка прихода, самой карточки он не касается.
    assert.equal(updated.length, 1);
    assert.equal((updated[0].set as { contractId?: unknown }).contractId, "c-hand");
  });

  it("устаревшая своя карточка удаляется, если с ней не работали", async () => {
    const mine = [
      { id: "c-mine", no: "GFH-04/0126" },
      { id: "c-junk", no: "1" }, // прошлая версия разбора — в наборе больше нет
    ];
    const { db, deletes, updated } = stubDb(
      [...SELECTS(mine, mine), [{ n: 0 }], [{ n: 0 }]],
      [[], [{ id: "mf-1" }], []],
    );
    const s = new RegistryImportService(db);
    const r = await s.importGloberent({ contracts: [base], contractsFinal: true });
    assert.equal(r.contracts.deleted, 1);
    assert.equal(deletes.length, 1);
    // Приходы удалённой карточки сначала отвязываются, иначе FK не пустит.
    assert.ok(updated.some((u) => (u.set as { contractId?: unknown }).contractId === null));
  });

  it("приход, занятый мусорной карточкой, переезжает на живой договор тем же прогоном", async () => {
    const mine = [
      { id: "c-mine", no: "GFH-04/0126" },
      { id: "c-junk", no: "1" }, // держит на себе приход прошлого разбора
    ];
    // Порядок update-ов и есть предмет проверки: отвязка приходов мусорной
    // карточки, затем сама карточка договора, затем привязка приходов к нему.
    // Освободившийся приход отдаёт последний update — значит уборка прошла
    // раньше и приход успел переехать, а не остался ничей до следующего раза.
    const { db, updated } = stubDb(
      [...SELECTS(mine, mine), [{ n: 0 }], [{ n: 0 }]],
      [[], [], [{ id: "mf-1" }]],
    );
    const s = new RegistryImportService(db);
    const r = await s.importGloberent({ contracts: [base], contractsFinal: true });
    assert.equal(r.contracts.deleted, 1);
    assert.equal(r.contracts.flowsLinked, 1);
    assert.equal((updated[0].set as { contractId?: unknown }).contractId, null);
    assert.equal((updated[2].set as { contractId?: unknown }).contractId, "c-mine");
  });

  it("устаревшая карточка с актами остаётся жить и говорит об этом словами", async () => {
    const mine = [
      { id: "c-mine", no: "GFH-04/0126" },
      { id: "c-used", no: "СТАРЫЙ-1/24" },
    ];
    const { db, deletes } = stubDb(
      [...SELECTS(mine, mine), [{ n: 2 }], [{ n: 0 }]],
      [[], [{ id: "mf-1" }]],
    );
    const s = new RegistryImportService(db);
    const r = await s.importGloberent({ contracts: [base], contractsFinal: true });
    assert.equal(r.contracts.deleted, 0);
    assert.equal(deletes.length, 0);
    assert.match(r.contracts.errors[0], /с ней работали/);
  });

  it("без contractsFinal ничего не удаляется — партия не весь набор", async () => {
    const mine = [
      { id: "c-mine", no: "GFH-04/0126" },
      { id: "c-junk", no: "1" },
    ];
    const { db, deletes } = stubDb(SELECTS(mine, mine), [[], [{ id: "mf-1" }]]);
    const s = new RegistryImportService(db);
    const r = await s.importGloberent({ contracts: [base] });
    assert.equal(r.contracts.deleted, 0);
    assert.equal(deletes.length, 0);
  });

  it("кривой договор падает в errors словами, остальные создаются", async () => {
    const { db } = stubDb(SELECTS([], []));
    const s = new RegistryImportService(db);
    const r = await s.importGloberent({
      contracts: [base, { ...base, contractNo: "X-1/24", contractDate: "28.01.2026" }],
    });
    assert.equal(r.contracts.created, 1);
    assert.equal(r.contracts.errors.length, 1);
    assert.match(r.contracts.errors[0], /ГГГГ-ММ-ДД/);
  });
});

describe("чистые правила импорта", () => {
  it("contractImportError: номер, дата, покупатель и сумма обязательны", () => {
    const ok: ImportContract = {
      contractNo: "GFH-1/24",
      contractDate: "2024-01-01",
      buyerName: "OQ SUV",
      totalWithVat: 1,
    };
    assert.equal(contractImportError(ok), null);
    assert.match(contractImportError({ ...ok, contractNo: " " }) ?? "", /без номера/);
    assert.match(contractImportError({ ...ok, totalWithVat: 0 }) ?? "", /больше нуля/);
    assert.match(contractImportError({ ...ok, status: "draft" as never }) ?? "", /статус импорта/);
  });

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
