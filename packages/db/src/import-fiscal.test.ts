import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { productIndex } from "@mydon/shared";
import { разобратьАргументы } from "./backfill-product-ids";
import { entity, vendingAlias, vendingProduct } from "./schema";
import {
  formatFiscalReport,
  importFiscal,
  ImportFiscalWriteFailure,
  planFiscalImport,
  планВОтчёт,
  type DonorFiscalProductRow,
  type DonorIkpuDictRow,
} from "./import-fiscal";

const products = [
  { id: "p1", name: "Snickers 50gr" },
  { id: "p2", name: "Lit Energy Blueberry CAN 0,45" },
];
const index = productIndex(products, []);

const СПРАВОЧНИК: DonorIkpuDictRow[] = [
  { code: "02202002001000000", name: "Газнапитки (категория)" },
  { code: "01806001001086002", name: "Сникерс 50гр" },
];

function базовыйВвод(over: Partial<Parameters<typeof planFiscalImport>[0]> = {}) {
  return {
    priceCards: [{ id: "p1", canon: "Snickers 50gr", ikpu: null, barcode: null, marked: false }],
    registryCards: [],
    donorProducts: [] as DonorFiscalProductRow[],
    donorIkpuDict: СПРАВОЧНИК,
    priceIndex: index,
    ...over,
  };
}

describe("Перенос фискального блока: приоритет источников (R-P6-2/R-P6-14)", () => {
  it("ИКПУ из entity.attrs побеждает и донор не спрашивается", () => {
    const план = planFiscalImport(
      базовыйВвод({
        registryCards: [{ name: "Snickers 50gr", attrs: { ИКПУ: "01806001001086002" } }],
        donorProducts: [
          {
            id: 1,
            name: "Snickers 50gr",
            ourvend_name: null,
            ikpu_code: "09999999999999999",
            barcode: null,
            is_marked: false,
          },
        ],
      }),
    );
    assert.deepEqual(план.ikpu, [
      {
        productId: "p1",
        raw: "Snickers 50gr",
        canon: "Snickers 50gr",
        value: "01806001001086002",
        source: "entity",
      },
    ]);
  });

  it("нашего значения нет — донорский SKU-код пишется", () => {
    const план = planFiscalImport(
      базовыйВвод({
        donorProducts: [
          {
            id: 1,
            name: "Snickers 50gr",
            ourvend_name: null,
            ikpu_code: "01806001001086002",
            barcode: null,
            is_marked: false,
          },
        ],
      }),
    );
    assert.deepEqual(план.ikpu, [
      {
        productId: "p1",
        raw: "Snickers 50gr",
        canon: "Snickers 50gr",
        value: "01806001001086002",
        source: "donor",
      },
    ]);
  });

  it("категорийный код донора остаётся в отчёте", () => {
    const план = planFiscalImport(
      базовыйВвод({
        donorProducts: [
          {
            id: 1,
            name: "Snickers 50gr",
            ourvend_name: null,
            ikpu_code: "02202002001000000",
            barcode: null,
            is_marked: false,
          },
        ],
      }),
    );
    assert.equal(план.ikpu.length, 0);
    assert.deepEqual(план.skipped, [
      {
        field: "ikpu",
        raw: "Snickers 50gr",
        reason: "category",
        detail: "Газнапитки (категория)",
      },
    ]);
  });

  it("неизвестный справочнику код не пишется", () => {
    const план = planFiscalImport(
      базовыйВвод({
        donorProducts: [
          {
            id: 1,
            name: "Snickers 50gr",
            ourvend_name: null,
            ikpu_code: "00000000000000001",
            barcode: null,
            is_marked: false,
          },
        ],
      }),
    );
    assert.equal(план.ikpu.length, 0);
    assert.equal(план.skipped[0].reason, "unknown_ikpu");
  });

  it("непустое наше значение не затирается", () => {
    const план = planFiscalImport({
      ...базовыйВвод(),
      priceCards: [
        { id: "p1", canon: "Snickers 50gr", ikpu: "01806001001086002", barcode: null, marked: false },
      ],
      donorProducts: [
        {
          id: 1,
          name: "Snickers 50gr",
          ourvend_name: null,
          ikpu_code: "01806001001086003",
          barcode: null,
          is_marked: false,
        },
      ],
    });
    assert.equal(план.ikpu.length, 0);
    assert.equal(план.skipped[0].reason, "conflict");
    assert.match(план.skipped[0].detail, /01806001001086002.*01806001001086003/);
  });

  it("16-значный код нашей стороны отбракован до UPDATE", () => {
    const план = planFiscalImport(
      базовыйВвод({
        registryCards: [{ name: "Snickers 50gr", attrs: { ИКПУ: "2202002001010032" } }],
      }),
    );
    assert.equal(план.ikpu.length, 0);
    assert.equal(план.skipped[0].reason, "length_defect");
  });

  it("штрихкод берётся только из entity.attrs и проверяется", () => {
    const годный = planFiscalImport(
      базовыйВвод({
        registryCards: [{ name: "Snickers 50gr", attrs: { штрихкод: "4870204391234" } }],
      }),
    );
    assert.deepEqual(годный.barcode, [
      {
        productId: "p1",
        raw: "Snickers 50gr",
        canon: "Snickers 50gr",
        value: "4870204391234",
        source: "entity",
      },
    ]);
    const кривой = planFiscalImport(
      базовыйВвод({ registryCards: [{ name: "Snickers 50gr", attrs: { штрихкод: "12345" } }] }),
    );
    assert.equal(кривой.skipped[0].reason, "length_defect");
  });

  it("marked только поднимается false → true", () => {
    const вниз = planFiscalImport(
      базовыйВвод({
        priceCards: [{ id: "p1", canon: "Snickers 50gr", ikpu: null, barcode: null, marked: true }],
        donorProducts: [
          { id: 1, name: "Snickers 50gr", ourvend_name: null, ikpu_code: null, barcode: null, is_marked: false },
        ],
      }),
    );
    assert.equal(вниз.marked.length, 0);

    const вверх = planFiscalImport(
      базовыйВвод({
        donorProducts: [
          { id: 1, name: "Snickers 50gr", ourvend_name: null, ikpu_code: null, barcode: null, is_marked: true },
        ],
      }),
    );
    assert.deepEqual(вверх.marked, [{ productId: "p1", raw: "Snickers 50gr", canon: "Snickers 50gr" }]);
  });

  it("attrs['упаковка'] в package_code не попадает", () => {
    const план = planFiscalImport(
      базовыйВвод({ registryCards: [{ name: "Snickers 50gr", attrs: { упаковка: "1218841" } }] }),
    );
    assert.ok(!("packageCode" in план));
  });

  it("спор имени уходит в unresolvedDonorNames", () => {
    const спорныйИндекс = productIndex(products, [{ productId: "p2", alias: "Snickers 50gr" }]);
    const план = planFiscalImport({
      ...базовыйВвод(),
      priceIndex: спорныйИндекс,
      donorProducts: [
        {
          id: 1,
          name: "Snickers 50gr",
          ourvend_name: null,
          ikpu_code: "01806001001086002",
          barcode: null,
          is_marked: false,
        },
      ],
    });
    assert.deepEqual(план.unresolvedDonorNames, ["Snickers 50gr"]);
  });

  it("расхождение block_size только печатается", () => {
    const план = planFiscalImport(
      базовыйВвод({
        priceCards: [
          { id: "p1", canon: "Snickers 50gr", ikpu: null, barcode: null, marked: false, packSize: 10 },
        ],
        donorProducts: [
          {
            id: 1,
            name: "Snickers 50gr",
            ourvend_name: null,
            ikpu_code: null,
            barcode: null,
            is_marked: false,
            block_size: 5,
          },
        ],
      }),
    );
    assert.deepEqual(план.packSizeMismatches, [{ product: "Snickers 50gr", ours: 10, donor: 5 }]);
  });
});

describe("Отчёт и флаги переноса", () => {
  it("примерка разделяет план и факт и сохраняет сырой алиас в карте решения", () => {
    const rawIndex = productIndex(products, [{ productId: "p1", alias: "Snickers" }]);
    const plan = planFiscalImport({
      ...базовыйВвод(),
      priceIndex: rawIndex,
      donorProducts: [
        {
          id: 1,
          name: "Snickers",
          ourvend_name: null,
          ikpu_code: "01806001001086002",
          barcode: null,
          is_marked: false,
        },
      ],
    });
    const report = планВОтчёт(plan, false, { ikpu: [], barcode: [], marked: [] });
    assert.deepEqual(report.ikpu.planned, [
      { raw: "Snickers", canon: "Snickers 50gr", value: "01806001001086002" },
    ]);
    assert.equal(report.ikpu.written.length, 0);

    const output = formatFiscalReport(report);
    assert.match(output.split("\n")[0], /ПРИМЕРКА/);
    assert.match(output, /поле\s+к записи\s+записано\s+пропущено/);
    assert.match(output, /Snickers → Snickers 50gr → 01806001001086002/);
    assert.match(output.split("\n").at(-1) ?? "", /^ИТОГИ\(json\): .*"ikpu":1/);
  });

  it("карта решения печатает не больше 50 строк, не обрезая сам план", () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      productId: `p${i}`,
      raw: `сырой ${i}`,
      canon: `канон ${i}`,
      value: `0180600100108${String(i).padStart(4, "0")}`,
      source: "donor" as const,
    }));
    const report = планВОтчёт(
      {
        ikpu: rows,
        barcode: [],
        marked: [],
        skipped: [],
        packSizeMismatches: [],
        unresolvedDonorNames: [],
      },
      false,
      { ikpu: [], barcode: [], marked: [] },
    );
    assert.equal(report.ikpu.planned.length, 60);
    const output = formatFiscalReport(report);
    assert.equal(output.split("\n").filter((line) => line.includes(" → ")).length, 50);
    assert.match(output, /… и ещё 10/);
  });

  it("пустой повторный план даёт нули", () => {
    const report = планВОтчёт(
      { ikpu: [], barcode: [], marked: [], skipped: [], packSizeMismatches: [], unresolvedDonorNames: [] },
      true,
      { ikpu: [], barcode: [], marked: [] },
    );
    assert.deepEqual(
      {
        ikpu: report.ikpu.written.length,
        barcode: report.barcode.written.length,
        marked: report.marked.written.length,
      },
      { ikpu: 0, barcode: 0, marked: 0 },
    );
  });

  it("--apply и --dry-run вместе — отказ", () => {
    assert.equal(разобратьАргументы(["--apply", "--dry-run"]).ok, false);
  });

  it("опечатка в флаге — отказ", () => {
    assert.equal(разобратьАргументы(["--dryrun"]).ok, false);
  });

  it("чужой parser без флагов пишет; import-fiscal инвертирует это в main", () => {
    const parsed = разобратьАргументы([]);
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.dryRun, false);
  });
});

describe("Запись переноса: dry-run и повтор", () => {
  function стенд(failTransaction = false) {
    let currentIkpu: string | null = null;
    let transactions = 0;
    const priceRow = () => ({
      id: "p1",
      name: "Snickers 50gr",
      ikpu: currentIkpu,
      barcode: null,
      marked: false,
      packSize: 10,
    });
    const db = {
      select: () => ({
        from: (table: unknown) => {
          if (table === vendingProduct) return Promise.resolve([priceRow()]);
          if (table === vendingAlias) return Promise.resolve([]);
          if (table === entity) return { where: async () => [] };
          throw new Error("неизвестная таблица в стенде");
        },
      }),
      transaction: async (fn: (tx: unknown) => Promise<void>) => {
        transactions += 1;
        if (failTransaction) throw new Error("smoke transaction failed");
        const tx = {
          update: () => ({
            set: (patch: { ikpu?: string }) => ({
              where: () => ({
                returning: async () => {
                  if (patch.ikpu === undefined || currentIkpu !== null) return [];
                  currentIkpu = patch.ikpu;
                  return [{ id: "p1" }];
                },
              }),
            }),
          }),
        };
        await fn(tx);
      },
    } as never;
    const donor = {
      products: async () => [
        {
          id: 1,
          name: "Snickers 50gr",
          ourvend_name: null,
          ikpu_code: "01806001001086002",
          barcode: null,
          is_marked: false,
        },
      ],
      ikpuDict: async () => [{ code: "01806001001086002", name: "Сникерс 50гр" }],
    };
    return { db, donor, transactions: () => transactions };
  }

  it("--dry-run строит план и не открывает транзакцию", async () => {
    const s = стенд();
    const report = await importFiscal(s.db, s.donor, { apply: false });
    assert.equal(report.ikpu.planned.length, 1);
    assert.equal(report.ikpu.written.length, 0);
    assert.equal(s.transactions(), 0);
  });

  it("первый --apply пишет, повторный даёт ноль", async () => {
    const s = стенд();
    const first = await importFiscal(s.db, s.donor, { apply: true });
    const second = await importFiscal(s.db, s.donor, { apply: true });
    assert.equal(first.ikpu.written.length, 1);
    assert.equal(second.ikpu.written.length, 0);
    assert.equal(s.transactions(), 2);
  });

  it("ошибка транзакции несёт план, но не врёт о фактически записанном", async () => {
    const s = стенд(true);
    await assert.rejects(
      importFiscal(s.db, s.donor, { apply: true }),
      (error: unknown) => {
        assert.ok(error instanceof ImportFiscalWriteFailure);
        assert.equal(error.report.ikpu.planned.length, 1);
        assert.equal(error.report.ikpu.written.length, 0);
        return true;
      },
    );
  });
});
