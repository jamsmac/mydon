import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  approval,
  auditLog,
  entity,
  event,
  machineCard,
  machineSale,
  person,
  productSale,
  purchase,
  sale,
  systemConfig,
  vendingAlias,
  vendingProduct,
  vendingStock,
  vendingStockCount,
} from "@mydon/db";
import { tashkentDay, TZ } from "@mydon/shared";
import {
  INSERT_CHUNK,
  MAX_POSITION_PRICE,
  MAX_SLOTS_PER_MACHINE,
  parseOrderPositions,
  STOCK_COUNTS_DAYS_DEFAULT,
  STOCK_COUNTS_DAYS_MAX,
  STOCK_COUNTS_MAX,
  VendingService,
} from "./vending.service";

type Row = { machineSerial: string; coilId: string; productName: string | null; capacity: number; quantity: number };
type SaleRow = { machineSerial: string; productName: string; quantity: number; capturedAt: Date };
type ProdRow = {
  id?: string;
  name: string;
  purchasePrice: string | null;
  packSize: number;
  excludedFromPurchase?: boolean;
  fixedPurchaseQty?: number | null;
  /** Эталон витрины (П5b): `null` — не задан, строка numeric — задан. */
  salePrice?: string | null;
  /** Снят с продажи (П5b). В базе колонка NOT NULL — стаб П5b подставляет `true`. */
  isActive?: boolean;
};
type AliasRow = { productId: string; alias: string };
/** Карточка реестра автомата и её состояние — фильтр «в строю» у плана, прогноза и сводки. */
type EntRow = { id: string; name: string; externalRef: string | null; type: string };
type CardRow = { entityId: string; status: string };

/**
 * Таблицы реестра автоматов и настроек: их читает `purchase()` (фильтр «в строю»
 * и маршрут). Стабы обязаны отдавать по ним ПУСТО, иначе строки слотов
 * притворятся карточками автоматов. Пустой реестр = автомат без карточки =
 * в строю, поэтому старые ожидания не меняются.
 */
const РЕЕСТР: unknown[] = [entity, machineCard, systemConfig, approval];

/**
 * Строки таблицы в стабе: и `await select().from(t)`, и
 * `select().from(t).where(...)` отдают одно и то же.
 *
 * `.where()` обязателен: `machineRegistry()` фильтрует `entity.type = machine`
 * в запросе (индекс `entity_org_type_idx`), а `submitPurchase()` спрашивает
 * нерешённые заявки закупа — оба ходят через where.
 */
function таблица(rows: unknown[]) {
  const p = Promise.resolve(rows);
  return { where: async () => rows, then: p.then.bind(p) };
}

/**
 * Стаб БД: machines()/deficitSummary() читают `select().from()`. `deficitSummary()`
 * тоже резолвит алиасы (loadProductIndex()) — по умолчанию пустые, отдельные тесты
 * передают их явно.
 */
function readDb(
  rows: Row[],
  aliases: AliasRow[] = [],
  products: ProdRow[] = [],
  /** Реестр автоматов: пустой — все в строю (DEFAULT_MACHINE_STATUS). */
  entities: EntRow[] = [],
  cards: CardRow[] = [],
) {
  return {
    select: () => ({
      from: (t: unknown) =>
        таблица(
          t === vendingAlias
            ? aliases
            : t === vendingProduct
              ? products
              : t === entity
                ? entities
                : t === machineCard
                  ? cards
                  : РЕЕСТР.includes(t)
                    ? []
                    : rows,
        ),
    }),
  } as never;
}

/** Стаб БД для прогноза: слоты, продажи, алиасы — различаем по ссылке. */
function forecastDb(
  slots: Row[],
  sales: SaleRow[],
  aliases: AliasRow[] = [],
  products: ProdRow[] = [],
  entities: EntRow[] = [],
  cards: CardRow[] = [],
) {
  return {
    select: () => ({
      from: (t: unknown) =>
        таблица(
          t === productSale
            ? sales
            : t === vendingAlias
              ? aliases
              : t === vendingProduct
                ? products
                : t === entity
                  ? entities
                  : t === machineCard
                    ? cards
                    : РЕЕСТР.includes(t)
                      ? []
                      : slots,
        ),
    }),
  } as never;
}

type StockRow = { productName: string; quantity: number; countedAt: Date };

/** Стаб БД для закупа: слоты + продажи + прайс + склад + алиасы, различаем по ссылке. */
function purchaseDb(
  slots: Row[],
  sales: SaleRow[],
  products: ProdRow[],
  stock: StockRow[] = [],
  aliases: AliasRow[] = [],
  /** Нерешённые заявки — гейт двойной отправки закупа; по умолчанию пусто. */
  approvals: unknown[] = [],
) {
  return {
    select: () => ({
      from: (t: unknown) =>
        таблица(
          t === productSale
            ? sales
            : t === vendingProduct
              ? products
              : t === vendingStock
                ? stock
                : t === vendingAlias
                  ? aliases
                  : t === approval
                    ? approvals
                    : РЕЕСТР.includes(t)
                      ? []
                      : slots,
        ),
    }),
  } as never;
}

/**
 * Стаб БД для ingest: копит вставки. `aliases`/`products` кормят
 * loadProductIndex() (вне транзакции); `stockRows` — предзагрузку остатка ДО
 * пересчёта внутри транзакции (единственный select там — фильтр по имени
 * стабу не нужен, ingestStock сам сверяет by-name из полного среза).
 */
function writeDb(
  aliases: unknown[] = [],
  products: unknown[] = [],
  stockRows: unknown[] = [],
  /** Карточки автоматов реестра — для привязки слотов к entity. */
  machineCards: { id: string; externalRef: string | null; type?: string }[] = [],
  /** Справочник сотрудников: `person_id` пересчёта — внешний ключ на него. */
  people: { id: string }[] = [],
) {
  const inserts: { table: string; values: unknown }[] = [];
  // Реальные строки vending_stock всегда имеют countedAt (NOT NULL) — большинство
  // тестов его не задают, раз речь не про порядок во времени; эпоха 0 заведомо
  // «старее» любого countedAt в тестах, так что обычные сценарии недостачи/
  // излишка ведут себя как раньше без правки каждого литерала.
  const stockRowsWithCountedAt = stockRows.map((r) => ({ countedAt: new Date(0), ...(r as object) }));
  /** Слоты, убранные как исчезнувшие: возвращаем то, что задали тестом. */
  const pruneRows: { id: string }[] = [];
  /** Ветка конфликта: что именно апсерт пишет поверх существующей строки. */
  const conflicts: { table: string; set: Record<string, unknown> }[] = [];
  /** Ветка «конфликт — молча мимо»: по какому ключу история отбивает повтор. */
  const dedup: { table: string; target: unknown; where: unknown }[] = [];
  /** Заставить уборку упасть — проверяем, что снимок при этом уцелел. */
  let pruneFails = false;
  const failPrune = () => {
    pruneFails = true;
  };
  const tx = {
    select: () => ({ from: async () => stockRowsWithCountedAt }),
    delete: () => ({
      where: () => ({
        returning: async () => {
          if (pruneFails) throw new Error("уборка не удалась (тест)");
          return pruneRows.splice(0, pruneRows.length);
        },
      }),
    }),
    insert: (table: { [Symbol.toStringTag]?: string }) => ({
      values: (v: unknown) => {
        const name = tableName(table);
        inserts.push({ table: name, values: v });
        return {
          onConflictDoUpdate: (cfg: { set?: Record<string, unknown> }) => {
            conflicts.push({ table: name, set: cfg.set ?? {} });
            return Promise.resolve();
          },
          onConflictDoNothing: (cfg: { target?: unknown; where?: unknown }) => {
            dedup.push({ table: name, target: cfg.target, where: cfg.where });
            return Promise.resolve();
          },
        };
      },
    }),
  };
  // loadProductIndex() читает vending_alias затем vending_product — различаем по счётчику.
  // Карточки автоматов (entity) читаются с .where() и по счётчику не идут:
  // иначе привязка слотов сдвигала бы очередь алиасов и товаров.
  let call = 0;
  const db = {
    delete: () => ({
      where: () => ({
        returning: async () => {
          if (pruneFails) throw new Error("уборка не удалась (тест)");
          return pruneRows.splice(0, pruneRows.length);
        },
      }),
    }),
    select: () => ({
      from: (t: unknown) => {
        if (t === entity) {
          // Thenable + .where(): machineIdBySerial() фильтрует по типу.
          const rows = Promise.resolve(machineCards);
          return { where: () => rows, then: rows.then.bind(rows) };
        }
        if (t === person) {
          // `.where(eq(person.id, ?)).limit(1)` — и стаб ОБЯЗАН фильтровать:
          // иначе «чужой uuid гасится в NULL» проверялось бы пустой фикстурой.
          return {
            where: (cond?: unknown) => {
              const искомый = параметрыSQL(cond);
              return { limit: async (n: number) => people.filter((p) => искомый.includes(p.id)).slice(0, n) };
            },
          };
        }
        const rows = Promise.resolve(call++ === 0 ? aliases : products);
        return { where: () => rows, then: rows.then.bind(rows) };
      },
    }),
    insert: (table: { [Symbol.toStringTag]?: string }) => ({
      values: (v: unknown) => {
        inserts.push({ table: tableName(table), values: v });
        return Promise.resolve();
      },
    }),
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
  } as never;
  return { db, inserts, conflicts, dedup, pruneRows, failPrune };
}
/**
 * Текст SQL-фрагмента drizzle, РЕКУРСИВНО по вложенным фрагментам.
 *
 * Заглушка запросов не ИСПОЛНЯЕТ, поэтому семантику «не затирать непустую
 * ссылку» здесь можно проверить только по тексту выражения; что оно
 * действительно так работает в Postgres, проверяет дымовой прогон
 * (`tools/smoke-core.mjs`, сценарий повторного приёма слотов и склада).
 *
 * Рекурсия нужна условиям: `and(eq(id, ?), isNull(sale_price))` — это фрагмент
 * ИЗ фрагментов, и без спуска внутрь `is null` в тексте не появился бы вовсе.
 */
function текстSQL(x: unknown): string {
  const chunks = (x as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((c) => {
      const v = (c as { value?: unknown }).value;
      if (Array.isArray(v)) return v.join("");
      const name = (c as { name?: unknown }).name;
      if (typeof name === "string") return name;
      return текстSQL(c);
    })
    .join("");
}

/**
 * Строки, которые ушли в таблицу. Приём пишет ПАЧКОЙ (один `values([...])` на
 * автомат), поэтому `values` — массив, а не одна строка; хелпер разворачивает
 * и то и другое, чтобы проверки говорили о СТРОКАХ, а не о числе запросов.
 */
function строкиТаблицы(inserts: { table: string; values: unknown }[], table: string): Record<string, unknown>[] {
  return строкиВставок(inserts.filter((i) => i.table === table));
}

/** То же, но по всем таблицам сразу: у стаба имя таблицы — эвристика. */
function строкиВставок(inserts: { table: string; values: unknown }[]): Record<string, unknown>[] {
  return inserts.flatMap((i) => (Array.isArray(i.values) ? i.values : [i.values]) as Record<string, unknown>[]);
}

function tableName(t: unknown): string {
  // Журнал событий узнаём по личности: эвристика по ключам его не различает.
  if (t === event) return "event";
  // Склад и его история отличаются друг от друга только набором колонок, и
  // эвристика ниже свела бы обе к «machine_slot»: проверка «строка истории на
  // каждую применённую позицию» тогда считала бы вперемешку остаток и историю.
  if (t === vendingStock) return "vending_stock";
  if (t === vendingStockCount) return "vending_stock_count";
  // drizzle-таблица знает своё имя; для стаба достаточно эвристики по ключам.
  const keys = Object.keys((t ?? {}) as Record<string, unknown>);
  return keys.includes("capturedAt") && !keys.includes("syncedAt") ? "slot_snapshot" : "machine_slot";
}

/**
 * Стаб БД для ingestSales: копит вызовы insert(...).onConflictDoUpdate(...).
 * Реальный unique-индекс (миграция 0024) эти тесты не проверяют — только то,
 * что код идёт через upsert с правильным target, а не голый insert
 * (проверка самого constraint — вне мокового unit-теста, найдено внешним
 * аудитом п.13: нет реальных DB-тестов на конкурентность/ограничения).
 *
 * `values` — массив строк: приём пишет пачкой, один запрос на таблицу.
 */
function ingestSalesDb(machineCards: { id: string; externalRef: string | null; type?: string }[] = []) {
  const calls: {
    table: "product_sale" | "machine_sale";
    values: Record<string, unknown> | Record<string, unknown>[];
    target: unknown[];
    set: Record<string, unknown>;
  }[] = [];
  const tx = {
    insert: (table: unknown) => ({
      values: (v: Record<string, unknown> | Record<string, unknown>[]) => ({
        onConflictDoUpdate: (opts: { target: unknown[]; set: Record<string, unknown> }) => {
          calls.push({
            table: table === productSale ? "product_sale" : "machine_sale",
            values: v,
            target: opts.target,
            set: opts.set,
          });
          return Promise.resolve(undefined);
        },
      }),
    }),
  };
  // Приём продаж теперь читает карточки автоматов, чтобы проставить
  // machine_id: без этого продажи Ourvend знали только серийник.
  const db = {
    select: () => ({
      from: () => {
        const rows = Promise.resolve(machineCards);
        return { where: () => rows, then: rows.then.bind(rows) };
      },
    }),
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
  } as never;
  return { db, calls };
}

const slot = (machineSerial: string, coilId: string, productName: string | null, capacity: number, quantity: number): Row => ({
  machineSerial,
  coilId,
  productName,
  capacity,
  quantity,
});

describe("Вендинг Core: дефицит по автоматам (Фаза 1c)", () => {
  it("считает дефицит/заполненность, статус, сортировку", async () => {
    const rows = [
      // AH: два валидных слота — дефицит (6-0)+(6-1)=11
      slot("AH", "31", "Montella", 6, 0),
      slot("AH", "34", "CocaCola", 6, 1),
      // NOSLOT: слоты без товара → no_slots, в конце
      slot("NOSLOT", "1", null, 6, 0),
    ];
    const svc = new VendingService(readDb(rows));
    const machines = await svc.machines();
    const ah = machines.find((m) => m.serial === "AH")!;
    assert.equal(ah.status, "ok");
    assert.equal(ah.deficit, 11);
    assert.equal(ah.capacity, 12);
    assert.equal(ah.fillRate, 8); // round(1/12*100)
    // no_slots-автомат уходит в конец.
    assert.equal(machines[machines.length - 1].serial, "NOSLOT");
    assert.equal(machines[machines.length - 1].status, "no_slots");
  });

  it("сводная потребность по товарам — только ok, с разбивкой", async () => {
    const rows = [
      slot("AH", "31", "Montella", 6, 0), // деф 6
      slot("Olma", "40", "Montella", 6, 3), // деф 3
      slot("Olma", "41", "Fanta", 6, 6), // деф 0 — не в сводке
    ];
    const svc = new VendingService(readDb(rows));
    const summary = await svc.deficitSummary();
    const m = summary.find((s) => s.product === "Montella")!;
    assert.equal(m.total, 9);
    assert.deepEqual(m.perMachine, { AH: 6, Olma: 3 });
    assert.ok(!summary.some((s) => s.product === "Fanta"), "нулевой дефицит не попадает в сводку");
  });

  it("два сырых имени одного канона — одна строка сводки, а не две (item 38)", async () => {
    const rows = [
      slot("AH", "31", "Montella", 6, 0), // деф 6
      slot("Olma", "40", "18+", 6, 3), // деф 3, другое сырое имя того же товара
    ];
    const aliases: AliasRow[] = [
      { productId: "p1", alias: "Montella" },
      { productId: "p1", alias: "18+" },
    ];
    const products: ProdRow[] = [{ id: "p1", name: "Montella Вода минеральная 330ml", purchasePrice: null, packSize: 1 }];
    const svc = new VendingService(readDb(rows, aliases, products));
    const summary = await svc.deficitSummary();
    assert.equal(summary.filter((s) => s.product.startsWith("Montella") || s.product === "18+").length, 1);
    const m = summary.find((s) => s.product === "Montella Вода минеральная 330ml")!;
    assert.equal(m.total, 9);
    assert.deepEqual(m.perMachine, { AH: 6, Olma: 3 });
  });

  it("автомат не в строю: в списке остаётся с inService:false, но из сводной потребности выпадает (П5b-3)", async () => {
    // Список автоматов — зеркало сбора: пропавшая строка читалась бы как «сбор
    // его потерял». А вот его дефицит никуда не едет, и в сводке потребности
    // ему делать нечего — закуп и план его уже не видят.
    const rows = [slot("AH", "31", "Montella", 6, 0), slot("SKLAD", "1", "Montella", 6, 0)];
    const entities: EntRow[] = [
      { id: "m-ah", name: "American Hospital", externalRef: "AH", type: "machine" },
      { id: "m-sk", name: "SKLAD 5S", externalRef: "SKLAD", type: "machine" },
    ];
    const cards: CardRow[] = [
      { entityId: "m-ah", status: "in_service" },
      { entityId: "m-sk", status: "warehouse" },
    ];
    const svc = new VendingService(readDb(rows, [], [], entities, cards));

    const machines = await svc.machines();
    assert.equal(machines.find((m) => m.serial === "SKLAD")!.inService, false);
    assert.equal(machines.find((m) => m.serial === "AH")!.inService, true);

    const summary = await svc.deficitSummary();
    assert.deepEqual(summary.find((s) => s.product === "Montella")!.perMachine, { AH: 6 });
  });

  it("реестра нет вовсе — все автоматы в строю (DEFAULT_MACHINE_STATUS)", async () => {
    const machines = await new VendingService(readDb([slot("AH", "31", "Montella", 6, 0)])).machines();
    assert.equal(machines[0]!.inService, true);
  });
});

describe("Вендинг Core: прогноз расхода (§5.6)", () => {
  it("daysLeft = остаток / (продажи7/7), только ok-автоматы, свежий батч продаж", async () => {
    const t1 = new Date("2026-07-30T00:00:00Z"); // старый батч — игнор
    const t2 = new Date("2026-08-02T00:00:00Z"); // свежий
    const slots: Row[] = [
      // AH ok: Montella остаток 2 (валиден), Fanta остаток 6 (продаж нет)
      { machineSerial: "AH", coilId: "31", productName: "Montella", capacity: 6, quantity: 2 },
      { machineSerial: "AH", coilId: "32", productName: "Fanta", capacity: 6, quantity: 6 },
      // NOSLOT: без назначенных слотов → не ok, его остаток в прогноз не идёт
      { machineSerial: "NOSLOT", coilId: "1", productName: null, capacity: 6, quantity: 0 },
    ];
    const sales: SaleRow[] = [
      { machineSerial: "AH", productName: "Montella", quantity: 999, capturedAt: t1 }, // старый — игнор
      { machineSerial: "AH", productName: "Montella", quantity: 14, capturedAt: t2 }, // sold7=14 → daily=2
    ];
    const svc = new VendingService(forecastDb(slots, sales));
    const { all, critical } = await svc.forecast();

    const montella = all.find((r) => r.product === "Montella")!;
    assert.equal(montella.inMachines, 2);
    assert.equal(montella.daily, 2);
    assert.equal(montella.daysLeft, 1); // 2 / 2
    // Fanta без продаж → хватит «навсегда», не критичен.
    const fanta = all.find((r) => r.product === "Fanta")!;
    assert.equal(fanta.daysLeft, Infinity);
    // Критичны только те, чей запас ≤ 3 дней.
    assert.deepEqual(critical.map((r) => r.product), ["Montella"]);
  });

  it("остаток и продажи под разными сырыми именами одного канона сходятся в один прогноз (item 38)", async () => {
    const t2 = new Date("2026-08-02T00:00:00Z");
    const slots: Row[] = [
      { machineSerial: "AH", coilId: "31", productName: "Montella", capacity: 6, quantity: 2 },
      { machineSerial: "Olma", coilId: "1", productName: "18+", capacity: 6, quantity: 3 },
    ];
    const sales: SaleRow[] = [
      { machineSerial: "AH", productName: "Montella", quantity: 7, capturedAt: t2 },
      { machineSerial: "Olma", productName: "18+", quantity: 7, capturedAt: t2 },
    ];
    const aliases: AliasRow[] = [
      { productId: "p1", alias: "Montella" },
      { productId: "p1", alias: "18+" },
    ];
    const products: ProdRow[] = [{ id: "p1", name: "Montella Вода минеральная 330ml", purchasePrice: null, packSize: 1 }];
    const svc = new VendingService(forecastDb(slots, sales, aliases, products));
    const { all } = await svc.forecast();

    const rows = all.filter((r) => r.product === "Montella" || r.product === "18+" || r.product === "Montella Вода минеральная 330ml");
    assert.equal(rows.length, 1, "должна остаться одна строка прогноза под каноном");
    const canon = all.find((r) => r.product === "Montella Вода минеральная 330ml")!;
    assert.equal(canon.inMachines, 5); // 2+3
    assert.equal(canon.daily, 2); // (7+7)/7
  });

  it("автомат не в строю в прогноз не входит: его полные слоты не растягивают запас (П5b-3)", async () => {
    const t = new Date("2026-08-02T00:00:00Z");
    const slots: Row[] = [
      { machineSerial: "AH", coilId: "31", productName: "Montella", capacity: 6, quantity: 2 },
      // Склад-«автомат» с полными слотами: без фильтра остаток был бы 8 и
      // «хватит на 4 дня» вместо честного «на 1 день».
      { machineSerial: "SKLAD", coilId: "1", productName: "Montella", capacity: 6, quantity: 6 },
    ];
    const sales: SaleRow[] = [{ machineSerial: "AH", productName: "Montella", quantity: 14, capturedAt: t }];
    const entities: EntRow[] = [
      { id: "m-ah", name: "American Hospital", externalRef: "AH", type: "machine" },
      { id: "m-sk", name: "SKLAD 5S", externalRef: "SKLAD", type: "machine" },
    ];
    const cards: CardRow[] = [{ entityId: "m-sk", status: "warehouse" }];
    const { all } = await new VendingService(forecastDb(slots, sales, [], [], entities, cards)).forecast();
    const montella = all.find((r) => r.product === "Montella")!;
    assert.equal(montella.inMachines, 2);
    assert.equal(montella.daysLeft, 1);
  });
});

describe("Вендинг Core: приём продаж — идемпотентность батча (§5.6)", () => {
  const payload = {
    capturedAt: "2026-08-02T00:00:00Z",
    periodStart: "2026-07-26T00:00:00Z",
    periodEnd: "2026-08-02T00:00:00Z",
    productSales: [{ serial: "AH", product: "Montella", quantity: 5 }],
    machineSales: [{ serial: "AH", totalAmount: 12345.6, totalCount: 7 }],
  };

  it("продажи по товарам и по автоматам идут через upsert, не голый insert", async () => {
    const { db, calls } = ingestSalesDb();
    const res = await new VendingService(db).ingestSales(payload);

    assert.equal(res.productRows, 1);
    assert.equal(res.machineRows, 1);
    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.find((c) => c.table === "product_sale")!.target,
      [productSale.machineSerial, productSale.productName, productSale.capturedAt],
    );
    assert.deepEqual(
      calls.find((c) => c.table === "machine_sale")!.target,
      [machineSale.machineSerial, machineSale.capturedAt],
    );
  });

  it("повторная доставка того же батча (тот же capturedAt/автомат/товар) конфликтует по ключу идемпотентности, а не создаёт вторую строку (найдено внешним аудитом, P1)", async () => {
    const { db, calls } = ingestSalesDb();
    const svc = new VendingService(db);
    await svc.ingestSales(payload);
    await svc.ingestSales(payload); // ретрай того же батча — сеть оборвалась после первой доставки

    const productCalls = calls.filter((c) => c.table === "product_sale");
    assert.equal(productCalls.length, 2); // оба раза — insert...onConflictDoUpdate с одним и тем же target
    assert.deepEqual(productCalls[0]!.target, productCalls[1]!.target);
    assert.deepEqual(productCalls[0]!.values, productCalls[1]!.values);
  });
});

describe("Вендинг Core: сводный закуп (§5.4–5.5)", () => {
  const t = new Date("2026-08-02T00:00:00Z");
  // Один ok-автомат: Montella нужна 4 (есть цена+продажи), Dead нужна 2 (цена
  // есть, продаж нет → «не закупать»), NoPrice нужна 3 (нет цены → на разбор).
  const slots: Row[] = [
    { machineSerial: "AH", coilId: "1", productName: "Montella", capacity: 6, quantity: 2 },
    { machineSerial: "AH", coilId: "2", productName: "Dead", capacity: 5, quantity: 3 },
    { machineSerial: "AH", coilId: "3", productName: "NoPrice", capacity: 6, quantity: 3 },
  ];
  const sales: SaleRow[] = [
    { machineSerial: "AH", productName: "Montella", quantity: 14, capturedAt: t },
    { machineSerial: "AH", productName: "NoPrice", quantity: 5, capturedAt: t }, // продажи есть, цены нет
  ];
  const products: ProdRow[] = [
    { name: "Montella", purchasePrice: "5000.00", packSize: 12 },
    { name: "Dead", purchasePrice: "3000.00", packSize: 10 },
    // NoPrice отсутствует в прайсе намеренно.
  ];

  it("округляет до упаковки, считает обе суммы и переплату по товару с ценой и продажами", async () => {
    const svc = new VendingService(purchaseDb(slots, sales, products));
    const s = await svc.purchase();

    const montella = s.items.find((i) => i.product === "Montella")!;
    assert.equal(montella.buy, 4); // дефицит 6−2, склад 0
    assert.equal(montella.order, 12); // ceil(4/12)*12
    assert.equal(montella.costExact, 20000); // 4×5000
    assert.equal(montella.costRounded, 60000); // 12×5000
    assert.equal(s.overpay, 40000);
  });

  it("товар без продаж выносит в excludedNoSales и не включает в денежные итоги", async () => {
    const svc = new VendingService(purchaseDb(slots, sales, products));
    const s = await svc.purchase();
    assert.deepEqual(s.excludedNoSales.map((i) => i.product), ["Dead"]);
    // В items только Montella (Dead исключён, NoPrice без цены, но продажи?)
    assert.ok(!s.items.some((i) => i.product === "Dead"));
  });

  it("товар без цены помечает noPrice и держит вне денежных итогов, но в items", async () => {
    const svc = new VendingService(purchaseDb(slots, sales, products));
    const s = await svc.purchase();
    assert.ok(s.noPrice.includes("NoPrice"));
    assert.ok(s.items.some((i) => i.product === "NoPrice")); // есть продажи → участвует
    assert.equal(s.costRounded, 60000); // деньги — только Montella
  });

  it("остаток склада вычитается из потребности: buy = need − stock (§5.4)", async () => {
    // Склад Montella 1 → нехватка 4−1=3, но округление до упаковки 12 то же.
    const stock: StockRow[] = [{ productName: "Montella", quantity: 1, countedAt: t }];
    const svc = new VendingService(purchaseDb(slots, sales, products, stock));
    const s = await svc.purchase();
    const montella = s.items.find((i) => i.product === "Montella")!;
    assert.equal(montella.stock, 1);
    assert.equal(montella.covered, 1); // min(1, 4)
    assert.equal(montella.buy, 3); // max(0, 4−1)
    assert.equal(montella.order, 12); // ceil(3/12)*12
    assert.equal(montella.costExact, 15000); // 3×5000
  });

  it("склад покрывает потребность полностью — товар выпадает из закупа (buy=0)", async () => {
    const stock: StockRow[] = [{ productName: "Montella", quantity: 10, countedAt: t }];
    const svc = new VendingService(purchaseDb(slots, sales, products, stock));
    const s = await svc.purchase();
    const montella = s.items.find((i) => i.product === "Montella")!;
    assert.equal(montella.buy, 0);
    assert.equal(montella.order, 0); // buy 0 → заказывать нечего
    assert.equal(montella.surplus, 6); // 10 − 4
    assert.equal(s.costRounded, 0); // единственная денежная позиция закрыта складом
  });

  it(
    "два разных сырых имени слота на один канон — ОДНА позиция закупа с суммарной " +
      "потребностью и разбивкой по автоматам, а не две отдельные строки с раздельным " +
      "дефицитом и продажами (item 38, найдено внешним аудитом)",
    async () => {
      // Один и тот же товар записан в разных автоматах разными Ourvend-именами
      // («Montella» и «18+») — рукописный лист сборщика их не различает.
      const aliasSlots: Row[] = [
        { machineSerial: "AH", coilId: "1", productName: "Montella", capacity: 6, quantity: 2 }, // деф 4
        { machineSerial: "Olma", coilId: "1", productName: "18+", capacity: 6, quantity: 1 }, // деф 5
      ];
      // Продажи собраны Ourvend тоже под сырыми именами — обе должны сойтись на каноне.
      const aliasSales: SaleRow[] = [
        { machineSerial: "AH", productName: "Montella", quantity: 7, capturedAt: t },
        { machineSerial: "Olma", productName: "18+", quantity: 7, capturedAt: t },
      ];
      const aliasProducts: ProdRow[] = [{ id: "p1", name: "Montella Вода минеральная 330ml", purchasePrice: "5000.00", packSize: 12 }];
      const aliases: AliasRow[] = [
        { productId: "p1", alias: "Montella" },
        { productId: "p1", alias: "18+" },
      ];
      // Остаток склада тоже в каноне (как пишет ingestStock) — должен вычесться
      // из ОБЩЕЙ потребности, а не из одной из двух раздельных позиций.
      const stock: StockRow[] = [{ productName: "Montella Вода минеральная 330ml", quantity: 1, countedAt: t }];

      const svc = new VendingService(purchaseDb(aliasSlots, aliasSales, aliasProducts, stock, aliases));
      const s = await svc.purchase();

      const rows = s.items.filter((i) => i.product === "Montella Вода минеральная 330ml");
      assert.equal(rows.length, 1, "должна остаться одна позиция под каноном, а не по одной на сырое имя");
      const item = rows[0]!;
      assert.deepEqual(item.perMachine, { AH: 4, Olma: 5 }); // разбивка по автоматам сохранена
      assert.equal(item.need, 9); // 4+5, а не два раза по 4 и 5 раздельно
      assert.equal(item.stock, 1); // склад найден по канону
      assert.equal(item.buy, 8); // 9−1
      assert.equal(item.noSales, false); // продажи под обоими сырыми именами сошлись на каноне (7+7=14>0)

      assert.ok(!s.items.some((i) => i.product === "Montella" || i.product === "18+"), "сырые имена не должны утекать в items");
    },
  );
});

describe("Вендинг Core: отправка закупа на утверждение (§5.7)", () => {
  const t = new Date("2026-08-02T00:00:00Z");
  const slots: Row[] = [{ machineSerial: "AH", coilId: "1", productName: "Montella", capacity: 6, quantity: 2 }];
  const sales: SaleRow[] = [{ machineSerial: "AH", productName: "Montella", quantity: 14, capturedAt: t }];
  const products: ProdRow[] = [{ name: "Montella", purchasePrice: "5000.00", packSize: 12 }];

  /** Стаб очереди согласований: копит запросы, отдаёт id. */
  function approvalsStub() {
    const requests: { agent: string; action: string; tier: string; payload?: Record<string, unknown> }[] = [];
    const svc = {
      request: async (input: { agent: string; action: string; tier: string; payload?: Record<string, unknown> }) => {
        requests.push(input);
        return { id: `ap-${requests.length}` };
      },
    };
    return { svc, requests };
  }

  it("создаёт заявку со снимком закупа и суммой в действии", async () => {
    const { svc, requests } = approvalsStub();
    const vending = new VendingService(purchaseDb(slots, sales, products), svc);
    const res = await vending.submitPurchase("owner");

    assert.equal(res.submitted, true);
    assert.equal(res.approvalId, "ap-1");
    assert.equal(res.positions, 1);
    assert.equal(res.costRounded, 60000); // order 12 × 5000

    assert.equal(requests.length, 1);
    const r = requests[0]!;
    assert.equal(r.agent, "vending");
    assert.equal(r.tier, "T2");
    // Владелец решает по кнопке в Telegram, где виден только `action`: там
    // обязаны быть и позиции, и ШТУКИ, и сумма (UX#9).
    assert.match(r.action, /Закуп вендинга: 1 поз/);
    assert.match(r.action, /12 ед/);
    assert.match(r.action, /~60\s?000 сум/);
    assert.doesNotMatch(r.action, /нет цены/, "все позиции с ценой — оговорки быть не должно");
    const po = (r.payload as { purchaseOrder: { positions: unknown[]; costRounded: number } }).purchaseOrder;
    assert.equal(po.positions.length, 1);
    assert.equal(po.costRounded, 60000);
  });

  it("нечего заказывать — заявку не создаёт", async () => {
    const { svc, requests } = approvalsStub();
    // Слот заполнен под завязку → дефицита нет.
    const full: Row[] = [{ machineSerial: "AH", coilId: "1", productName: "Montella", capacity: 6, quantity: 6 }];
    const vending = new VendingService(purchaseDb(full, sales, products), svc);
    const res = await vending.submitPurchase("owner");
    assert.equal(res.submitted, false);
    assert.equal(requests.length, 0);
    assert.match(res.reason ?? "", /нечего/i);
  });

  it("без подключённой очереди согласований — явная ошибка", async () => {
    const vending = new VendingService(purchaseDb(slots, sales, products));
    await assert.rejects(() => vending.submitPurchase(), /ApprovalsService не подключён/);
  });

  it("свежая заявка ждёт решения — второй не создаём, в причине дата (UX#15/П5b-4)", async () => {
    // Кнопка в панели и «оформить закуп» в боте отправляют одно и то же:
    // владелец одобрил бы два одинаковых закупа и получил две накладные.
    const { svc, requests } = approvalsStub();
    const вчера = new Date(Date.now() - 86_400_000);
    const висит = [{ payload: { purchaseOrder: { positions: [], costRounded: 1 } }, createdAt: вчера }];
    const vending = new VendingService(purchaseDb(slots, sales, products, [], [], висит), svc);
    const res = await vending.submitPurchase("owner");
    assert.equal(res.submitted, false);
    assert.equal(res.positions, 0);
    assert.equal(res.costRounded, 0);
    assert.match(res.reason ?? "", /уже ждёт решения/);
    // Без даты «уже ждёт решения» не отличимо от заявки, отправленной минуту
    // назад: владельцу нечего искать в очереди согласований.
    const день = вчера.toLocaleDateString("ru-RU", { timeZone: TZ, day: "2-digit", month: "2-digit" });
    assert.match(res.reason ?? "", new RegExp(`\\(с ${день}\\)`));
    assert.equal(requests.length, 0);
  });

  it("заявка старше TTL гейт не держит: закуп уходит второй заявкой (П5b-4)", async () => {
    // Забытая заявка недельной давности — не двойное нажатие, а тишина: закуп
    // из бота молча отвечал «уже ждёт решения» на СОВСЕМ ДРУГОЙ поход.
    const { svc, requests } = approvalsStub();
    const старая = [
      { payload: { purchaseOrder: { positions: [], costRounded: 1 } }, createdAt: new Date(Date.now() - 4 * 86_400_000) },
    ];
    const vending = new VendingService(purchaseDb(slots, sales, products, [], [], старая), svc);
    assert.equal((await vending.submitPurchase("owner")).submitted, true);
    assert.equal(requests.length, 1);
  });

  it("нерешённая заявка БЕЗ закупа в payload отправке не мешает", async () => {
    // В очереди живут заявки других агентов и другие решения вендинга —
    // гейт обязан смотреть на снимок закупа, а не на сам факт очереди.
    const { svc, requests } = approvalsStub();
    const чужая = [{ payload: { coffeeRefill: { id: "x" } }, createdAt: new Date() }];
    const vending = new VendingService(purchaseDb(slots, sales, products, [], [], чужая), svc);
    assert.equal((await vending.submitPurchase("owner")).submitted, true);
    assert.equal(requests.length, 1);
  });

  it("позиции без цены оговорены в тексте заявки: реальная сумма выше (UX#9)", async () => {
    const { svc, requests } = approvalsStub();
    const слоты: Row[] = [
      ...slots,
      { machineSerial: "AH", coilId: "2", productName: "Загадка", capacity: 6, quantity: 0 },
    ];
    const продажи: SaleRow[] = [...sales, { machineSerial: "AH", productName: "Загадка", quantity: 3, capturedAt: t }];
    const vending = new VendingService(purchaseDb(слоты, продажи, products), svc);
    await vending.submitPurchase("owner");
    assert.match(requests[0]!.action, /у 1 поз\. нет цены — реальная сумма выше/);
  });
});

describe("Вендинг Core: приёмка накладной на склад (§5.7)", () => {
  type OrderRow = { id: string; status: string; positions: unknown[] };
  /**
   * Стаб БД приёмки: отдаёт накладную, копит апдейт статуса/приход/события.
   * `aliases`/`products` — только для тестов с `distributed` (loadProductIndex
   * читает их вне транзакции); без distributed этот select не вызывается.
   */
  function receiveDb(
    order: OrderRow | null,
    aliases: unknown[] = [],
    products: unknown[] = [],
    opts: { updateReturnsEmpty?: boolean } = {},
  ) {
    const stockUpserts: Record<string, unknown>[] = [];
    const updates: Record<string, unknown>[] = [];
    const events: Record<string, unknown>[] = [];
    const purchases: Record<string, unknown>[] = [];
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => (order ? [order] : []),
            orderBy: () => ({ limit: async () => (order ? [order] : []) }),
          }),
        }),
      }),
      // .returning() имитирует условный UPDATE...WHERE status IN (...): пустой
      // массив — «проиграли гонку», кто-то другой уже перевёл накладную в
      // received между нашим SELECT и этим UPDATE (opts.updateReturnsEmpty).
      update: () => ({
        set: (v: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              updates.push(v);
              if (opts.updateReturnsEmpty || !order) return [];
              return [{ ...order, ...v }];
            },
          }),
        }),
      }),
      insert: (table: unknown) => ({
        values: (v: Record<string, unknown> | Record<string, unknown>[]) => {
          if (table === vendingStock) {
            stockUpserts.push(v as Record<string, unknown>);
            return { onConflictDoUpdate: async () => undefined };
          }
          if (table === purchase) {
            purchases.push(...(v as Record<string, unknown>[]));
            return { onConflictDoNothing: async () => undefined };
          }
          if (table === event) events.push(v as Record<string, unknown>);
          return Promise.resolve(undefined);
        },
      }),
    };
    // loadProductIndex() читает vendingAlias затем vendingProduct — различаем по счётчику.
    let call = 0;
    const db = {
      select: () => ({ from: async () => (call++ === 0 ? aliases : products) }),
      transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
    } as never;
    return { db, stockUpserts, updates, events, purchases };
  }

  it("приёмка увеличивает остаток на заказанное и переводит в received", async () => {
    const order: OrderRow = {
      id: "o1",
      status: "approved",
      positions: [
        { product: "Montella", order: 12 },
        { product: "Fanta", order: 12 },
        { product: "  ", order: 5 }, // пустое имя → мимо
        { product: "Zero", order: 0 }, // ноль → мимо
      ],
    };
    const { db, stockUpserts, updates, events } = receiveDb(order);
    const res = await new VendingService(db).receiveOrder();

    assert.equal(res.received, true);
    assert.equal(res.orderId, "o1");
    assert.equal(res.replenished, 2);
    assert.equal(res.units, 24);
    assert.equal(updates[0]!.status, "received");
    assert.ok(updates[0]!.receivedAt instanceof Date);
    assert.equal(updates[0]!.receivedBy, "owner");
    assert.equal(stockUpserts.length, 2);
    assert.equal(stockUpserts[0]!.productName, "Montella");
    assert.equal(stockUpserts[0]!.quantity, 12);
    assert.equal(events[0]!.type, "vending.purchase_order.received");
  });

  it("накладная уже принята — приёмку не повторяем", async () => {
    const { db, stockUpserts } = receiveDb({ id: "o1", status: "received", positions: [] });
    const res = await new VendingService(db).receiveOrder();
    assert.equal(res.received, false);
    assert.equal(stockUpserts.length, 0);
    assert.match(res.reason ?? "", /уже принята/i);
  });

  it("непринятых накладных нет — понятная причина", async () => {
    const { db } = receiveDb(null);
    const res = await new VendingService(db).receiveOrder();
    assert.equal(res.received, false);
    assert.match(res.reason ?? "", /нет/i);
  });

  it("отменённая накладная — отдельная причина, не «уже принята» (найдено ревью)", async () => {
    const { db, stockUpserts } = receiveDb({ id: "o1", status: "cancelled", positions: [] });
    const res = await new VendingService(db).receiveOrder("o1");
    assert.equal(res.received, false);
    assert.equal(stockUpserts.length, 0);
    assert.match(res.reason ?? "", /отменена/i);
    assert.doesNotMatch(res.reason ?? "", /уже принята/i);
  });

  it("гонка: конкурентный запрос уже перевёл накладную в received между SELECT и UPDATE — остаток не зачисляется дважды (найдено внешним аудитом)", async () => {
    // SELECT ещё видит approved (order.status), но условный
    // UPDATE...RETURNING (opts.updateReturnsEmpty) имитирует, что параллельная
    // приёмка уже выиграла гонку и статус реально уже received.
    const order: OrderRow = { id: "o1", status: "approved", positions: [{ product: "TUC", order: 10 }] };
    const { db, stockUpserts } = receiveDb(order, [], [], { updateReturnsEmpty: true });
    const res = await new VendingService(db).receiveOrder();

    assert.equal(res.received, false);
    assert.match(res.reason ?? "", /уже принята/i);
    assert.equal(stockUpserts.length, 0); // остаток НЕ зачислен второй раз
  });

  it("распределение по автоматам уменьшает зачисление на склад (реальный процесс, лист «Snack склад»)", async () => {
    // Было 0, закуп 10, сразу 5 в автомат — на складе должно остаться только 5.
    const order: OrderRow = { id: "o1", status: "approved", positions: [{ product: "TUC", order: 10 }] };
    const { db, stockUpserts } = receiveDb(order);
    const res = await new VendingService(db).receiveOrder(undefined, "owner", { TUC: 5 });

    assert.equal(res.units, 5); // на складе
    assert.equal(res.distributedUnits, 5); // в автоматах
    assert.equal(stockUpserts.length, 1);
    assert.equal(stockUpserts[0]!.quantity, 5);
  });

  it("распределено больше заказанного — отсекается до order, склад не уходит в минус", async () => {
    const order: OrderRow = { id: "o1", status: "approved", positions: [{ product: "TUC", order: 10 }] };
    const { db, stockUpserts } = receiveDb(order);
    const res = await new VendingService(db).receiveOrder(undefined, "owner", { TUC: 15 });

    assert.equal(res.distributedUnits, 10); // не больше order
    assert.equal(res.units, 0);
    assert.equal(stockUpserts.length, 0); // toWarehouse=0 → нечего вставлять
  });

  it("распределение по алиасу резолвится к канону — то же пространство имён, что и склад §5.4", async () => {
    const order: OrderRow = {
      id: "o1",
      status: "approved",
      positions: [{ product: "Montella Вода минеральная 330ml", order: 24 }],
    };
    const { db, stockUpserts } = receiveDb(
      order,
      [{ productId: "p1", alias: "Montella" }],
      [{ id: "p1", name: "Montella Вода минеральная 330ml" }],
    );
    const res = await new VendingService(db).receiveOrder(undefined, "owner", { montella: 10 });

    assert.equal(res.distributedUnits, 10);
    assert.equal(res.units, 14);
    assert.equal(stockUpserts[0]!.quantity, 14);
  });

  it("без distributed — как раньше: весь order идёт на склад", async () => {
    const order: OrderRow = { id: "o1", status: "approved", positions: [{ product: "TUC", order: 10 }] };
    const { db } = receiveDb(order);
    const res = await new VendingService(db).receiveOrder();
    assert.equal(res.distributedUnits, 0);
    assert.equal(res.units, 10);
  });

  it("нечисловое/дробное значение в distributed — запись игнорируем, приёмку не роняем (найдено адверсариал-ревью)", async () => {
    const order: OrderRow = { id: "o1", status: "approved", positions: [{ product: "TUC", order: 10 }] };
    const { db, stockUpserts } = receiveDb(order);
    const res = await new VendingService(db).receiveOrder(undefined, "owner", {
      TUC: "not-a-number" as unknown as number,
    });

    assert.equal(res.distributedUnits, 0);
    assert.equal(res.units, 10); // весь order — на склад, будто distributed не передавали
    assert.deepEqual(res.unmatchedDistribution, []); // невалидная запись даже не попала в карту
    assert.equal(stockUpserts[0]!.quantity, 10);
  });

  it("отрицательное/дробное целое в distributed — тоже игнорируем (§5.7)", async () => {
    const order: OrderRow = { id: "o1", status: "approved", positions: [{ product: "TUC", order: 10 }] };
    const { db } = receiveDb(order);
    const res = await new VendingService(db).receiveOrder(undefined, "owner", { TUC: 2.5 });
    assert.equal(res.distributedUnits, 0);
    assert.equal(res.units, 10);
  });

  it("два алиаса одного товара в distributed суммируются, а не перезаписывают друг друга (найдено адверсариал-ревью)", async () => {
    const order: OrderRow = {
      id: "o1",
      status: "approved",
      positions: [{ product: "Montella Вода минеральная 330ml", order: 30 }],
    };
    const { db, stockUpserts } = receiveDb(
      order,
      [
        { productId: "p1", alias: "Montella" },
        { productId: "p1", alias: "Montella pet 0.33" },
      ],
      [{ id: "p1", name: "Montella Вода минеральная 330ml" }],
    );
    const res = await new VendingService(db).receiveOrder(undefined, "owner", {
      Montella: 5,
      "Montella pet 0.33": 8,
    });

    assert.equal(res.distributedUnits, 13); // 5+8, не 8 (последний не должен затирать первый)
    assert.equal(res.units, 17); // 30-13
    assert.equal(stockUpserts[0]!.quantity, 17);
  });

  it("distributed без совпадения ни с одной позицией — не роняет приёмку, весь order на склад, но видно в unmatchedDistribution (найдено адверсариал-ревью)", async () => {
    const order: OrderRow = { id: "o1", status: "approved", positions: [{ product: "TUC", order: 10 }] };
    const { db, stockUpserts } = receiveDb(order);
    const res = await new VendingService(db).receiveOrder(undefined, "owner", { Flint: 5 });

    assert.equal(res.distributedUnits, 0);
    assert.equal(res.units, 10); // не нашли совпадения — всё на склад, как раньше
    assert.deepEqual(res.unmatchedDistribution, ["Flint"]);
    assert.equal(stockUpserts[0]!.quantity, 10);
  });

  it("сопоставление позиции и distributed без учёта регистра/пробелов даже без алиаса", async () => {
    const order: OrderRow = { id: "o1", status: "approved", positions: [{ product: "TUC", order: 10 }] };
    const { db, stockUpserts } = receiveDb(order);
    const res = await new VendingService(db).receiveOrder(undefined, "owner", { "  tuc  ": 4 });

    assert.equal(res.distributedUnits, 4);
    assert.equal(res.units, 6);
    assert.deepEqual(res.unmatchedDistribution, []);
    assert.equal(stockUpserts[0]!.quantity, 6);
  });

  it("мост П3: позиции накладной становятся строками журнала прихода", async () => {
    const order: OrderRow = {
      id: "abcdef12-0000-0000-0000-000000000000",
      status: "approved",
      positions: [
        { product: "Montella", order: 12, price: 8500 },
        { product: "Fanta", order: 6 }, // цены нет → unitPrice null, не 0
        { product: "Zero", order: 4, price: 0 }, // 0 = «цены нет», не ноль сум
      ],
    };
    const { db, purchases, events } = receiveDb(order);
    const res = await new VendingService(db).receiveOrder();

    assert.equal(res.recordedPurchases, 3);
    assert.equal(purchases.length, 3);
    const m = purchases.find((p) => p.product === "Montella")!;
    assert.equal(m.extId, `${order.id}:montella`);
    assert.equal(m.source, "vending-order");
    assert.equal(m.qty, "12");
    assert.equal(m.unitPrice, "8500.00");
    assert.equal(m.total, "102000.00");
    assert.match(String(m.dt), /^\d{4}-\d{2}-\d{2}$/);
    const f = purchases.find((p) => p.product === "Fanta")!;
    assert.equal(f.unitPrice, null);
    assert.equal(f.total, null);
    const z = purchases.find((p) => p.product === "Zero")!;
    assert.equal(z.unitPrice, null);
    const payload = events[0]!.payload as { recordedPurchases: number };
    assert.equal(payload.recordedPurchases, 3);
  });

  it("мост П3: полностью розданная позиция всё равно попадает в журнал (закуплена целиком)", async () => {
    const order: OrderRow = {
      id: "o1",
      status: "approved",
      positions: [{ product: "TUC", order: 5, price: 12000 }],
    };
    const { db, purchases, stockUpserts } = receiveDb(order);
    const res = await new VendingService(db).receiveOrder(undefined, "owner", { TUC: 5 });

    assert.equal(res.units, 0, "весь заказ роздан мимо склада");
    assert.equal(stockUpserts.length, 0);
    assert.equal(purchases.length, 1, "журнал фиксирует закуп, а не только приход на склад");
    assert.equal(purchases[0]!.qty, "5");
  });

  it("мост П3: пустые позиции не рождают строк журнала", async () => {
    const order: OrderRow = { id: "o1", status: "approved", positions: [{ product: " ", order: 5 }] };
    const { db, purchases } = receiveDb(order);
    const res = await new VendingService(db).receiveOrder();
    assert.equal(res.recordedPurchases, 0);
    assert.equal(purchases.length, 0);
  });

  it("мост П3 молчит при живом зеркале mydon-stock — иначе журнал двоил бы закуп (найдено адверсариал-ревью)", async () => {
    const order: OrderRow = { id: "o1", status: "approved", positions: [{ product: "TUC", order: 5, price: 12000 }] };
    const { db, purchases, stockUpserts } = receiveDb(order);
    process.env.STOCK_DATABASE_URL = "postgresql://stock.example/db";
    try {
      const res = await new VendingService(db).receiveOrder();
      assert.equal(res.received, true, "приёмка работает как раньше");
      assert.equal(stockUpserts.length, 1, "склад зачисляется как раньше");
      assert.equal(res.recordedPurchases, 0);
      assert.equal(purchases.length, 0, "строк vending-order нет, пока закуп зеркалится из stock");
    } finally {
      delete process.env.STOCK_DATABASE_URL;
    }
  });

  it("мост П3: дубль канона в positions сливается в одну строку, distributed не применяется дважды", async () => {
    const order: OrderRow = {
      id: "o1",
      status: "approved",
      // Слоты «Кола»/«кола» без алиаса дают две позиции одного канона.
      positions: [
        { product: "Кола", order: 10, price: 5000 },
        { product: "кола", order: 8, price: 5000 },
      ],
    };
    const { db, purchases } = receiveDb(order);
    const res = await new VendingService(db).receiveOrder(undefined, "owner", { кола: 8 });

    assert.equal(purchases.length, 1, "один extId — одна строка журнала");
    assert.equal(purchases[0]!.qty, "18");
    assert.equal(purchases[0]!.total, "90000.00");
    assert.equal(res.recordedPurchases, 1);
    // Раздача 8 списывается ОДИН раз (с первой позиции), не с каждой копии.
    assert.equal(res.distributedUnits, 8);
    assert.equal(res.units, 10, "склад получает 18 − 8, а не 18 − 16");
  });

  it("мост П3: потолки магнитуд — кривая цена уходит в null, гигантское qty не пишется в журнал", async () => {
    const order: OrderRow = {
      id: "o1",
      status: "approved",
      positions: [
        { product: "TUC", order: 5, price: 99_000_000_000 },
        { product: "Flint", order: 2_000_000_000, price: 5000 },
      ],
    };
    const { db, purchases } = receiveDb(order);
    await new VendingService(db).receiveOrder();
    const tuc = purchases.find((p) => p.product === "TUC")!;
    assert.equal(tuc.unitPrice, null, "цена за пределами numeric(15,2)-здравого смысла = «цены нет»");
    assert.ok(!purchases.some((p) => p.product === "Flint"), "qty за потолком не попадает в журнал");
  });
});

/** Карточка товара в стабе цены/правил: поля правил закупа нужны тесту П5a. */
type ProductRow = {
  id: string;
  name: string;
  purchasePrice: string | null;
  packSize?: number;
  excludedFromPurchase?: boolean;
  fixedPurchaseQty?: number | null;
};
/**
 * Стаб: loadProductIndex() читает alias/product (thenable from), поиск
 * карточки — where→limit; транзакция копит update и события.
 */
function priceDb(productRow: ProductRow | null, aliases: unknown[] = [], products: unknown[] = []) {
  const updates: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const audits: Record<string, unknown>[] = [];
  const tx = {
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => {
          updates.push(v);
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (v: Record<string, unknown>) => {
        (table === event ? events : audits).push(v);
      },
    }),
  };
  let call = 0;
  const db = {
    select: () => ({
      from: () => {
        const rows = Promise.resolve(call++ === 0 ? aliases : products);
        return {
          where: () => ({ limit: async () => (productRow ? [productRow] : []) }),
          then: rows.then.bind(rows),
        };
      },
    }),
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
  } as never;
  return { db, updates, events, audits };
}

describe("Вендинг Core: правка закупочной цены (П3)", () => {
  it("первая цена (текущей нет) проходит без гейта и пишет событие с аудитом", async () => {
    const { db, updates, events, audits } = priceDb({ id: "p1", name: "TUC", purchasePrice: null });
    const res = await new VendingService(db).setProductPrice("TUC", 12000, "owner");

    assert.equal(res.ok, true);
    assert.equal(res.product, "TUC");
    assert.equal(res.oldPrice, null);
    assert.equal(updates[0]!.purchasePrice, "12000.00");
    assert.equal(events[0]!.type, "vending.price_changed");
    assert.equal(audits[0]!.action, "vending.product.set_price");
  });

  it("гейт: отклонение больше 20% без подтверждения — отказ, цена не тронута", async () => {
    const { db, updates } = priceDb({ id: "p1", name: "TUC", purchasePrice: "10000" });
    const res = await new VendingService(db).setProductPrice("TUC", 15000);

    assert.equal(res.ok, false);
    assert.equal(res.reason, "spike");
    assert.equal(res.deviationPct, 50);
    assert.equal(res.oldPrice, 10000);
    assert.equal(updates.length, 0);
  });

  it("гейт снимается confirmed=true", async () => {
    const { db, updates } = priceDb({ id: "p1", name: "TUC", purchasePrice: "10000" });
    const res = await new VendingService(db).setProductPrice("TUC", 15000, "owner", true);
    assert.equal(res.ok, true);
    assert.equal(updates[0]!.purchasePrice, "15000.00");
  });

  it("в пределах порога — без подтверждения", async () => {
    const { db } = priceDb({ id: "p1", name: "TUC", purchasePrice: "10000" });
    const res = await new VendingService(db).setProductPrice("TUC", 11500);
    assert.equal(res.ok, true);
  });

  it("алиас резолвится в канон до поиска карточки", async () => {
    const { db } = priceDb({ id: "p1", name: "TUC", purchasePrice: null }, [{ productId: "p1", alias: "тук" }], [
      { id: "p1", name: "TUC", purchasePrice: null, packSize: 1 },
    ]);
    const res = await new VendingService(db).setProductPrice("тук", 9000);
    assert.equal(res.ok, true);
    assert.equal(res.product, "TUC");
  });

  it("незнакомый товар — not_found, ничего не пишем", async () => {
    const { db, updates, events } = priceDb(null);
    const res = await new VendingService(db).setProductPrice("Чипсы новые", 9000);
    assert.equal(res.ok, false);
    assert.equal(res.reason, "not_found");
    assert.equal(updates.length, 0);
    assert.equal(events.length, 0);
  });

  it("мусорный вход (0, NaN, пустое имя) — отказ до записи", async () => {
    const { db } = priceDb(null);
    assert.equal((await new VendingService(db).setProductPrice("TUC", 0)).ok, false);
    assert.equal((await new VendingService(db).setProductPrice("TUC", Number.NaN)).ok, false);
    assert.equal((await new VendingService(db).setProductPrice("  ", 100)).ok, false);
  });
});

describe("Вендинг Core: инвентаризация склада (§5.4)", () => {
  it("перезаписывает остаток по товару (upsert), пустое имя пропускает", async () => {
    const { db, inserts } = writeDb();
    const svc = new VendingService(db);
    const res = await svc.ingestStock({
      countedAt: "2026-08-02T09:00:00Z",
      items: [
        { product: "Montella", quantity: 24 },
        { product: "  ", quantity: 5 }, // пустое имя → пропуск
      ],
    });
    assert.deepEqual(res, { items: 2, adjustments: [] }); // счётчик по входу, расхождений нет (склад пуст)
    // Записана только валидная позиция.
    assert.equal(строкиТаблицы(inserts, "vending_stock").length, 1);
    const v = строкиТаблицы(inserts, "vending_stock")[0]! as { productName: string; quantity: number };
    assert.equal(v.productName, "Montella");
    assert.equal(v.quantity, 24);
  });

  it("имя-вариант приводится к канону через алиас (регистр не важен)", async () => {
    const { db, inserts } = writeDb(
      [{ productId: "p1", alias: "Montella" }],
      [{ id: "p1", name: "Montella Вода минеральная 330ml" }],
    );
    const svc = new VendingService(db);
    await svc.ingestStock({ items: [{ product: "montella", quantity: 7 }] });
    const v = строкиТаблицы(inserts, "vending_stock")[0]! as { productName: string };
    assert.equal(v.productName, "Montella Вода минеральная 330ml");
  });

  it("неизвестное имя (нет алиаса) остаётся как есть — на разбор позже", async () => {
    const { db, inserts } = writeDb([], []);
    const svc = new VendingService(db);
    await svc.ingestStock({ items: [{ product: "Новый Товар", quantity: 3 }] });
    const v = строкиТаблицы(inserts, "vending_stock")[0]! as { productName: string };
    assert.equal(v.productName, "Новый Товар");
  });

  it("алиас, чей ключ равен имени ЧУЖОЙ карточки, строку не уводит (R-G-1)", async () => {
    // Живой резолвер спрашивал алиас первым: строка «Fanta CAN 0,25» ложилась
    // на «Sprite CAN 0,25». На проде таких пар ноль — фикс закрывает не
    // сегодняшний убыток, а завтрашний алиас.
    const rows = [slot("AH", "31", "Fanta CAN 0,25", 6, 0)];
    const aliases: AliasRow[] = [{ productId: "p2", alias: "Fanta CAN 0,25" }];
    const products: ProdRow[] = [
      { id: "p1", name: "Fanta CAN 0,25", purchasePrice: null, packSize: 1 },
      { id: "p2", name: "Sprite CAN 0,25", purchasePrice: null, packSize: 1 },
    ];
    const summary = await new VendingService(readDb(rows, aliases, products)).deficitSummary();
    assert.deepEqual(
      summary.map((s) => s.product),
      ["Fanta CAN 0,25"],
    );
  });

  it("имя, отличающееся только запятой, ложится на карточку, а не отдельной позицией", async () => {
    // Три строки истории склада прода (`…0.45`, `…0.3`) до среза резолвились
    // сырыми: алиаса нет, а имя карточки живой резолвер не спрашивал.
    const rows = [slot("AH", "31", "Royal Pomegranate CAN 0.3", 6, 0)];
    const products: ProdRow[] = [{ id: "p1", name: "Royal Pomegranate CAN 0,3", purchasePrice: null, packSize: 1 }];
    const summary = await new VendingService(readDb(rows, [], products)).deficitSummary();
    assert.deepEqual(
      summary.map((s) => s.product),
      ["Royal Pomegranate CAN 0,3"],
    );
  });

  it("спор отдаёт карточку по ИМЕНИ и пишет предупреждение в лог", async () => {
    const products: ProdRow[] = [
      { id: "p1", name: "Fanta CAN 0,25", purchasePrice: null, packSize: 1 },
      { id: "p2", name: "Sprite CAN 0,25", purchasePrice: null, packSize: 1 },
    ];
    const svc = new VendingService(readDb([], [{ productId: "p2", alias: "Fanta CAN 0,25" }], products));
    const предупреждения: string[] = [];
    // Логгер сервиса — private readonly поле; в тесте подменяем его целиком:
    // проверяем НАБЛЮДАЕМОЕ («первый спор на проде будет видно»), а не вызов.
    (svc as unknown as { logger: { warn: (m: string) => void } }).logger = {
      warn: (m: string) => предупреждения.push(m),
    };
    const canon = await svc.canonResolver();
    assert.equal(canon("Fanta CAN 0,25"), "Fanta CAN 0,25");
    assert.equal(предупреждения.length, 1);
    assert.match(предупреждения[0]!, /Sprite CAN 0,25/);
  });

  it("тот же спор на ОДНОМ каталоге не задваивает предупреждение (гигиена m4)", async () => {
    // `resolveSlots`/`retailFacts` зовут резолвер построчно на сотни-тысячи
    // строк: без дедупа одно спорное имя утопило бы первый спор в собственном
    // шуме. Дедуп — по каталогу (`ProductIndex`), не навсегда: новый прогон
    // (`canonResolver()` заново) предупредит снова, см. соседний тест.
    const products: ProdRow[] = [
      { id: "p1", name: "Fanta CAN 0,25", purchasePrice: null, packSize: 1 },
      { id: "p2", name: "Sprite CAN 0,25", purchasePrice: null, packSize: 1 },
    ];
    const svc = new VendingService(readDb([], [{ productId: "p2", alias: "Fanta CAN 0,25" }], products));
    const предупреждения: string[] = [];
    (svc as unknown as { logger: { warn: (m: string) => void } }).logger = {
      warn: (m: string) => предупреждения.push(m),
    };
    const canon = await svc.canonResolver();
    canon("Fanta CAN 0,25");
    canon("Fanta CAN 0,25");
    canon("Fanta CAN 0,25");
    assert.equal(предупреждения.length, 1, "три вызова на одном каталоге — одно предупреждение");
  });

  it("на спорном имени ссылка на карточку НЕ проставляется: NULL чинится, ошибка — нет", async () => {
    // `бэкфиллWhere` держит `isNull(product_id)`: ошибочно проставленную
    // ссылку повторный прогон уже не тронет, а молчаливая привязка к чужой
    // карточке хуже оставленного NULL.
    const products: ProdRow[] = [
      { id: "p1", name: "Fanta CAN 0,25", purchasePrice: null, packSize: 1 },
      { id: "p2", name: "Sprite CAN 0,25", purchasePrice: null, packSize: 1 },
    ];
    const { db, inserts } = writeDb([{ productId: "p2", alias: "Fanta CAN 0,25" }], products);
    const svc = new VendingService(db);
    await svc.ingestStock({ items: [{ product: "Fanta CAN 0,25", quantity: 5 }] });
    const строка = строкиТаблицы(inserts, "vending_stock")[0]! as { productName: string; productId: string | null };
    assert.equal(строка.productName, "Fanta CAN 0,25");
    assert.equal(строка.productId, null);
  });

  it("недостача при пересчёте: было 55 → стало 54, оценена по цене (реальный лист 02.08.2026)", async () => {
    const products = [{ id: "p1", name: "Montella Вода минеральная 330ml", purchasePrice: "2090.00" }];
    const stock = [{ productName: "Montella Вода минеральная 330ml", quantity: 55 }];
    const { db, inserts } = writeDb(
      [{ productId: "p1", alias: "Montella pet 0.33" }],
      products,
      stock,
    );
    const svc = new VendingService(db);
    const res = await svc.ingestStock({ items: [{ product: "Montella pet 0.33", quantity: 54 }] });

    assert.equal(res.adjustments.length, 1);
    const a = res.adjustments[0]!;
    assert.equal(a.product, "Montella Вода минеральная 330ml");
    assert.equal(a.before, 55);
    assert.equal(a.after, 54);
    assert.equal(a.delta, -1); // недостача
    assert.equal(a.value, 2090); // |delta| × цена
    assert.equal(a.noPrice, false);

    // Расхождение попадает в журнал (событие + audit), не только в ответ метода.
    const ev = строкиВставок(inserts).find((v) => (v as { type?: string }).type === "vending.stock.recounted");
    assert.ok(ev, "должно быть событие о пересчёте");
    const audit = строкиВставок(inserts).find((v) => (v as { action?: string }).action === "vending.stock.recount");
    assert.ok(audit, "должна быть запись в журнале действий");
  });

  it("излишек при пересчёте — тоже расхождение, но со знаком плюс", async () => {
    const stock = [{ productName: "Fanta Classic CAN 250ml", quantity: 7 }];
    const { db } = writeDb([], [], stock);
    const svc = new VendingService(db);
    const res = await svc.ingestStock({ items: [{ product: "Fanta Classic CAN 250ml", quantity: 19 }] });
    assert.equal(res.adjustments.length, 1);
    assert.equal(res.adjustments[0]!.delta, 12);
  });

  it("без цены в прайсе — value 0, noPrice=true, но расхождение видно", async () => {
    const stock = [{ productName: "Новый Товар", quantity: 10 }];
    const { db } = writeDb([], [], stock);
    const svc = new VendingService(db);
    const res = await svc.ingestStock({ items: [{ product: "Новый Товар", quantity: 8 }] });
    assert.equal(res.adjustments[0]!.value, 0);
    assert.equal(res.adjustments[0]!.noPrice, true);
  });

  it("цена с копейками не даёт «грязный» хвост float — value округлён до копеек", async () => {
    // 3 × 2090.55 = 6271.6499999999996 в чистом IEEE-754 — без округления это
    // легло бы в неизменяемый журнал как есть (найдено адверсариал-ревью).
    const products = [{ id: "p1", name: "Товар с копейками", purchasePrice: "2090.55" }];
    const stock = [{ productName: "Товар с копейками", quantity: 10 }];
    const { db } = writeDb([], products, stock);
    const svc = new VendingService(db);
    const res = await svc.ingestStock({ items: [{ product: "Товар с копейками", quantity: 7 }] });
    assert.equal(res.adjustments[0]!.value, 6271.65);
  });

  it("событие пересчёта пишет ПЕРЕДАННОГО actor, а не жёстко owner", async () => {
    const stock = [{ productName: "Fanta Classic CAN 250ml", quantity: 7 }];
    const { db, inserts } = writeDb([], [], stock);
    const svc = new VendingService(db);
    await svc.ingestStock({ items: [{ product: "Fanta Classic CAN 250ml", quantity: 19 }] }, "manager");
    const ev = строкиВставок(inserts).find((v) => (v as { type?: string }).type === "vending.stock.recounted");
    assert.equal((ev! as { source: string }).source, "manager");
  });

  it("опоздавший пересчёт (countedAt старше уже сохранённого) — не откатывает остаток и не считается расхождением (найдено внешним аудитом, P2)", async () => {
    const stock = [
      { productName: "Montella Вода минеральная 330ml", quantity: 54, countedAt: new Date("2026-08-02T12:00:00Z") },
    ];
    const { db, inserts } = writeDb([], [], stock);
    const svc = new VendingService(db);
    const res = await svc.ingestStock({
      countedAt: "2026-08-02T09:00:00Z", // раньше уже сохранённого 12:00 — опоздавшее сообщение
      items: [{ product: "Montella Вода минеральная 330ml", quantity: 999 }],
    });

    assert.deepEqual(res.adjustments, []); // мнимого расхождения по устаревшим данным нет
    assert.equal(inserts.length, 0); // и более новый остаток не перезаписан старым
    // …и следа в истории тоже нет: пересчёт, который остаток не изменил,
    // журнал показывать не должен (R-P8a-3).
    assert.equal(строкиТаблицы(inserts, "vending_stock_count").length, 0);
  });

  it("первый ввод по товару (в складе строки ещё не было) — не расхождение", async () => {
    const { db } = writeDb([], [], []); // склад пуст — ничего сравнивать
    const svc = new VendingService(db);
    const res = await svc.ingestStock({ items: [{ product: "Совершенно новый", quantity: 30 }] });
    assert.deepEqual(res.adjustments, []);
  });

  it("количество не изменилось — не расхождение (не шумим по пустякам)", async () => {
    const stock = [{ productName: "Sprite 250ml", quantity: 19 }];
    const { db } = writeDb([], [], stock);
    const svc = new VendingService(db);
    const res = await svc.ingestStock({ items: [{ product: "Sprite 250ml", quantity: 19 }] });
    assert.deepEqual(res.adjustments, []);
  });

  it("два алиаса на ОДИН канон в одной инвентаризации — одна дельта, не две (регресс)", async () => {
    // «Montella pet 0.33» и «montella zero 0.33» — оба ведут на один товар.
    // Реальная смена: было 7 → стало 12 (последняя позиция в списке). Наивный
    // снимок «до» один раз на батч даёт ДВЕ дельты от устаревшего 7 — баг,
    // пойманный адверсариал-ревью до релиза.
    const canonical = "Montella Вода минеральная 330ml";
    const products = [{ id: "p1", name: canonical, purchasePrice: "2090.00" }];
    const aliases = [
      { productId: "p1", alias: "Montella pet 0.33" },
      { productId: "p1", alias: "montella zero 0.33" },
    ];
    const stock = [{ productName: canonical, quantity: 7 }];
    const { db, inserts } = writeDb(aliases, products, stock);
    const svc = new VendingService(db);

    const res = await svc.ingestStock({
      items: [
        { product: "Montella pet 0.33", quantity: 10 },
        { product: "montella zero 0.33", quantity: 12 },
      ],
    });

    assert.equal(res.adjustments.length, 1, "должна быть ровно одна дельта на канонический товар");
    const a = res.adjustments[0]!;
    assert.equal(a.before, 7);
    assert.equal(a.after, 12); // последняя позиция в списке побеждает
    assert.equal(a.delta, 5);
    assert.equal(a.value, 5 * 2090);

    // И записан склад — тоже РОВНО одной строкой на канон (не дважды).
    const stockInserts = строкиТаблицы(inserts, "vending_stock");
    assert.equal(stockInserts.length, 1);
    assert.equal((stockInserts[0]! as { quantity: number }).quantity, 12);
    // …со ссылкой на карточку прайса: строка склада ключуется именем, и без
    // ссылки переименование товара рвало связь остатка с прайсом (бэкфилл П4).
    assert.equal((stockInserts[0]! as { productId: string | null }).productId, "p1");
  });

  it("повторный пересчёт склада не затирает product_id пустым (ветка конфликта)", async () => {
    const { db, conflicts } = writeDb();
    await new VendingService(db).ingestStock({ items: [{ product: "Загадка", quantity: 3 }] });
    const набор = conflicts.find((c) => c.set.quantity !== undefined)!.set;
    assert.match(текстSQL(набор.productId), /coalesce\(excluded\.product_id/);
  });
});

/**
 * История инвентаризаций склада (R-P8a-3): `vending_stock` перезаписной, и до
 * этого среза вчерашний остаток не восстанавливался ниоткуда. Теперь каждый
 * пересчёт оставляет строку — история копится сама, без отдельной команды.
 */
describe("Вендинг Core: история пересчётов склада (R-P8a-3)", () => {
  const ПРАЙС = [{ id: "p1", name: "Montella Вода минеральная 330ml", purchasePrice: "2090.00" }];
  const АЛИАСЫ = [{ productId: "p1", alias: "Montella pet 0.33" }];

  it("пересчёт склада пишет строку истории на каждую применённую позицию", async () => {
    const { db, inserts } = writeDb(АЛИАСЫ, ПРАЙС);
    await new VendingService(db).ingestStock(
      { countedAt: "2026-08-25T09:34:00+05:00", items: [{ product: "Montella pet 0.33", quantity: 7 }] },
      "owner",
    );

    const строки = строкиТаблицы(inserts, "vending_stock_count");
    assert.equal(строки.length, 1);
    const строка = строки[0]! as Record<string, unknown>;
    assert.deepEqual(
      [строка.source, строка.dt, строка.qty, строка.extId, строка.note, строка.personId],
      ["own", "2026-08-25", "7", null, "owner", null],
    );
    // Имя — канон (как в складе), ссылка на карточку — тот же резолвер: без
    // неё история переживёт переименование товара строкой-сиротой.
    assert.deepEqual([строка.productName, строка.productId], ["Montella Вода минеральная 330ml", "p1"]);
    assert.equal((строка.countedAt as Date).toISOString(), "2026-08-25T04:34:00.000Z");
  });

  it("сутки истории — ташкентские: пересчёт в 00:30 по Ташкенту не уезжает во вчера", () => {
    // 2026-08-24T19:30:00Z — это уже 25.08 00:30 в Ташкенте. UTC-сутки дали бы
    // «24.08», и ночной пересчёт лёг бы в чужой день (урок донора VendCash).
    assert.equal(tashkentDay(new Date("2026-08-24T19:30:00.000Z")), "2026-08-25");
  });

  it("пересчёт «ничего не изменилось» ВСЁ РАВНО оставляет строку истории: это счёт, а не правка", async () => {
    // Расхождения нет — событие `vending.stock.recounted` не пишется. Но факт
    // «в этот день склад считали, и вышло 19» ценен сам по себе: без него
    // история показывала бы только дни, когда что-то не сошлось.
    const stock = [{ productName: "Sprite 250ml", quantity: 19 }];
    const { db, inserts } = writeDb([], [], stock);
    const res = await new VendingService(db).ingestStock({ items: [{ product: "Sprite 250ml", quantity: 19 }] });
    assert.deepEqual(res.adjustments, []);
    assert.equal(строкиТаблицы(inserts, "vending_stock_count").length, 1);
  });

  it("опоздавший пересчёт не оставляет следа в истории: он не изменил и остаток", async () => {
    const stock = [
      { productName: "Montella Вода минеральная 330ml", quantity: 54, countedAt: new Date("2026-08-25T10:00:00+05:00") },
    ];
    const { db, inserts } = writeDb(АЛИАСЫ, ПРАЙС, stock);
    await new VendingService(db).ingestStock({
      countedAt: "2026-08-25T09:00:00+05:00",
      items: [{ product: "Montella pet 0.33", quantity: 1 }],
    });
    assert.equal(строкиТаблицы(inserts, "vending_stock_count").length, 0);
  });

  it("повтор того же снимка отбивается ключом (source, counted_at, product_name), а не вторым insert", async () => {
    // Реальный частичный уникальный индекс (0069) проверяет дымовой прогон на
    // Postgres; заглушка SQL не исполняет — здесь видно только НАМЕРЕНИЕ.
    const { db, dedup } = writeDb(АЛИАСЫ, ПРАЙС);
    await new VendingService(db).ingestStock({ items: [{ product: "Montella pet 0.33", quantity: 7 }] });
    const ключ = dedup.find((d) => d.table === "vending_stock_count");
    assert.ok(ключ, "история обязана писаться через onConflictDoNothing");
    assert.deepEqual(
      (ключ.target as { name: string }[]).map((c) => c.name),
      ["source", "counted_at", "product_name"],
    );
    // Предикат частичного индекса сужает ключ до своих строк: у импорта свой
    // ключ идемпотентности — (source, ext_id).
    assert.match(текстSQL(ключ.where), /'own'/);
  });

  const СОТРУДНИК = "11111111-1111-1111-1111-111111111111";

  it("пересчёт от имени сотрудника проставляет person_id (импорт и безымянный ввод — NULL)", async () => {
    const { db, inserts } = writeDb(АЛИАСЫ, ПРАЙС, [], [], [{ id: СОТРУДНИК }]);
    await new VendingService(db).ingestStock(
      { personId: СОТРУДНИК, items: [{ product: "Montella pet 0.33", quantity: 7 }] },
      "bot:operator",
    );
    const строка = строкиТаблицы(inserts, "vending_stock_count")[0]! as Record<string, unknown>;
    assert.equal(строка.personId, СОТРУДНИК);
  });

  it("чужой (пусть и валидный) uuid не роняет пересчёт: person_id гасится в NULL", async () => {
    // DTO проверяет только ФОРМУ uuid, а колонка — внешний ключ на `person`:
    // карточку удалили или бот прислал id из другой базы — и лист на 50 позиций
    // пропал бы откатом транзакции целиком. Имя актора остаётся в `note`.
    const { db, inserts } = writeDb(АЛИАСЫ, ПРАЙС, [], [], [{ id: СОТРУДНИК }]);
    const res = await new VendingService(db).ingestStock(
      { personId: "99999999-9999-9999-9999-999999999999", items: [{ product: "Montella pet 0.33", quantity: 7 }] },
      "bot:operator",
    );
    assert.equal(res.items, 1, "пересчёт обязан примениться");
    const строка = строкиТаблицы(inserts, "vending_stock_count")[0]! as Record<string, unknown>;
    assert.deepEqual([строка.personId, строка.note], [null, "bot:operator"]);
    assert.equal(строкиТаблицы(inserts, "vending_stock").length, 1, "и остаток записан");
  });

  it("два алиаса одного товара в одном листе — одна строка истории, как и один остаток", async () => {
    const { db, inserts } = writeDb([...АЛИАСЫ, { productId: "p1", alias: "montella zero 0.33" }], ПРАЙС);
    await new VendingService(db).ingestStock({
      items: [
        { product: "Montella pet 0.33", quantity: 10 },
        { product: "montella zero 0.33", quantity: 12 },
      ],
    });
    const строки = строкиТаблицы(inserts, "vending_stock_count");
    assert.equal(строки.length, 1);
    assert.equal((строки[0]! as { qty: string }).qty, "12");
  });
});

/**
 * Чтение истории: `GET /vending/stock-counts` (R-P8a-3). Стаб СОРТИРУЕТ и
 * РЕЖЕТ по-настоящему — иначе «свежее сверху» и потолок строк проверялись бы
 * порядком фикстуры, а не кодом сервиса.
 */
describe("Вендинг Core: чтение истории склада (R-P8a-3)", () => {
  type ИсторияRow = {
    /** PK строки: тай-брейкер порядка (R-FW-P2) — 92 строки прода неразличимы без него. */
    id: string;
    dt: string;
    productName: string;
    qty: string;
    source: string;
    countedAt: Date;
    note: string | null;
  };

  let seq = 0;
  const строка = (
    dt: string,
    productName: string,
    qty: number,
    source = "own",
    note: string | null = null,
  ): ИсторияRow => ({
    id: `sc-${String(++seq).padStart(4, "0")}`,
    dt,
    productName,
    qty: qty.toFixed(2),
    source,
    countedAt: new Date(`${dt}T09:00:00+05:00`),
    note,
  });

  /** Ключи сортировки, которые сервис отдал drizzle: тест сверяет ИХ, а не догадку стенда. */
  const порядок: unknown[] = [];

  function historyDb(rows: ИсторияRow[], aliases: unknown[] = [], products: unknown[] = []) {
    const db = {
      select: () => ({
        from: (t: unknown) => {
          if (t !== vendingStockCount) {
            const r = Promise.resolve(t === vendingAlias ? aliases : t === vendingProduct ? products : []);
            return { where: () => r, then: r.then.bind(r) };
          }
          let текущие = rows;
          const chain: Record<string, unknown> = {};
          chain.where = (cond?: unknown) => {
            const п = параметрыSQL(cond).filter((v): v is string => typeof v === "string");
            const дата = п.find((v) => /^\d{4}-\d{2}-\d{2}$/.test(v));
            const имя = п.find((v) => !/^\d{4}-\d{2}-\d{2}$/.test(v));
            текущие = текущие.filter((r) => (дата === undefined || r.dt >= дата) && (имя === undefined || r.productName === имя));
            return chain;
          };
          chain.orderBy = (...ключи: unknown[]) => {
            порядок.length = 0;
            порядок.push(...ключи);
            текущие = [...текущие].sort(
              (a, b) =>
                b.countedAt.getTime() - a.countedAt.getTime() ||
                a.productName.localeCompare(b.productName, "ru") ||
                // Тот же третий ключ, что в сервисе: без него две неразличимые
                // строки одного дня/товара отдавала бы база в любом порядке.
                a.id.localeCompare(b.id),
            );
            return chain;
          };
          chain.limit = async (n: number) => текущие.slice(0, n);
          return chain;
        },
      }),
    } as never;
    return db;
  }

  const СЕЙЧАС = new Date("2026-08-25T13:00:00+05:00");

  it("две неразличимые строки одного дня и товара отдаются в одном и том же порядке (R-FW-P2)", async () => {
    // Прод 26.08: 46 групп (день, товар, место) содержат по ДВЕ строки — это 92
    // строки, и у 41 пары количества разные (напр. 0 и 30 за 17.07 по одному
    // товару). Обе сортировочные колонки у пары равны, `ext_id` в ответ не
    // уезжает — значит порядок отдавала база, и лист не был воспроизводим.
    const первая = строка("2026-07-17", "Montella Вода минеральная 330ml", 0, "stock-import");
    const вторая = строка("2026-07-17", "Montella Вода минеральная 330ml", 30, "stock-import");
    // Фикстура подаётся «наоборот» — порядок обязан задать сервис, а не вход.
    const о = await new VendingService(historyDb([вторая, первая])).stockCounts(90, undefined, СЕЙЧАС);
    assert.deepEqual(о.rows.map((r) => r.qty), [0, 30], "тай-брейкер по id обязан дать один и тот же порядок");
    assert.equal(
      порядок.at(-1),
      vendingStockCount.id,
      "последним ключом сортировки обязан идти PK: без него порядок пары решает Postgres",
    );
  });

  it("окно, порядок «свежее сверху» и форма строки", async () => {
    const db = historyDb([
      строка("2026-08-25", "Sprite 250ml", 19),
      строка("2026-08-25", "Montella Вода минеральная 330ml", 7),
      строка("2026-01-01", "Montella Вода минеральная 330ml", 3, "stock-import"),
    ]);
    const о = await new VendingService(db).stockCounts(90, undefined, СЕЙЧАС);

    assert.equal(о.days, 90);
    assert.equal(о.product, null);
    assert.deepEqual(о.rows.map((r) => r.product), ["Montella Вода минеральная 330ml", "Sprite 250ml"]);
    assert.deepEqual(о.rows[0], {
      dt: "2026-08-25",
      product: "Montella Вода минеральная 330ml",
      qty: 7,
      source: "own",
      countedAt: "2026-08-25T04:00:00.000Z",
      note: null,
    });
    assert.deepEqual(о.warnings, []);
  });

  it("в строке едет `note` — без него лист не сгруппирует ни по месту, ни по счётчику", async () => {
    // `note` значит РАЗНОЕ у разных источников (R-H-2): у своей строки это
    // человек, у импортированной — локация донора. Одно поле, два смысла, и
    // различает их `source` — поэтому оба обязаны доехать до витрины.
    const db = historyDb([
      строка("2026-08-25", "Sprite 250ml", 19, "own", "Рустам"),
      строка("2026-08-24", "Sprite 250ml", 12, "stock-import", "2 Холодильник"),
    ]);
    const о = await new VendingService(db).stockCounts(90, undefined, СЕЙЧАС);
    assert.deepEqual(
      о.rows.map((r) => [r.source, r.note]),
      [["own", "Рустам"], ["stock-import", "2 Холодильник"]],
    );
  });

  it("`since` — первые сутки окна, те же, по которым шла выборка", async () => {
    // Витрина подписывает окно этим числом. Считай его панель сама — в
    // репозитории появилась бы вторая копия правила `− (дни − 1)` (R-FW-11), и
    // разошлась бы она молча: подпись на сутки мимо выборки не видна никак.
    const db = historyDb([строка("2026-08-25", "Sprite 250ml", 19)]);
    const о = await new VendingService(db).stockCounts(90, undefined, СЕЙЧАС);
    assert.equal(о.since, "2026-05-28");
    const однодневное = await new VendingService(historyDb([])).stockCounts(1, undefined, СЕЙЧАС);
    assert.equal(однодневное.since, "2026-08-25", "days=1 — это «сегодня», а не «вчера»");
  });

  it("окно шире — доезжает и импортированное прошлое, `source` его отличает", async () => {
    const db = historyDb([строка("2026-01-01", "Montella Вода минеральная 330ml", 3, "stock-import")]);
    const о = await new VendingService(db).stockCounts(365, undefined, СЕЙЧАС);
    assert.deepEqual(о.rows.map((r) => r.source), ["stock-import"]);
  });

  it("фильтр по товару — через канон: алиас находит строки, записанные каноном", async () => {
    const db = historyDb(
      [строка("2026-08-25", "Montella Вода минеральная 330ml", 7), строка("2026-08-25", "Sprite 250ml", 19)],
      [{ productId: "p1", alias: "Montella pet 0.33" }],
      [{ id: "p1", name: "Montella Вода минеральная 330ml" }],
    );
    const о = await new VendingService(db).stockCounts(90, "montella pet 0.33", СЕЙЧАС);
    assert.equal(о.product, "Montella Вода минеральная 330ml");
    assert.deepEqual(о.rows.map((r) => r.product), ["Montella Вода минеральная 330ml"]);
  });

  it("по заданному товару истории нет — предупреждение, а не молчаливый пустой ответ", async () => {
    const db = historyDb([строка("2026-08-25", "Sprite 250ml", 19)]);
    const о = await new VendingService(db).stockCounts(90, "Никогда Не Считали", СЕЙЧАС);
    assert.deepEqual(о.rows, []);
    assert.deepEqual(о.warnings.map((w) => w.code), ["stock_missing"]);
    assert.match(о.warnings[0]!.message, /Никогда Не Считали/);
  });

  it("пустая история БЕЗ фильтра предупреждения не даёт: считать ещё не начинали — это не пропажа", async () => {
    const о = await new VendingService(historyDb([])).stockCounts(90, undefined, СЕЙЧАС);
    assert.deepEqual([о.rows.length, о.warnings.length], [0, 0]);
  });

  it("потолок строк: хвост окна показан, обрезка названа словами", async () => {
    const rows = Array.from({ length: STOCK_COUNTS_MAX + 5 }, (_, i) =>
      строка("2026-08-25", `Товар ${String(i).padStart(4, "0")}`, i),
    );
    const о = await new VendingService(historyDb(rows)).stockCounts(90, undefined, СЕЙЧАС);
    assert.equal(о.rows.length, STOCK_COUNTS_MAX);
    assert.deepEqual(о.warnings.map((w) => w.code), ["history_capped"]);
  });

  it("окно зажимается: мусорные и запредельные дни не доезжают до выборки", async () => {
    const db = historyDb([строка("2026-08-25", "Sprite 250ml", 19)]);
    const svc = new VendingService(db);
    assert.equal((await svc.stockCounts(0, undefined, СЕЙЧАС)).days, STOCK_COUNTS_DAYS_DEFAULT);
    assert.equal((await svc.stockCounts(100_000, undefined, СЕЙЧАС)).days, STOCK_COUNTS_DAYS_MAX);
    assert.equal((await svc.stockCounts(Number.NaN, undefined, СЕЙЧАС)).days, STOCK_COUNTS_DAYS_DEFAULT);
  });

  it("потолок — 730 суток, не 365 (R-FW-P3): донор начинается 2025-08-17, старая граница года до этой даты не дотягивалась НИКОГДА", async () => {
    // Закреплено числом, а не только «зажимается до константы»: константа
    // сама могла бы тихо остаться 365 при правке соседнего теста.
    assert.equal(STOCK_COUNTS_DAYS_MAX, 730);
    const db = historyDb([строка("2026-08-25", "Sprite 250ml", 19)]);
    assert.equal((await new VendingService(db).stockCounts(730, undefined, СЕЙЧАС)).days, 730);
  });

  it("окно ВКЛЮЧАЕТ сегодняшние сутки (final review §3, minor): days=1 — только сегодня, days=2 — и вчера", async () => {
    // Пин на конвенцию `since = tashkentDayStartOf(now) − (дни − 1) × сутки`
    // (`stockCounts`, `− (дни − 1)`, а не `− дни`): пересчёт, сделанный час
    // назад, — ровно то, за чем в историю и приходят, и «окно в 1 день»
    // обязано означать «сегодня», а не «вчера». Откат на `− дни` дал бы
    // `days=1` вчерашние сутки вместо сегодняшних — этот тест обязан упасть.
    const db = historyDb([
      строка("2026-08-25", "Sprite 250ml", 19), // сегодня — СЕЙЧАС = 2026-08-25T13:00+05
      строка("2026-08-24", "Sprite 250ml", 20), // вчера
      строка("2026-08-23", "Sprite 250ml", 21), // позавчера
    ]);
    const однодневное = await new VendingService(db).stockCounts(1, undefined, СЕЙЧАС);
    assert.deepEqual(
      однодневное.rows.map((r) => r.dt),
      ["2026-08-25"],
      "days=1 обязан включать СЕГОДНЯ, а не только завершённые сутки",
    );

    const двухдневное = await new VendingService(db).stockCounts(2, undefined, СЕЙЧАС);
    assert.deepEqual(
      двухдневное.rows.map((r) => r.dt),
      ["2026-08-25", "2026-08-24"],
      "days=2 — сегодня и вчера, позавчера ещё не входит",
    );
  });
});

describe("Вендинг Core: приём слотов", () => {
  it("пишет актуальный слот и снапшот, считает is_valid", async () => {
    const { db, inserts } = writeDb();
    const svc = new VendingService(db);
    const res = await svc.ingestSlots({
      machines: [{ serial: "AH", slots: [{ coilId: "31", product: "Montella", capacity: 6, quantity: 0 }] }],
    });
    assert.deepEqual(res, { machines: 1, slots: 1, linked: 0, pruned: 0, pruneErrors: [], skipped: [] });
    // Один слот → одна строка планограммы + одна строка истории.
    assert.equal(строкиТаблицы(inserts, "machine_slot").length, 1);
    assert.equal(строкиТаблицы(inserts, "slot_snapshot").length, 1);
    const ms = строкиТаблицы(inserts, "machine_slot")[0]! as { isValid: boolean; productName: string | null };
    assert.equal(ms.isValid, true); // 0 < 6 ≤ 100
    assert.equal(ms.productName, "Montella");
  });

  it("пустое имя товара → null (слот не назначен), вместимость 0 → невалиден", async () => {
    const { db, inserts } = writeDb();
    const svc = new VendingService(db);
    await svc.ingestSlots({ machines: [{ serial: "M", slots: [{ coilId: "1", product: "  ", capacity: 0, quantity: 0 }] }] });
    const ms = строкиТаблицы(inserts, "machine_slot")[0]! as { isValid: boolean; productName: string | null };
    assert.equal(ms.productName, null);
    assert.equal(ms.isValid, false);
  });

  it("привязывает слот к карточке, даже если в реестре серийник с приставкой c", async () => {
    // Боевой случай: Ourvend прислал «2508160376», в реестре лежит
    // «c2508160376» (форма из mydon-stock). Раньше machine_id оставался NULL.
    const { db, inserts } = writeDb([], [], [], [{ id: "ent-1", externalRef: "c2508160376" }]);
    const svc = new VendingService(db);
    const res = await svc.ingestSlots({
      machines: [{ serial: "2508160376", slots: [{ coilId: "1", product: "Snickers", capacity: 11, quantity: 8 }] }],
    });
    assert.equal(res.linked, 1);
    const ms = строкиТаблицы(inserts, "machine_slot")[0]! as { machineId: string | null };
    assert.equal(ms.machineId, "ent-1");
  });

  it("код кофемашины на c не путается с серийником Ourvend", async () => {
    // c7a6181f0000 — живой автомат; срезать приставку у него нельзя.
    const { db, inserts } = writeDb([], [], [], [{ id: "kofe", externalRef: "c7a6181f0000" }]);
    const svc = new VendingService(db);
    const res = await svc.ingestSlots({
      machines: [{ serial: "c7a6181f0000", slots: [{ coilId: "1", product: "x", capacity: 1, quantity: 1 }] }],
    });
    assert.equal(res.linked, 1);
    const ms = строкиТаблицы(inserts, "machine_slot")[0]! as { machineId: string | null };
    assert.equal(ms.machineId, "kofe");
  });

  it("автомат без карточки в реестре принимается, machine_id остаётся пустым", async () => {
    // 2508160355 и 2508160358 есть в Ourvend, но карточек у них нет.
    const { db, inserts } = writeDb([], [], [], [{ id: "ent-1", externalRef: "c2508160376" }]);
    const svc = new VendingService(db);
    const res = await svc.ingestSlots({
      machines: [{ serial: "2508160355", slots: [{ coilId: "1", product: "", capacity: 0, quantity: 0 }] }],
    });
    assert.equal(res.machines, 1);
    assert.equal(res.linked, 0);
    const ms = строкиТаблицы(inserts, "machine_slot")[0]! as { machineId: string | null };
    assert.equal(ms.machineId, null);
  });

  it("проставляет product_id по канону через алиасы (бэкфилл П4)", async () => {
    // Раньше ссылка была NULL у всех 210 строк: связывало слот с прайсом
    // только совпадение строк, и переименование товара рвало историю молча.
    const aliases: AliasRow[] = [{ productId: "p1", alias: "18+" }];
    const products: ProdRow[] = [{ id: "p1", name: "Montella Вода минеральная 330ml", purchasePrice: null, packSize: 1 }];
    const { db, inserts } = writeDb(aliases, products);
    const svc = new VendingService(db);
    await svc.ingestSlots({
      machines: [{ serial: "AH", slots: [{ coilId: "1", product: "18+", capacity: 6, quantity: 0 }] }],
    });
    const ms = строкиТаблицы(inserts, "machine_slot")[0]! as { productId: string | null; productName: string | null };
    assert.equal(ms.productId, "p1");
    assert.equal(ms.productName, "18+", "имя остаётся сырым — это по-прежнему «что показал автомат»");
  });

  it("повторный приём того же товара не затирает product_id пустым (ветка конфликта)", async () => {
    // Прайс мог переименовать карточку, и резолвер вернёт null там, где связь
    // есть и верна. Прямая запись `product_id = excluded.product_id` обнулила
    // бы ровно ту ссылку, ради которой бэкфилл и заводился.
    const { db, conflicts } = writeDb();
    await new VendingService(db).ingestSlots({
      machines: [{ serial: "AH", slots: [{ coilId: "1", product: "Загадка", capacity: 6, quantity: 0 }] }],
    });
    const набор = conflicts.find((c) => c.table === "machine_slot")!.set;
    const выражение = текстSQL(набор.productId);
    assert.match(выражение, /excluded\.product_name is distinct from/, "смена товара в слоте — ссылка идёт за товаром");
    assert.match(выражение, /coalesce\(excluded\.product_id/, "товар тот же — непустую ссылку не затираем");
  });

  it("товара нет в прайсе → product_id пустой, снимок всё равно принят", async () => {
    const { db, inserts } = writeDb();
    const svc = new VendingService(db);
    await svc.ingestSlots({
      machines: [{ serial: "AH", slots: [{ coilId: "1", product: "Загадка", capacity: 6, quantity: 0 }] }],
    });
    const ms = строкиТаблицы(inserts, "machine_slot")[0]! as { productId: string | null };
    assert.equal(ms.productId, null);
  });

  it("раздутый автомат пропускается, остальные принимаются (а не падает весь приём)", async () => {
    // Прежде потолок стоял валидатором на входе и отменял ВЕСЬ запрос.
    const many = Array.from({ length: MAX_SLOTS_PER_MACHINE + 1 }, (_, i) => ({
      coilId: String(i + 1),
      product: "x",
      capacity: 1,
      quantity: 1,
    }));
    const { db, inserts } = writeDb();
    const svc = new VendingService(db);
    const res = await svc.ingestSlots({
      machines: [
        { serial: "РАЗДУТЫЙ", slots: many },
        { serial: "ОБЫЧНЫЙ", slots: [{ coilId: "1", product: "Twix", capacity: 11, quantity: 9 }] },
      ],
    });
    assert.equal(res.machines, 1, "принят только обычный автомат");
    assert.equal(res.slots, 1);
    assert.deepEqual(res.skipped, [
      { serial: "РАЗДУТЫЙ", slots: MAX_SLOTS_PER_MACHINE + 1, reason: "слишком много слотов" },
    ]);
    // Слоты обычного автомата записаны — приём не отменён.
    assert.equal(строкиТаблицы(inserts, "machine_slot").length, 1);
    // И пропуск не растворился: он в журнале событий.
    assert.equal(inserts.filter((i) => i.table === "event").length, 1);
  });

  it("автомат ровно на потолке ещё принимается", async () => {
    const many = Array.from({ length: MAX_SLOTS_PER_MACHINE }, (_, i) => ({
      coilId: String(i + 1),
      product: "x",
      capacity: 1,
      quantity: 1,
    }));
    const { db } = writeDb();
    const svc = new VendingService(db);
    const res = await svc.ingestSlots({ machines: [{ serial: "НА_ГРАНИ", slots: many }] });
    assert.equal(res.machines, 1);
    assert.deepEqual(res.skipped, []);
  });

  it("потолок выше живого максимума парка (488 слотов у Olma Администрация)", () => {
    assert.ok(MAX_SLOTS_PER_MACHINE > 488, "иначе самый большой автомат парка перестанет приниматься");
  });
});

/**
 * Приём пишет ПАЧКАМИ, а не по строке.
 *
 * 24.08.2026 сбор Ourvend стал падать каждые три часа: `This operation was
 * aborted`, `machines_ok=0`. Приём 210 слотов делал 420 отдельных запросов, и
 * после перевода базы на внешний Postgres по TLS (`verify-full`) он перестал
 * укладываться в 10-секундный таймаут клиента агентов. Снимки при этом в базу
 * ложились — Core дописывал транзакцию уже без слушателя, — а продажи и
 * детектор заливок (они идут ПОСЛЕ успешного приёма) не выполнялись вовсе.
 */
describe("Вендинг Core: приём пишет пачками, а не построчно", () => {
  it("слоты автомата уходят ОДНИМ insert с массивом строк (и снимки тоже)", async () => {
    const { db, inserts } = writeDb();
    const svc = new VendingService(db);
    const res = await svc.ingestSlots({
      machines: [
        {
          serial: "ПАЧКА",
          slots: [
            { coilId: "1", product: "A", capacity: 5, quantity: 1 },
            { coilId: "2", product: "B", capacity: 5, quantity: 2 },
            { coilId: "3", product: "C", capacity: 5, quantity: 3 },
          ],
        },
      ],
    });
    assert.equal(res.slots, 3);
    const планограмма = inserts.filter((i) => i.table === "machine_slot");
    const история = inserts.filter((i) => i.table === "slot_snapshot");
    assert.equal(планограмма.length, 1, "три слота — один запрос, а не три");
    assert.equal(история.length, 1);
    assert.ok(Array.isArray(планограмма[0]!.values), "values() получает массив строк");
    assert.equal((планограмма[0]!.values as unknown[]).length, 3);
    assert.equal((история[0]!.values as unknown[]).length, 3);
    // Содержимое строк не поехало: порядок и значения те же, что присланы.
    assert.deepEqual(
      строкиТаблицы(inserts, "machine_slot").map((v) => [v.coilId, v.productName, v.quantity]),
      [
        ["1", "A", 1],
        ["2", "B", 2],
        ["3", "C", 3],
      ],
    );
  });

  it("каждый автомат — своя пачка (уборка зеркала по-прежнему помашинная)", async () => {
    const { db, inserts } = writeDb();
    const svc = new VendingService(db);
    await svc.ingestSlots({
      machines: [
        { serial: "A", slots: [{ coilId: "1", product: "x", capacity: 1, quantity: 1 }] },
        { serial: "B", slots: [{ coilId: "1", product: "y", capacity: 1, quantity: 1 }] },
      ],
    });
    assert.equal(inserts.filter((i) => i.table === "machine_slot").length, 2);
  });

  it("ветка конфликта берёт значения из excluded — иначе пачка обновила бы все строки данными одной", async () => {
    // В многострочном INSERT литерал «capacity этой строки» невозможен: набор
    // один на весь запрос. Ошибиться здесь значит записать всем слотам
    // автомата остаток последнего — и это не упало бы ни одним тестом на счёт.
    const { db, conflicts } = writeDb();
    await new VendingService(db).ingestSlots({
      machines: [
        {
          serial: "ПАЧКА",
          slots: [
            { coilId: "1", product: "A", capacity: 5, quantity: 1 },
            { coilId: "2", product: "B", capacity: 9, quantity: 7 },
          ],
        },
      ],
    });
    const набор = conflicts.find((c) => c.table === "machine_slot")!.set;
    assert.match(текстSQL(набор.quantity), /excluded\.quantity/);
    assert.match(текстSQL(набор.capacity), /excluded\.capacity/);
    assert.match(текстSQL(набор.isValid), /excluded\.is_valid/);
    assert.match(текстSQL(набор.productName), /excluded\.product_name/);
    assert.match(текстSQL(набор.machineId), /excluded\.machine_id/);
    // Семантика ссылки на карточку — прежняя, слово в слово.
    assert.match(текстSQL(набор.productId), /excluded\.product_name is distinct from/);
    assert.match(текстSQL(набор.productId), /coalesce\(excluded\.product_id/);
  });

  it("один coilId дважды в выгрузке — одна строка в пачке, побеждает последняя", async () => {
    // Цикл такое переживал молча (INSERT, потом UPDATE). Многострочный INSERT
    // отвечает «ON CONFLICT DO UPDATE command cannot affect row a second time»
    // и роняет приём ЦЕЛИКОМ — то есть весь сбор.
    const { db, inserts } = writeDb();
    const res = await new VendingService(db).ingestSlots({
      machines: [
        {
          serial: "ДУБЛЬ",
          slots: [
            { coilId: "1", product: "Старое", capacity: 5, quantity: 1 },
            { coilId: "1", product: "Новое", capacity: 6, quantity: 4 },
          ],
        },
      ],
    });
    const слоты = строкиТаблицы(inserts, "machine_slot");
    assert.equal(слоты.length, 1, "в одном запросе два ряда с одним ключом Postgres не примет");
    assert.equal(слоты[0]!.productName, "Новое");
    assert.equal(слоты[0]!.quantity, 4);
    // История дублей не боится — там уникального ключа нет, и счётчик считает всё.
    assert.equal(строкиТаблицы(inserts, "slot_snapshot").length, 2);
    assert.equal(res.slots, 2);
  });

  it("продажи тоже пачкой: один запрос на таблицу, массив строк", async () => {
    const { db, calls } = ingestSalesDb();
    const res = await new VendingService(db).ingestSales({
      capturedAt: "2026-08-24T04:00:00Z",
      periodStart: "2026-08-17T04:00:00Z",
      periodEnd: "2026-08-24T04:00:00Z",
      productSales: [
        { serial: "AH", product: "Montella", quantity: 5 },
        { serial: "AH", product: "Twix", quantity: 2 },
        { serial: "Olma", product: "Twix", quantity: 9 },
      ],
      machineSales: [
        { serial: "AH", totalAmount: 100, totalCount: 2 },
        { serial: "Olma", totalAmount: 200, totalCount: 3 },
      ],
    });
    assert.equal(res.productRows, 3);
    assert.equal(res.machineRows, 2);
    const товары = calls.filter((c) => c.table === "product_sale");
    const автоматы = calls.filter((c) => c.table === "machine_sale");
    assert.equal(товары.length, 1, "три продажи — один запрос");
    assert.equal(автоматы.length, 1);
    assert.equal((товары[0]!.values as unknown[]).length, 3);
    assert.equal((автоматы[0]!.values as unknown[]).length, 2);
    // Ключ идемпотентности прежний, значения — из своей строки пачки.
    assert.deepEqual(товары[0]!.target, [productSale.machineSerial, productSale.productName, productSale.capturedAt]);
    assert.match(текстSQL(товары[0]!.set.quantity), /excluded\.quantity/);
    assert.match(текстSQL(автоматы[0]!.set.totalAmount), /excluded\.total_amount/);
    assert.match(текстSQL(автоматы[0]!.set.totalCount), /excluded\.total_count/);
  });

  it("одна и та же пара (автомат, товар) дважды в батче — одна строка, побеждает последняя", async () => {
    // Ключ идемпотентности (автомат, товар, capturedAt) в одной пачке дважды
    // Postgres не примет; цикл раньше делал апдейт.
    const { db, calls } = ingestSalesDb();
    await new VendingService(db).ingestSales({
      capturedAt: "2026-08-24T04:00:00Z",
      periodStart: "2026-08-17T04:00:00Z",
      periodEnd: "2026-08-24T04:00:00Z",
      productSales: [
        { serial: "AH", product: "Montella", quantity: 5 },
        { serial: "AH", product: "Montella", quantity: 8 },
      ],
      machineSales: [
        { serial: "AH", totalAmount: 1, totalCount: 1 },
        { serial: "AH", totalAmount: 2, totalCount: 2 },
      ],
    });
    const товары = calls.find((c) => c.table === "product_sale")!.values as { quantity: number }[];
    assert.equal(товары.length, 1);
    assert.equal(товары[0]!.quantity, 8);
    const автоматы = calls.find((c) => c.table === "machine_sale")!.values as { totalCount: number }[];
    assert.equal(автоматы.length, 1);
    assert.equal(автоматы[0]!.totalCount, 2);
  });

  it("пустой список продаж не шлёт запрос вовсе (values([]) Postgres не примет)", async () => {
    const { db, calls } = ingestSalesDb();
    await new VendingService(db).ingestSales({
      periodStart: "2026-08-17T04:00:00Z",
      periodEnd: "2026-08-24T04:00:00Z",
      productSales: [{ serial: "AH", product: "Montella", quantity: 5 }],
      machineSales: [],
    });
    assert.equal(calls.filter((c) => c.table === "machine_sale").length, 0);
  });

  it("автомат больше пачки режется на части: 503 слота → 500 + 3, порядок цел", async () => {
    // Потолок пачки не декоративный: у самого крупного автомата парка 488
    // позиций, и он к нему вплотную. Ошибка в арифметике нарезки потеряла бы
    // хвост слотов молча — счётчик прогона при этом остался бы правильным.
    const много = Array.from({ length: INSERT_CHUNK + 3 }, (_, i) => ({
      coilId: String(i + 1),
      product: `Товар ${i + 1}`,
      capacity: 5,
      quantity: i % 5,
    }));
    const { db, inserts } = writeDb();
    const res = await new VendingService(db).ingestSlots({ machines: [{ serial: "БОЛЬШОЙ", slots: много }] });

    const пачкиСлотов = inserts.filter((i) => i.table === "machine_slot");
    const пачкиИстории = inserts.filter((i) => i.table === "slot_snapshot");
    assert.deepEqual(
      пачкиСлотов.map((i) => (i.values as unknown[]).length),
      [INSERT_CHUNK, 3],
      "первая пачка полная, во второй — остаток",
    );
    assert.deepEqual(пачкиИстории.map((i) => (i.values as unknown[]).length), [INSERT_CHUNK, 3]);

    // Ни одна строка не потерялась и не переехала: порядок сквозной.
    const слоты = строкиТаблицы(inserts, "machine_slot");
    assert.equal(слоты.length, INSERT_CHUNK + 3);
    assert.deepEqual(
      слоты.map((v) => v.coilId),
      много.map((s) => s.coilId),
    );
    // Стык пачек — то место, где нарезка врёт чаще всего.
    assert.equal(слоты[INSERT_CHUNK - 1]!.productName, `Товар ${INSERT_CHUNK}`);
    assert.equal(слоты[INSERT_CHUNK]!.productName, `Товар ${INSERT_CHUNK + 1}`);
    assert.equal(строкиТаблицы(inserts, "slot_snapshot").length, INSERT_CHUNK + 3);
    // Счётчики прогона считают ВЕСЬ вход, а не число запросов.
    assert.equal(res.slots, INSERT_CHUNK + 3);
    assert.equal(res.machines, 1);
  });

  it("склад тоже пачкой: две позиции — один запрос на таблицу", async () => {
    const { db, inserts } = writeDb();
    await new VendingService(db).ingestStock({
      items: [
        { product: "Montella", quantity: 24 },
        { product: "Twix", quantity: 12 },
      ],
    });
    // Два запроса ВСЕГО: остаток и история — по одному на таблицу, а не по
    // одному на позицию.
    assert.equal(inserts.length, 2, "две позиции — один запрос на таблицу");
    assert.equal(строкиТаблицы(inserts, "vending_stock").length, 2);
    assert.equal(строкиТаблицы(inserts, "vending_stock_count").length, 2);
  });
});

describe("Вендинг Core: журнал сбора — finishSyncRun (§ коллектор)", () => {
  /** Стаб: update(...).returning() отдаёт строку только если id "существует". */
  function syncRunDb(existingId: string | null) {
    const tx = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => (existingId ? [{ id: existingId }] : []),
          }),
        }),
      }),
    };
    return { update: tx.update } as never;
  }

  it("известный id — ok: true", async () => {
    const db = syncRunDb("run-1");
    const svc = new VendingService(db);
    const res = await svc.finishSyncRun("run-1", {
      status: "success",
      machinesTotal: 29,
      machinesOk: 25,
      durationMs: 1200,
    });
    assert.deepEqual(res, { ok: true });
  });

  it("неизвестный id — ok: false, а не молчаливый успех (найдено внешним аудитом, P2)", async () => {
    const db = syncRunDb(null);
    const svc = new VendingService(db);
    const res = await svc.finishSyncRun("no-such-id", {
      status: "failed",
      machinesTotal: 0,
      machinesOk: 0,
      durationMs: 500,
    });
    assert.deepEqual(res, { ok: false });
  });
});

describe("Вендинг Core: касса закупа (§5.8)", () => {
  /**
   * Стаб для recordCashSession: insert().values().returning() → строка с id
   * и createdAt (в реальной БД проставляется defaultNow(), .values() его не
   * передаёт — стаб должен достроить сам, иначе .toISOString() упадёт на undefined).
   */
  function cashInsertDb() {
    const inserted: Record<string, unknown>[] = [];
    const db = {
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          inserted.push(v);
          return { returning: async () => [{ id: "cs1", createdAt: new Date("2026-08-02T12:00:00Z"), ...v }] };
        },
      }),
    } as never;
    return { db, inserted };
  }

  it("воспроизводит реальную запись 02.08.2026 до сума и сохраняет снимок", async () => {
    const { db, inserted } = cashInsertDb();
    const svc = new VendingService(db);
    const res = await svc.recordCashSession(2_400_000, [
      { name: "корзинка", lines: [{ label: "47×2090", amount: 98_230 }] },
      { name: "базар", lines: [{ label: "снеки", amount: 376_300 }] },
      { name: "базар", lines: [{ label: "напитки", amount: 1_023_000 }] },
    ]);
    assert.equal(res.totalSpent, 1_497_530);
    assert.equal(res.remainder, 902_470);
    assert.equal(res.id, "cs1");
    // В базу уходят СТРОКОВЫЕ numeric (toFixed) — Postgres numeric ожидает текст, не число.
    assert.equal(inserted[0]!.receivedAmount, "2400000.00");
    assert.equal(inserted[0]!.remainder, "902470.00");
  });

  it("createdBy по умолчанию owner, можно переопределить", async () => {
    const { db, inserted } = cashInsertDb();
    await new VendingService(db).recordCashSession(100_000, [{ name: "базар", lines: [{ label: "X", amount: 10_000 }] }]);
    assert.equal(inserted[0]!.createdBy, "owner");

    const { db: db2, inserted: inserted2 } = cashInsertDb();
    await new VendingService(db2).recordCashSession(100_000, [], "manager");
    assert.equal(inserted2[0]!.createdBy, "manager");
  });

  it("cashSessions() читает numeric-строки как числа, свежие сверху", async () => {
    const rows = [
      {
        id: "cs2",
        receivedAmount: "2400000.00",
        categories: [{ name: "базар", lines: [], subtotal: 100 }],
        totalSpent: "1497530.00",
        remainder: "902470.00",
        createdBy: "owner",
        createdAt: new Date("2026-08-02T10:00:00Z"),
      },
    ];
    const db = { select: () => ({ from: () => ({ orderBy: () => ({ limit: async () => rows }) }) }) } as never;
    const list = await new VendingService(db).cashSessions();
    assert.equal(list[0]!.receivedAmount, 2_400_000);
    assert.equal(list[0]!.remainder, 902_470);
    assert.equal(list[0]!.createdAt, "2026-08-02T10:00:00.000Z");
  });
});

describe("Зеркало слотов умеет сокращаться", () => {
  it("исчезнувшие слоты убираются, а не живут вечно", async () => {
    // У 2508160376 вендор годами отдавал 488 позиций; после отсева фантомов их
    // 43. Upsert только добавляет и обновляет — без уборки в планограмме
    // навсегда остались бы 445 несуществующих слотов.
    const { db, pruneRows } = writeDb();
    pruneRows.push({ id: "s1" }, { id: "s2" });
    const svc = new VendingService(db);
    const res = await svc.ingestSlots({
      machines: [{ serial: "2508160376", slots: [{ coilId: "1", product: "Twix", capacity: 11, quantity: 9 }] }],
    });
    assert.equal(res.pruned, 2);
  });

  it("пустой список слотов планограмму НЕ стирает", async () => {
    // Пусто — это почти всегда сбой выгрузки, а не автомат, из которого вынули
    // все пружины. Стирать по молчанию источника значит терять данные без
    // единой ошибки.
    const { db, pruneRows } = writeDb();
    pruneRows.push({ id: "s1" }, { id: "s2" }, { id: "s3" });
    const svc = new VendingService(db);
    const res = await svc.ingestSlots({ machines: [{ serial: "ПУСТОЙ", slots: [] }] });
    assert.equal(res.pruned, 0, "уборка не должна была запуститься");
    assert.equal(res.slots, 0);
  });
});

describe("Сбой уборки не стоит снимка", () => {
  it("упавшая уборка НЕ откатывает записанные слоты", async () => {
    // 07.08.2026 уборка шла в одной транзакции с записью, и ошибка в условии
    // удаления откатывала INSERT: зеркало перестало обновляться вовсе, а не
    // просто не почистилось. Побочная функция утаскивала основную.
    const { db, inserts, failPrune } = writeDb();
    failPrune();
    const svc = new VendingService(db);
    const res = await svc.ingestSlots({
      machines: [{ serial: "2508160376", slots: [{ coilId: "1", product: "Twix", capacity: 11, quantity: 9 }] }],
    });

    assert.equal(res.slots, 1, "снимок обязан быть записан");
    assert.equal(строкиТаблицы(inserts, "machine_slot").length, 1);
    assert.equal(res.pruned, 0);
    assert.equal(res.pruneErrors.length, 1, "о сбое уборки молчать нельзя");
    assert.equal(res.pruneErrors[0]!.serial, "2508160376");
  });

  it("сбой уборки записывается событием, а не теряется", async () => {
    const { db, inserts, failPrune } = writeDb();
    failPrune();
    const svc = new VendingService(db);
    await svc.ingestSlots({
      machines: [{ serial: "M1", slots: [{ coilId: "1", product: "x", capacity: 1, quantity: 1 }] }],
    });
    const события = inserts.filter((i) => i.table === "event");
    assert.equal(события.length, 1);
    assert.equal((строкиВставок(события)[0]! as { type: string }).type, "vending.slots.prune_failed");
  });

  it("сбой на одном автомате не лишает уборки остальных", async () => {
    // Каждый автомат убирается своим запросом: общий try свёл бы всю пачку
    // к судьбе первой ошибки.
    const { db } = writeDb();
    const svc = new VendingService(db);
    const res = await svc.ingestSlots({
      machines: [
        { serial: "A", slots: [{ coilId: "1", product: "x", capacity: 1, quantity: 1 }] },
        { serial: "B", slots: [{ coilId: "1", product: "y", capacity: 1, quantity: 1 }] },
      ],
    });
    assert.equal(res.machines, 2);
    assert.equal(res.pruneErrors.length, 0);
  });
});

describe("Продажи Ourvend знают свой автомат", () => {
  it("привязка идёт по канону серийника: реестр с приставкой, вендор без", async () => {
    // Вопрос «сколько принёс ЭТОТ автомат» отвечался для mydon-stock и не
    // отвечался для Ourvend: product_sale и machine_sale несли только серийник.
    const { db, inserts } = writeDb([], [], [], [{ id: "ent-1", externalRef: "c2508160376" }]);
    const svc = new VendingService(db);
    await svc.ingestSales({
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-08-07T00:00:00.000Z",
      productSales: [{ serial: "2508160376", product: "Snickers", quantity: 5 }],
      machineSales: [{ serial: "2508160376", totalAmount: 561000, totalCount: 66 }],
    });
    const строки = строкиВставок(inserts).filter((v) => (v as { machineSerial?: string }).machineSerial === "2508160376");
    assert.ok(строки.length >= 2, "обе таблицы продаж должны получить строку");
    for (const r of строки) {
      assert.equal((r as { machineId: string | null }).machineId, "ent-1");
    }
  });

  it("продажа автомата без карточки ложится и ждёт", async () => {
    // Автомат появляется в Ourvend раньше карточки — так было с 2508160355
    // и 2508160358. Отвергать такую продажу значит терять выручку.
    const { db, inserts } = writeDb([], [], [], []);
    const svc = new VendingService(db);
    await svc.ingestSales({
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-08-07T00:00:00.000Z",
      productSales: [{ serial: "2508160355", product: "Twix", quantity: 1 }],
      machineSales: [],
    });
    const строка = строкиВставок(inserts).find((v) => (v as { productName?: string }).productName === "Twix")!;
    assert.equal((строка as { machineId: string | null }).machineId, null);
  });
});

describe("Вендинг Core: план закупа (П5a)", () => {
  type Card = CardRow;
  type Ent = EntRow;
  /** Стаб: слоты, склад, товары, карточки автоматов, настройки — по ссылке на таблицу. */
  function planDb(o: {
    slots: Row[];
    stock?: StockRow[];
    products?: ProdRow[];
    aliases?: AliasRow[];
    cards?: Card[];
    entities?: Ent[];
    config?: { key: string; value: string }[];
    sales?: SaleRow[];
  }) {
    return {
      select: () => ({
        from: (t: unknown) => {
          const rows: unknown[] =
            t === vendingAlias
              ? (o.aliases ?? [])
              : t === vendingProduct
                ? (o.products ?? [])
                : t === vendingStock
                  ? (o.stock ?? [])
                  : t === machineCard
                    ? (o.cards ?? [])
                    : t === entity
                      ? (o.entities ?? [])
                      : t === systemConfig
                        ? (o.config ?? [])
                        : t === productSale
                          ? (o.sales ?? [])
                          : o.slots;
          const p = Promise.resolve(rows);
          return { where: async () => rows, then: p.then.bind(p) };
        },
      }),
    } as never;
  }
  const slots: Row[] = [
    { machineSerial: "2508160376", coilId: "1", productName: "Fanta", capacity: 5, quantity: 1 },
    { machineSerial: "2508160359", coilId: "1", productName: "Fanta", capacity: 5, quantity: 3 },
    { machineSerial: "2508160355", coilId: "1", productName: "Fanta", capacity: 5, quantity: 0 }, // SKLAD 5S — warehouse
  ];
  const entities: Ent[] = [
    { id: "m-olma", name: "Olma", externalRef: "c2508160376", type: "machine" },
    { id: "m-ah", name: "American Hospital", externalRef: "c2508160359", type: "machine" },
    { id: "m-sk", name: "SKLAD 5S", externalRef: "c2508160355", type: "machine" },
  ];
  const cards: Card[] = [
    { entityId: "m-olma", status: "in_service" },
    { entityId: "m-ah", status: "in_service" },
    { entityId: "m-sk", status: "warehouse" },
  ];
  const products: ProdRow[] = [
    { id: "p1", name: "Fanta", purchasePrice: "5167", packSize: 12, excludedFromPurchase: false, fixedPurchaseQty: null },
  ];
  // Продажи обязательны: без них позиция уходит в «не закупать — нет продаж»
  // (§5.5), закуп по ней не считается и в автоматы грузится только склад.
  const sales: SaleRow[] = [
    { machineSerial: "2508160359", productName: "Fanta", quantity: 7, capturedAt: new Date("2026-08-20T00:00:00Z") },
  ];

  it("автомат не в строю пропущен и виден в warnings; маршрут из настройки; раздача по слотам", async () => {
    const db = planDb({
      slots,
      entities,
      cards,
      products,
      sales,
      stock: [{ productName: "Fanta", quantity: 2, countedAt: new Date() }],
      config: [{ key: "VENDING_ROUTE_ORDER", value: "2508160359,2508160376" }],
    });
    const plan = await new VendingService(db).plan();
    assert.deepEqual(plan.machines.map((m) => m.serial), ["2508160359", "2508160376"]);
    assert.equal(plan.machines[0]!.name, "American Hospital");
    assert.equal(plan.machines[0]!.routeIndex, 1);
    assert.ok(plan.warnings.some((w) => w.code === "machine_skipped" && w.message.includes("SKLAD 5S")));
    // need: AH 2, Olma 4 = 6; stock 2; order 12 → fromPurchase 6, склад не трогаем
    assert.equal(plan.summary.totalFromPurchase, 6);
    assert.equal(plan.summary.totalFromStock, 0);
    assert.equal(plan.machines[0]!.slots[0]!.fromPurchase, 2);
    assert.equal(plan.stock.totalBefore, 2);
    assert.equal(plan.stock.totalAfter, 2 + 6);
    assert.equal(plan.stock.stale, false);
  });

  it("склад старше 3 дней → warning stock_stale и stock.stale=true", async () => {
    const old = new Date(Date.now() - 4 * 86_400_000);
    const db = planDb({ slots, entities, cards, products, sales, stock: [{ productName: "Fanta", quantity: 2, countedAt: old }] });
    const plan = await new VendingService(db).plan();
    assert.equal(plan.stock.stale, true);
    assert.ok(plan.warnings.some((w) => w.code === "stock_stale"));
  });

  it("частичная инвентаризация: одна свежая строка не делает свежим весь склад", async () => {
    // `ingestStock` перезаписывает только присланные товары, поэтому частичный
    // пересчёт — норма. Давность обязана считаться по самой старой строке.
    const свежая = new Date();
    const старая = new Date(Date.now() - 5 * 86_400_000);
    // Cola обязана быть В ПРАЙСЕ: строка склада без карточки в расчёт вообще не
    // входит (её показывает отдельный warning stock_unknown_product), а речь
    // здесь про давность НАСТОЯЩЕГО остатка.
    const сCola: ProdRow[] = [
      ...products,
      { id: "p2", name: "Cola", purchasePrice: "5000", packSize: 12, excludedFromPurchase: false, fixedPurchaseQty: null },
    ];
    const частично = planDb({
      slots,
      entities,
      cards,
      products: сCola,
      sales,
      stock: [
        { productName: "Fanta", quantity: 2, countedAt: свежая },
        { productName: "Cola", quantity: 3, countedAt: старая },
      ],
    });
    const план = await new VendingService(частично).plan();
    assert.equal(план.stock.stale, true);
    assert.ok(план.warnings.some((w) => w.code === "stock_stale"));
    // Показываем при этом последнюю дату пересчёта — «когда считали хоть что-то».
    assert.equal(план.stock.asOf, свежая.toISOString());

    const всёСвежее = planDb({
      slots,
      entities,
      cards,
      products: сCola,
      sales,
      stock: [
        { productName: "Fanta", quantity: 2, countedAt: свежая },
        { productName: "Cola", quantity: 3, countedAt: свежая },
      ],
    });
    const второй = await new VendingService(всёСвежее).plan();
    assert.equal(второй.stock.stale, false);
    assert.ok(!второй.warnings.some((w) => w.code === "stock_stale"));
  });

  it("дубль карточки по серийнику не гасит живой автомат", async () => {
    // Забытая вторая карточка с тем же серийником и статусом «на складе» не
    // должна молча убирать автомат из закупа: первая карточка выигрывает
    // целиком — и имя, и состояние.
    const сДублем: Ent[] = [...entities, { id: "m-ah-dubl", name: "American Hospital (старая карточка)", externalRef: "c2508160359", type: "machine" }];
    const карточки: Card[] = [...cards, { entityId: "m-ah-dubl", status: "warehouse" }];
    const db = planDb({ slots, entities: сДублем, cards: карточки, products, sales });
    const plan = await new VendingService(db).plan();
    assert.ok(plan.machines.some((m) => m.serial === "2508160359"), "живой автомат остался в плане");
    assert.equal(plan.machines.find((m) => m.serial === "2508160359")!.name, "American Hospital");
    assert.ok(!plan.warnings.some((w) => w.message.includes("American Hospital")), "дубль не должен давать machine_skipped");
  });

  it("без настройки маршрут — по имени автомата", async () => {
    // Маршрут резолвится «база → env → дефолт», поэтому выставленная в
    // окружении переменная покрасила бы тест в красный без единой правки кода.
    const было = process.env.VENDING_ROUTE_ORDER;
    delete process.env.VENDING_ROUTE_ORDER;
    try {
      const db = planDb({ slots, entities, cards, products, sales });
      const plan = await new VendingService(db).plan();
      assert.deepEqual(plan.machines.map((m) => m.name), ["American Hospital", "Olma"]);
    } finally {
      if (было === undefined) delete process.env.VENDING_ROUTE_ORDER;
      else process.env.VENDING_ROUTE_ORDER = было;
    }
  });

  it("исключённый товар уходит в excludedByRule и не попадает в items", async () => {
    const prods: ProdRow[] = [
      { id: "p1", name: "Fanta", purchasePrice: "5167", packSize: 12, excludedFromPurchase: true, fixedPurchaseQty: null },
    ];
    const db = planDb({ slots, entities, cards, products: prods, sales });
    const plan = await new VendingService(db).plan();
    assert.equal(plan.summary.items.length, 0);
    assert.equal(plan.summary.excludedByRule[0]!.product, "Fanta");
  });

  it("строка склада без карточки прайса: в расчёт не входит, видна отдельно (C2)", async () => {
    // Осиротевшая строка («MOXITO FRESH LIMON CAN 0.5» до появления алиаса) не
    // вычитается из потребности — иначе план верит имени, которого не знает, —
    // но и молчать нельзя: владелец купит второй раз то, что лежит на складе.
    const db = planDb({
      slots,
      entities,
      cards,
      products,
      sales,
      stock: [
        { productName: "Fanta", quantity: 2, countedAt: new Date() },
        { productName: "MOXITO FRESH LIMON CAN 0.5", quantity: 7, countedAt: new Date() },
      ],
    });
    const plan = await new VendingService(db).plan();
    assert.equal(plan.stock.totalBefore, 2, "чужие штуки не попадают в остаток плана");
    assert.equal(plan.stock.unmatched, 7);
    const w = plan.warnings.find((x) => x.code === "stock_unknown_product")!;
    assert.match(w.message, /MOXITO FRESH LIMON CAN 0\.5/);
    assert.match(w.message, /переименуй в боте/);
  });

  it("алиас спасает строку склада: остаток резолвится в канон и вычитается (C1)", async () => {
    const aliases: AliasRow[] = [{ productId: "p1", alias: "Фанта банка" }];
    const db = planDb({
      slots,
      entities,
      cards,
      products,
      sales,
      aliases,
      stock: [{ productName: "Фанта банка", quantity: 2, countedAt: new Date() }],
    });
    const plan = await new VendingService(db).plan();
    assert.equal(plan.stock.unmatched, 0);
    assert.equal(plan.stock.totalBefore, 2);
    assert.equal(plan.summary.items[0]!.stock, 2);
    assert.ok(!plan.warnings.some((w) => w.code === "stock_unknown_product"));
  });

  it("свежая используемая строка склада не гаснет из-за старой неиспользуемой (5.6)", async () => {
    // Исключённый товар грузится ТОЛЬКО складом — его строка планом реально
    // используется. Старый остаток товара, который в поход не едет, давности
    // плана не касается: предупреждение, которое горит всегда, не читают.
    const свежая = new Date();
    const старая = new Date(Date.now() - 9 * 86_400_000);
    const prods: ProdRow[] = [
      { id: "p1", name: "Fanta", purchasePrice: "5167", packSize: 12, excludedFromPurchase: true, fixedPurchaseQty: null },
      { id: "p2", name: "Cola", purchasePrice: "5000", packSize: 12, excludedFromPurchase: false, fixedPurchaseQty: null },
    ];
    const db = planDb({
      slots,
      entities,
      cards,
      products: prods,
      sales,
      stock: [
        { productName: "Fanta", quantity: 4, countedAt: свежая },
        { productName: "Cola", quantity: 3, countedAt: старая },
      ],
    });
    const plan = await new VendingService(db).plan();
    assert.ok(plan.summary.excludedByRule[0]!.fromStock > 0, "склад по Fanta реально используется");
    assert.equal(plan.stock.stale, false);
    assert.ok(!plan.warnings.some((w) => w.code === "stock_stale"));
  });

  it("склад устарел: в сообщении число позиций, имена и подсказка «в боте»", async () => {
    const старая = new Date(Date.now() - 4 * 86_400_000);
    const db = planDb({ slots, entities, cards, products, sales, stock: [{ productName: "Fanta", quantity: 2, countedAt: старая }] });
    const w = (await new VendingService(db).plan()).warnings.find((x) => x.code === "stock_stale")!;
    assert.match(w.message, /1 поз\. старше 3 дней \(Fanta\)/);
    assert.match(w.message, /обнови в боте/);
  });

  it("склада не было вовсе — сказано прямо, что план покупает весь дефицит", async () => {
    const db = planDb({ slots, entities, cards, products, sales });
    const w = (await new VendingService(db).plan()).warnings.find((x) => x.code === "stock_stale")!;
    assert.match(w.message, /ни разу не считали/);
    assert.match(w.message, /покупает весь дефицит/);
  });

  it("продажи: несвежий батч и неполный охват автоматов — два разных предупреждения (I3)", async () => {
    // Батч 5 дней назад и только по одному ok-автомату из двух: «нет продаж»
    // по остальным ложное, а на нём держится всё решение «не закупать».
    const давние: SaleRow[] = [
      { machineSerial: "2508160359", productName: "Fanta", quantity: 7, capturedAt: new Date(Date.now() - 5 * 86_400_000) },
    ];
    const plan = await new VendingService(planDb({ slots, entities, cards, products, sales: давние })).plan();
    assert.match(plan.warnings.find((w) => w.code === "sales_stale")!.message, /Продажи собраны 5 дн\. назад/);
    // Автомат назван ИМЕНЕМ: «1 автоматов из 2» не говорило, какой из них
    // искать, и владельцу оставалось сверять серийники вручную (П5b-1).
    assert.equal(
      plan.warnings.find((w) => w.code === "sales_partial")!.message,
      "В свежем батче продаж нет автоматов: Olma — по ним «нет продаж» может быть ложным",
    );
  });

  it("автомата без потребности в батче продаж — предупреждения нет (П5b-1)", async () => {
    // Полный автомат продаж мог и не прислать, и «нет продаж» по нему ничего
    // не решает: прежнее «в батче меньше, чем в расчёте» горело на ровном месте.
    const полный: Row[] = slots.map((r) =>
      r.machineSerial === "2508160376" ? { ...r, quantity: 5 } : r,
    );
    const толькоAH: SaleRow[] = [
      { machineSerial: "2508160359", productName: "Fanta", quantity: 7, capturedAt: new Date() },
    ];
    const plan = await new VendingService(
      planDb({ slots: полный, entities, cards, products, sales: толькоAH }),
    ).plan();
    assert.equal(plan.machines.find((m) => m.serial === "2508160376")!.need, 0);
    assert.ok(!plan.warnings.some((w) => w.code === "sales_partial"));
  });

  it("порог свежести продаж — в миллисекундах: 2 дн. 1 ч уже несвежие, 1 день — нет", async () => {
    // Округление до целых суток ПЕРЕД сравнением теряло почти день: батч
    // возрастом 2 дн. 23 ч молчал, хотя порог — 2 суток.
    const батч = (мс: number): SaleRow[] => [
      { machineSerial: "2508160359", productName: "Fanta", quantity: 7, capturedAt: new Date(Date.now() - мс) },
      { machineSerial: "2508160376", productName: "Fanta", quantity: 3, capturedAt: new Date(Date.now() - мс) },
    ];
    const несвежий = await new VendingService(
      planDb({ slots, entities, cards, products, sales: батч(2 * 86_400_000 + 3_600_000) }),
    ).plan();
    assert.match(несвежий.warnings.find((w) => w.code === "sales_stale")!.message, /Продажи собраны 2 дн\. назад/);

    const свежий = await new VendingService(planDb({ slots, entities, cards, products, sales: батч(86_400_000) })).plan();
    assert.ok(!свежий.warnings.some((w) => w.code === "sales_stale"));
  });

  it("продажи собраны сегодня по всем автоматам — предупреждений о продажах нет", async () => {
    const сегодня: SaleRow[] = [
      { machineSerial: "2508160359", productName: "Fanta", quantity: 7, capturedAt: new Date() },
      { machineSerial: "2508160376", productName: "Fanta", quantity: 3, capturedAt: new Date() },
    ];
    const plan = await new VendingService(planDb({ slots, entities, cards, products, sales: сегодня })).plan();
    assert.ok(!plan.warnings.some((w) => w.code === "sales_stale" || w.code === "sales_partial"));
  });

  it("продаж не собирали ни разу — сказано, что «нет продаж» стоит у всех", async () => {
    const plan = await new VendingService(planDb({ slots, entities, cards, products })).plan();
    assert.match(plan.warnings.find((w) => w.code === "sales_stale")!.message, /ни разу не собирались/);
  });

  it("маршрут: незнакомый серийник настройки виден, порядок берётся по имени (A4/UX#16)", async () => {
    const db = planDb({
      slots,
      entities,
      cards,
      products,
      sales,
      config: [{ key: "VENDING_ROUTE_ORDER", value: "2508160376, 9999999999" }],
    });
    const plan = await new VendingService(db).plan();
    const w = plan.warnings.find((x) => x.code === "route_unknown_serial")!;
    assert.match(w.message, /9999999999/);
    assert.match(w.message, /порядок взят по имени/);
    assert.equal(plan.routeConfigured, true);
    assert.deepEqual(plan.machines.map((m) => m.serial), ["2508160376", "2508160359"]);
  });

  it("маршрут: форма серийника с «c» в настройке и без неё в слотах — одно и то же (5.8)", async () => {
    const db = planDb({
      slots,
      entities,
      cards,
      products,
      sales,
      config: [{ key: "VENDING_ROUTE_ORDER", value: "2508160376" }],
    });
    // В слотах серийник приходит с приставкой — как его пишет mydon-stock.
    const сПриставкой: Row[] = slots.map((r) =>
      r.machineSerial === "2508160376" ? { ...r, machineSerial: "c2508160376" } : r,
    );
    const план = await new VendingService(planDb({ slots: сПриставкой, entities, cards, products, sales, config: [{ key: "VENDING_ROUTE_ORDER", value: "2508160376" }] })).plan();
    assert.equal(план.machines[0]!.serial, "c2508160376", "первым идёт автомат из настройки, в форме слотов");
    assert.ok(!план.warnings.some((w) => w.code === "route_unknown_serial"));
    // И зеркально: настройка без «c», слоты без «c» — прежнее поведение цело.
    const прямой = await new VendingService(db).plan();
    assert.equal(прямой.machines[0]!.serial, "2508160376");
  });

  it("маршрут не задан — routeConfigured=false и предупреждения нет", async () => {
    const было = process.env.VENDING_ROUTE_ORDER;
    delete process.env.VENDING_ROUTE_ORDER;
    try {
      const plan = await new VendingService(planDb({ slots, entities, cards, products, sales })).plan();
      assert.equal(plan.routeConfigured, false);
      assert.ok(!plan.warnings.some((w) => w.code === "route_unknown_serial"));
    } finally {
      if (было === undefined) delete process.env.VENDING_ROUTE_ORDER;
      else process.env.VENDING_ROUTE_ORDER = было;
    }
  });

  it("автоматы не в строю — ОДНА строка со всеми именами и состояниями (UX#10/П5b-2)", async () => {
    // На проде три SKLAD-автомата давали по строке каждый — в каждом плане и
    // навсегда. Предупреждение, которое горит всегда и втроём, не читают, а
    // вместе с ним перестают читать соседние.
    const сЧетвёркой: Row[] = [
      ...slots,
      { machineSerial: "2508160354", coilId: "1", productName: "Fanta", capacity: 5, quantity: 0 },
    ];
    const ент: Ent[] = [...entities, { id: "m-sk4", name: "SKLAD 4S", externalRef: "c2508160354", type: "machine" }];
    const крт: Card[] = [...cards, { entityId: "m-sk4", status: "repair" }];
    const plan = await new VendingService(planDb({ slots: сЧетвёркой, entities: ент, cards: крт, products, sales })).plan();
    const строки = plan.warnings.filter((w) => w.code === "machine_skipped");
    assert.equal(строки.length, 1, "одна строка на все пропущенные автоматы");
    // Порядок — по имени (в слотах 5S идёт раньше 4S), состояние — словами
    // владельца, а не машинным warehouse/repair.
    assert.equal(строки[0]!.message, "Не в строю, в план не вошли: SKLAD 4S (В ремонте), SKLAD 5S (На складе)");
  });

  it("тексты «без цены» и «нет в прайсе» говорят, что делать, и не дублируют друг друга (UX#11/#12, П5b-6)", async () => {
    // «Загадка» — товар БЕЗ карточки, «Qurt» — карточка есть, цены нет. Товар
    // без карточки попадал в оба списка сразу, и владелец читал про него две
    // строки подряд с разными советами; «задай цену» по нему невыполнимо —
    // цену вешать не на что.
    const без: Row[] = [
      ...slots,
      { machineSerial: "2508160376", coilId: "2", productName: "Загадка", capacity: 5, quantity: 0 },
      { machineSerial: "2508160376", coilId: "3", productName: "Qurt", capacity: 5, quantity: 0 },
    ];
    const сQurt: ProdRow[] = [
      ...products,
      { id: "p3", name: "Qurt", purchasePrice: null, packSize: 10, excludedFromPurchase: false, fixedPurchaseQty: null },
    ];
    const продажи: SaleRow[] = [
      ...sales,
      { machineSerial: "2508160359", productName: "Загадка", quantity: 3, capturedAt: new Date("2026-08-20T00:00:00Z") },
      { machineSerial: "2508160359", productName: "Qurt", quantity: 3, capturedAt: new Date("2026-08-20T00:00:00Z") },
    ];
    const plan = await new VendingService(planDb({ slots: без, entities, cards, products: сQurt, sales: продажи })).plan();
    const безЦены = plan.warnings.find((w) => w.code === "no_price")!;
    assert.match(безЦены.message, /в сумму закупа не вошли.*цена <товар> <сум за штуку>/s);
    assert.match(безЦены.message, /Qurt/);
    assert.doesNotMatch(безЦены.message, /Загадка/, "товар без карточки живёт в unknown_product, и только там");
    assert.match(
      plan.warnings.find((w) => w.code === "unknown_product")!.message,
      /Нет в прайсе вендинга: Загадка.*карточку заводит администратор/s,
    );
    // Позиций без цены больше нет вовсе — предупреждения тоже быть не должно.
    const толькоЗагадка = await new VendingService(
      planDb({
        slots: без.filter((r) => r.productName !== "Qurt"),
        entities,
        cards,
        products,
        sales: продажи,
      }),
    ).plan();
    assert.ok(!толькоЗагадка.warnings.some((w) => w.code === "no_price"));
  });

  it("строка склада с двойным пробелом резолвится в карточку и вычитается из потребности (П5b-5)", async () => {
    // `vending_stock` ключуется ИМЕНЕМ, и «Red  Bull» из копипасты объявлялся
    // осиротевшим при живой карточке «Red Bull»: остаток не вычитался, и
    // владелец покупал второй раз то, что лежит на складе.
    const редбул: ProdRow[] = [
      { id: "p9", name: "Red Bull CAN 0,25", purchasePrice: "12000", packSize: 6, excludedFromPurchase: false, fixedPurchaseQty: null },
    ];
    const слоты: Row[] = [
      { machineSerial: "2508160376", coilId: "1", productName: "Red Bull CAN 0,25", capacity: 5, quantity: 1 },
    ];
    const продажи: SaleRow[] = [
      { machineSerial: "2508160376", productName: "Red Bull CAN 0,25", quantity: 7, capturedAt: new Date() },
    ];
    const plan = await new VendingService(
      planDb({
        slots: слоты,
        entities,
        cards,
        products: редбул,
        sales: продажи,
        stock: [{ productName: "Red  Bull CAN 0,25", quantity: 2, countedAt: new Date() }],
      }),
    ).plan();
    assert.equal(plan.stock.unmatched, 0);
    assert.equal(plan.stock.totalBefore, 2);
    assert.ok(!plan.warnings.some((w) => w.code === "stock_unknown_product"));
    const позиция = plan.summary.items.find((i) => i.product === "Red Bull CAN 0,25")!;
    assert.equal(позиция.stock, 2); // need 4 − склад 2 = купить 2
    assert.equal(позиция.buy, 2);
  });

  it("фикс-количество товара уходит в order как есть, без округления до блока", async () => {
    // Правило владельца («СуперКонтик 50»): закупаем ровно фикс, а не кратное
    // блоку. Проверяем весь путь колонка → rulesByName → computePurchase.
    const сФиксом: ProdRow[] = [
      { id: "p1", name: "Fanta", purchasePrice: "5167", packSize: 12, excludedFromPurchase: false, fixedPurchaseQty: 50 },
    ];
    const db = planDb({ slots, entities, cards, products: сФиксом, sales });
    const plan = await new VendingService(db).plan();
    const позиция = plan.summary.items[0]!;
    assert.equal(позиция.fixedQty, 50);
    assert.equal(позиция.order, 50); // не 60 = ceil(6/12)×12
    assert.equal(позиция.fromPurchase, 6); // в автоматы — по потребности
    assert.equal(plan.stock.back, 44); // остальное закупа уезжает на склад
  });

  it("автомат-заглушка (ёмкости вне диапазона) выброшен из плана и виден в warnings (R-P4-4)", async () => {
    // SKLAD-заглушки отдают quantity = capacity = 199 по всем пружинам. Раньше
    // такой автомат просто не появлялся в плане (не проходил калибровку) — молча.
    const мёртвые: Row[] = Array.from({ length: 10 }, (_, i) => ({
      machineSerial: "2508160358",
      coilId: String(i + 1),
      productName: "Fanta",
      capacity: 199,
      quantity: 199,
    }));
    const реестр: Ent[] = [...entities, { id: "m-dead", name: "SKLAD 6S", externalRef: "c2508160358", type: "machine" }];
    const db = planDb({ slots: [...slots, ...мёртвые], entities: реестр, cards, products, sales });
    const plan = await new VendingService(db).plan();

    assert.ok(!plan.machines.some((m) => m.serial === "2508160358"), "автомат-заглушка не получает раздачу");
    const w = plan.warnings.find((x) => x.code === "machine_skipped" && x.message.includes("SKLAD 6S"))!;
    assert.match(w.message, /ёмкости слотов вне диапазона \(заглушка источника\)/);
    // Причина не подменяется состоянием карточки: автомат числится в строю.
    assert.ok(!/не в строю/.test(w.message));
  });

  it("только что заправленный автомат (ВСЕ слоты полны) остаётся в плане", async () => {
    // Ложное срабатывание прежнего правила «все валидные слоты полны»: у этого
    // автомата нет ни одного неполного слота, и старое правило выбросило бы его
    // из плана, продаж и прогноза на часы после заправки. Отдельный серийник —
    // намеренно: в базовой фикстуре у 2508160359 есть слот 3/5, и он маскировал
    // бы регрессию.
    const полный: Row[] = Array.from({ length: 12 }, (_, i) => ({
      machineSerial: "2508160357",
      coilId: String(i + 1),
      productName: "Fanta",
      capacity: 5,
      quantity: 5,
    }));
    const реестр: Ent[] = [...entities, { id: "m-full", name: "Olma 2", externalRef: "c2508160357", type: "machine" }];
    const db = planDb({ slots: [...slots, ...полный], entities: реестр, cards, products, sales });
    const plan = await new VendingService(db).plan();
    assert.ok(plan.machines.some((m) => m.serial === "2508160357"), "полный автомат — обслуженный, а не мёртвый");
    assert.ok(!plan.warnings.some((x) => x.code === "machine_skipped" && x.message.includes("Olma 2")));
  });
});

describe("Вендинг Core: правила товара (П5a)", () => {
  it("меняет блок/исключение/фикс в транзакции с событием и аудитом; 0 снимает фикс", async () => {
    const { db, updates, events, audits } = priceDb({
      id: "p1",
      name: "TUC",
      purchasePrice: null,
      packSize: 10,
      excludedFromPurchase: false,
      fixedPurchaseQty: 5,
    });
    const res = await new VendingService(db).setProductRules(
      "TUC",
      { packSize: 5, excludedFromPurchase: true, fixedPurchaseQty: 0 },
      "owner",
    );
    assert.equal(res.ok, true);
    assert.deepEqual(updates[0], { packSize: 5, excludedFromPurchase: true, fixedPurchaseQty: null, updatedAt: updates[0]!.updatedAt });
    assert.equal(events[0]!.type, "vending.product_rules_changed");
    assert.equal(audits[0]!.action, "vending.product.set_rules");
  });

  it("товар не найден → not_found", async () => {
    const { db } = priceDb(null);
    const res = await new VendingService(db).setProductRules("Нет такого", { packSize: 5 });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "not_found");
  });

  it("имя с двойным пробелом находит карточку (нормализация, а не lower())", async () => {
    // «блок Red  Bull CAN 0,25 6» — реальный ввод из чата. SQL по lower()
    // промахивался ровно мимо тех имён, ради которых заведён
    // normalizeProductName, и владелец получал «товар не найден» на товар,
    // который в прайсе есть. productRow=null: SQL-путь заведомо пуст.
    const { db, updates } = priceDb(null, [], [
      { id: "p9", name: "Red Bull CAN 0,25", purchasePrice: "16500", packSize: 12, excludedFromPurchase: false, fixedPurchaseQty: null },
    ]);
    const res = await new VendingService(db).setProductRules("Red  Bull CAN 0,25", { packSize: 6 });
    assert.equal(res.ok, true);
    assert.equal(res.product, "Red Bull CAN 0,25");
    assert.equal(updates[0]!.packSize, 6);
  });

  it("та же нормализация в команде цены", async () => {
    const { db, updates } = priceDb(null, [], [
      { id: "p9", name: "Red Bull CAN 0,25", purchasePrice: null, packSize: 12, excludedFromPurchase: false, fixedPurchaseQty: null },
    ]);
    const res = await new VendingService(db).setProductPrice("Red  Bull CAN 0,25", 16000);
    assert.equal(res.ok, true);
    assert.equal(res.product, "Red Bull CAN 0,25");
    assert.equal(updates[0]!.purchasePrice, "16000.00");
  });
});

describe("Вендинг Core: заявка хранит разбивку по автоматам (П5a)", () => {
  // Тот же стаб, что в describe «отправка закупа на утверждение (§5.7)» выше: purchaseDb + очередь согласований.
  const t = new Date("2026-08-02T00:00:00Z");
  const slots: Row[] = [
    { machineSerial: "AH", coilId: "1", productName: "Montella", capacity: 6, quantity: 2 },
    { machineSerial: "OL", coilId: "1", productName: "Montella", capacity: 6, quantity: 3 },
  ];
  const sales: SaleRow[] = [{ machineSerial: "AH", productName: "Montella", quantity: 14, capturedAt: t }];
  const products: ProdRow[] = [{ name: "Montella", purchasePrice: "5000.00", packSize: 12 }];

  it("positions содержат perMachine/fromPurchase/fromStock/unfilled", async () => {
    const requests: { payload?: Record<string, unknown> }[] = [];
    const svc = {
      request: async (input: { payload?: Record<string, unknown> }) => {
        requests.push(input);
        return { id: "ap-1" };
      },
    };
    const vending = new VendingService(purchaseDb(slots, sales, products), svc as never);
    await vending.submitPurchase("owner");
    const po = (requests[0]!.payload as { purchaseOrder: { positions: Record<string, unknown>[] } }).purchaseOrder;
    const pos = po.positions[0]!;
    assert.deepEqual(pos.perMachine, { AH: 4, OL: 3 });
    assert.equal(pos.fromPurchase, 7); // need 7, склад 0, order 12 → в автоматы 7
    assert.equal(pos.fromStock, 0);
    assert.equal(pos.unfilled, 0);
    assert.deepEqual(
      Object.keys(pos).sort(),
      ["buy", "costRounded", "fromPurchase", "fromStock", "noPrice", "order", "pack", "perMachine", "price", "product", "unfilled"],
    );
  });
});

describe("Позиции накладной из jsonb: ОДИН разбор и ОДИН гейт цены (R-P5b-10)", () => {
  it("имя и штуки обязательны — приёмка такую позицию не зачисляет ни на склад, ни в деньги", () => {
    assert.deepEqual(
      parseOrderPositions([
        { product: "TUC Sour cream", order: 10, price: 13_000 },
        { product: "  ", order: 5, price: 1000 },
        { product: "Без штук", order: 0, price: 1000 },
        { product: "Дробные штуки", order: 3.9, price: 1000 },
        { order: 7, price: 1000 },
        null,
      ]),
      [
        { product: "TUC Sour cream", qty: 10, price: 13_000 },
        { product: "Дробные штуки", qty: 3, price: 1000 },
      ],
    );
  });

  it("гейт цены один на всех: ноль, мусор и заоблачное число — это «цены нет», а не деньги", () => {
    // Раньше сводка принимала любое число > 0, а аналитика резала на 10 млн:
    // мусорная позиция ехала в деньги письма, но не в себестоимость отчёта.
    assert.deepEqual(
      parseOrderPositions([
        { product: "a", order: 1, price: 0 },
        { product: "b", order: 1, price: -5 },
        { product: "c", order: 1, price: "13000" },
        { product: "d", order: 1, price: MAX_POSITION_PRICE + 1 },
        { product: "e", order: 1, price: MAX_POSITION_PRICE },
      ]).map((p) => p.price),
      [null, null, null, null, MAX_POSITION_PRICE],
    );
  });

  it("не массив — пусто, а не падение: jsonb схемы не имеет", () => {
    assert.deepEqual(parseOrderPositions(null), []);
    assert.deepEqual(parseOrderPositions({ product: "a" }), []);
  });
});

// ── Эталон витрины и наблюдение закупочных цен (П5b) ────────────────────────

/** Продажа как её видит `sale`: сутки Ташкента, канон серийника, штуки и сумма. */
type SaleFactRow = { dt: string; machineSerial: string; product: string; qty: string; amount: string };
type OrderFactRow = { id: string; status: string; positions: unknown[] };
/** Снек-автомат Olma — тот же серийник, что в остальных наборах П4/П5. */
const OLMA = "2508160376";

/**
 * Стаб БД среза П5b: прайс + продажи + накладная, вставки и апдейты копятся.
 *
 * `where()` НЕ фильтрует — заглушка SQL не исполняет: окно 14 суток и
 * `lower(name)` проверяет дымовой прогон против живого Postgres. Зато событий
 * и записей журнала здесь ровно столько, сколько их напишет сервис, и это
 * главное: молчаливая потеря события — та ошибка, ради которой стаб и заведён.
 */
function мир(opts: {
  products?: ProdRow[];
  sales?: SaleFactRow[];
  aliases?: AliasRow[];
  orders?: OrderFactRow[];
  /** Реестр автоматов: по умолчанию один Olma в строю — иначе продажи некому приписать. */
  machines?: EntRow[];
  /** Карточки состояния: пусто — все в строю (DEFAULT_MACHINE_STATUS). */
  cards?: CardRow[];
  /**
   * Что случилось с прайсом МЕЖДУ чтением и записью: зовётся один раз, перед
   * самым первым `UPDATE vending_product`. Так воспроизводится гонка —
   * владелец задал эталон командой, пока бутстрап считал факт витрины.
   */
  передЗаписью?: (products: ProdRow[]) => void;
}) {
  const sales = opts.sales ?? [];
  const aliases = opts.aliases ?? [];
  const order = opts.orders?.[0] ?? null;
  const machines = opts.machines ?? [{ id: "m-olma", name: "Olma Администрация", externalRef: OLMA, type: "machine" }];
  const cards = opts.cards ?? [];
  // `is_active` в базе NOT NULL с дефолтом `true`; фикстуры пишут его только
  // там, где речь про снятый товар.
  const products = (opts.products ?? []).map((p) => ({ isActive: true, ...p }));
  const updates: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const audit: Record<string, unknown>[] = [];
  const purchases: Record<string, unknown>[] = [];
  const stockUpserts: Record<string, unknown>[] = [];

  /** Сколько РАЗ звали insert по таблице — им и видно пачку против N вставок. */
  const вставок = new Map<string, number>();
  /** Вставка пачкой = столько же строк, сколько отдельными вызовами. */
  const принять = (table: unknown, v: unknown) => {
    const rows = (Array.isArray(v) ? v : [v]) as Record<string, unknown>[];
    const имя = table === event ? "event" : table === auditLog ? "audit" : table === purchase ? "purchase" : "stock";
    вставок.set(имя, (вставок.get(имя) ?? 0) + 1);
    if (table === event) events.push(...rows);
    else if (table === auditLog) audit.push(...rows);
    else if (table === purchase) purchases.push(...rows);
    else if (table === vendingStock) stockUpserts.push(...rows);
  };

  const строки = (t: unknown): unknown[] =>
    t === vendingAlias
      ? aliases
      : t === vendingProduct
        ? products
        : t === sale
          ? sales
          : t === entity
            ? machines
            : t === machineCard
              ? cards
              : [];

  /** Условие, с которым читались продажи, — им проверяются границы окна. */
  const условиеПродаж: unknown[] = [];

  const выборка = (t: unknown) => {
    const p = Promise.resolve(строки(t));
    const where = (cond?: unknown) => {
      if (t === sale) условиеПродаж.push(cond);
      const q = Promise.resolve(строки(t));
      // limit(1) — запасной путь поиска карточки по lower(name): стаб его не
      // умеет, и это правильно — канон обязан находиться в загруженном прайсе.
      return { limit: async () => [], orderBy: () => ({ limit: async () => [] }), then: q.then.bind(q) };
    };
    return { where, then: p.then.bind(p) };
  };

  let гонкаСыграна = false;
  /**
   * `UPDATE vending_product ... WHERE id = ? [AND sale_price IS NULL]` — как
   * его исполнил бы Postgres.
   *
   * Условный вариант (бутстрап) обязан вернуть ПУСТО, если эталон у строки уже
   * стоит: именно на этом держится защита от гонки, и стаб, всегда отдающий
   * строку, проверял бы ровно противоположное поведению базы.
   */
  const обновитьПрайс = (cond: unknown, v: Record<string, unknown>): Record<string, unknown>[] => {
    if (!гонкаСыграна) {
      гонкаСыграна = true;
      opts.передЗаписью?.(products as ProdRow[]);
    }
    const id = параметрыSQL(cond).find((x): x is string => typeof x === "string");
    const строка = products.find((p) => p.id === id);
    if (!строка) return [];
    if (текстSQL(cond).includes("is null") && строка.salePrice !== null) return [];
    Object.assign(строка, v);
    return [{ ...строка }];
  };

  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (order ? [order] : []),
          orderBy: () => ({ limit: async () => (order ? [order] : []) }),
        }),
      }),
    }),
    update: (t: unknown) => ({
      set: (v: Record<string, unknown>) => ({
        where: (cond?: unknown) => {
          updates.push({ table: t, ...v });
          const rows = t === vendingProduct ? обновитьПрайс(cond, v) : order ? [{ ...order, ...v }] : [];
          const p = Promise.resolve(rows);
          return { returning: async () => rows, then: p.then.bind(p) };
        },
      }),
    }),
    insert: (t: unknown) => ({
      values: (v: unknown) => {
        принять(t, v);
        return {
          onConflictDoUpdate: async () => undefined,
          onConflictDoNothing: async () => undefined,
          then: (res: (x: undefined) => unknown) => Promise.resolve(undefined).then(res),
        };
      },
    }),
  };

  const db = {
    select: () => ({ from: (t: unknown) => выборка(t) }),
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
  } as never;
  /**
   * То, что после записи сделала бы база: проставить эталон записанным
   * товарам. Нужно для повторного прогона бутстрапа — без этого «второй раз
   * ничего не пишем» проверялось бы на мире, где первый прогон как будто не
   * случился.
   */
  const применить = (записанные: readonly { product: string; price: number }[]) => {
    for (const x of записанные) {
      const строка = products.find((p) => p.name === x.product);
      if (строка) строка.salePrice = x.price.toFixed(2);
    }
  };

  return {
    db,
    service: new VendingService(db),
    updates,
    events,
    audit,
    purchases,
    stockUpserts,
    вставок,
    применить,
    /** Границы окна продаж, как их увидел Postgres: `[from, to]`. */
    окноПродаж: () => параметрыSQL(условиеПродаж.at(-1)),
  };
}

/**
 * Значения параметров drizzle-условия (`and(gte(dt, from), lte(dt, to))`).
 *
 * Заглушка `where()` условие не ИСПОЛНЯЕТ, поэтому единственный способ
 * проверить границы окна в юнит-тесте — прочитать сами параметры. Что
 * `dt BETWEEN` действительно так работает в Postgres, проверяет дымовой
 * прогон.
 *
 * Ею же ФИЛЬТРУЮТ стабы, которым фильтровать обязательно (справочник
 * сотрудников, история склада): отдай стаб фикстуру как есть — и «нашли по id»
 * проверялось бы содержимым фикстуры, а не кодом сервиса.
 */
function параметрыSQL(x: unknown): unknown[] {
  const out: unknown[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
    if (Array.isArray(chunks)) {
      for (const c of chunks) walk(c);
      return;
    }
    const v = (node as { value?: unknown }).value;
    if (typeof v === "string" || typeof v === "number") out.push(v);
  };
  walk(x);
  return out;
}

describe("Эталон витрины (R-P5b-6)", () => {
  it("окно факта — последние 14 ПОЛНЫХ ташкентских суток, кончая ВЧЕРА", async () => {
    // То же окно, что у отчётов аналитики (`окноПоВчера`). Разойдись они — и
    // бот отказывал бы в цене, которую отчёт того же владельца называет
    // правильной. Сегодняшний день не берём: `sale` наполняется суточным
    // съёмом, и половина дня давала бы цену, скачущую от часа прогона.
    const м = мир({ products: [{ id: "p1", name: "TUC Sour cream", purchasePrice: "9000", packSize: 1, salePrice: null }] });
    await м.service.retailFacts(14, undefined, new Date("2026-08-25T02:00:00Z")); // 07:00 в Ташкенте
    assert.deepEqual(м.окноПродаж(), ["2026-08-11", "2026-08-24"]);

    // Полчаса после ташкентской полуночи — то же окно, а не «на день меньше».
    await м.service.retailFacts(14, undefined, new Date("2026-08-24T19:30:00Z"));
    assert.deepEqual(м.окноПродаж(), ["2026-08-11", "2026-08-24"]);
  });

  it("записывает sale_price, событие и запись в журнал", async () => {
    const м = мир({ products: [{ id: "p1", name: "TUC Sour cream", purchasePrice: "9000", packSize: 1, salePrice: "12000" }] });
    const r = await м.service.setSalePrice("tuc sour cream", 15_000, "owner");
    assert.deepEqual([r.ok, r.product, r.oldPrice, r.newPrice], [true, "TUC Sour cream", 12_000, 15_000]);
    assert.equal(м.updates.at(-1)?.salePrice, "15000.00");
    // Тип события без payload ничего не значит: перепутанные old/new прошли бы
    // проверку одного лишь типа, а владелец прочёл бы «подорожало» на
    // подешевевшем товаре.
    assert.equal(м.events.at(-1)?.type, "vending.sale_price_changed");
    assert.deepEqual(м.events.at(-1)?.payload, {
      product: "TUC Sour cream",
      oldPrice: 12_000,
      newPrice: 15_000,
      actor: "owner",
    });
    const запись = м.audit.at(-1)!;
    assert.deepEqual(
      [запись.action, запись.actorKind, запись.actorRef, запись.target, запись.before, запись.after],
      ["vending.product.set_sale_price", "human", "owner", "p1", { salePrice: 12_000 }, { salePrice: 15_000 }],
    );
  });

  it("гейт по ФАКТУ витрины: >20 % от amount/qty требует «точно»", async () => {
    const м = мир({
      products: [{ id: "p1", name: "TUC Sour cream", purchasePrice: "9000", packSize: 1, salePrice: null }],
      sales: [{ dt: "2026-08-20", machineSerial: OLMA, product: "TUC Sour cream", qty: "4", amount: "60000" }],
    });
    const gate = await м.service.setSalePrice("TUC Sour cream", 20_000, "owner");
    assert.deepEqual([gate.ok, gate.reason, gate.factPrice, gate.deviationPct], [false, "spike", 15_000, 33]);
    assert.equal(м.updates.length, 0, "отказ гейта не трогает базу");
    assert.equal((await м.service.setSalePrice("TUC Sour cream", 20_000, "owner", true)).ok, true);
  });

  it("нет факта витрины — гейт не применяется (первый эталон проходит)", async () => {
    const м = мир({ products: [{ id: "p1", name: "Новинка", purchasePrice: "1000", packSize: 1, salePrice: null }] });
    const r = await м.service.setSalePrice("Новинка", 99_000, "owner");
    assert.deepEqual([r.ok, r.factPrice], [true, null]);
  });

  it("причина отказа названа своим именем: товар / цена", async () => {
    const м = мир({ products: [{ id: "p1", name: "TUC Sour cream", purchasePrice: "9000", packSize: 1, salePrice: null }] });
    assert.equal((await м.service.setSalePrice("Чипсы новые", 9_000)).reason, "not_found");
    // Живой товар с кривой ценой — это НЕ «товар не найден»: такой ответ
    // отправил бы владельца искать несуществующую проблему в прайсе.
    for (const мусор of [0, -5, Number.NaN]) {
      const r = await м.service.setSalePrice("TUC Sour cream", мусор);
      assert.deepEqual([r.ok, r.reason], [false, "invalid_price"], `цена ${мусор}`);
      assert.match(r.message ?? "", /положительное число/);
    }
    assert.equal((await м.service.setSalePrice("  ", 100)).reason, "not_found");
    assert.equal(м.updates.length, 0);
    assert.equal(м.events.length, 0);
  });

  it("автомат НЕ в строю в факт витрины не идёт (R-P5b-1)", async () => {
    // Прод, 09.07.2026: склад-заглушка 2508160360 (SKLAD 4S, warehouse)
    // «продал» 1 шт за 12 000. Такая продажа не витрина, и двигать гейт ей
    // нечего — а без фильтра она осталась бы единственным фактом товара.
    const склад = "2508160360";
    const м = мир({
      products: [{ id: "p1", name: "TUC Sour cream", purchasePrice: "9000", packSize: 1, salePrice: null }],
      sales: [{ dt: "2026-08-20", machineSerial: склад, product: "TUC Sour cream", qty: "4", amount: "60000" }],
      machines: [
        { id: "m-olma", name: "Olma Администрация", externalRef: OLMA, type: "machine" },
        { id: "m-sklad", name: "SKLAD 4S", externalRef: склад, type: "machine" },
      ],
      cards: [{ entityId: "m-sklad", status: "warehouse" }],
    });
    const r = await м.service.setSalePrice("TUC Sour cream", 20_000, "owner");
    assert.deepEqual([r.ok, r.factPrice], [true, null], "продажа склада-заглушки факта не создаёт");
  });

  it("бутстрап заполняет только пустые эталоны и называет пропущенных", async () => {
    const м = мир({
      products: [
        { id: "p1", name: "TUC Sour cream", purchasePrice: "9000", packSize: 1, salePrice: null },
        { id: "p2", name: "Moxito Lime 330ml", purchasePrice: "9800", packSize: 12, salePrice: "12000" },
        { id: "p3", name: "Новинка", purchasePrice: "1000", packSize: 1, salePrice: null },
        { id: "p4", name: "Снятый с продажи", purchasePrice: "1000", packSize: 1, salePrice: null, isActive: false },
      ],
      sales: [
        { dt: "2026-08-20", machineSerial: OLMA, product: "TUC Sour cream", qty: "4", amount: "60000" },
        // Продажи снятого товара в окне ЕСТЬ — и всё равно эталон ему не ставим.
        { dt: "2026-08-20", machineSerial: OLMA, product: "Снятый с продажи", qty: "2", amount: "10000" },
      ],
    });
    const r = await м.service.bootstrapSalePrice(14, "owner");
    assert.deepEqual(r.set, [{ product: "TUC Sour cream", price: 15_000, qty: 4 }]);
    assert.deepEqual(r.skipped, [
      { product: "Moxito Lime 330ml", reason: "already_set" },
      { product: "Новинка", reason: "no_sales" },
      { product: "Снятый с продажи", reason: "inactive" },
    ]);
    assert.equal(r.days, 14);
    // Ровно один товар записан — ровно одно событие и одна запись журнала.
    assert.equal(м.updates.length, 1);
    assert.equal(м.events.filter((e) => e.type === "vending.sale_price_changed").length, 1);
    assert.deepEqual(м.events.at(-1)?.payload, {
      product: "TUC Sour cream",
      oldPrice: null,
      newPrice: 15_000,
      actor: "owner",
    });
    assert.deepEqual(м.audit.at(-1)?.before, { salePrice: null });
    assert.deepEqual(м.audit.at(-1)?.after, { salePrice: 15_000 });
  });

  it("бутстрап пишет события и журнал ОДНОЙ пачкой, а не по вставке на товар", async () => {
    const м = мир({
      products: [
        { id: "p1", name: "TUC Sour cream", purchasePrice: "9000", packSize: 1, salePrice: null },
        { id: "p2", name: "Moxito Lime 330ml", purchasePrice: "9800", packSize: 12, salePrice: null },
      ],
      sales: [
        { dt: "2026-08-20", machineSerial: OLMA, product: "TUC Sour cream", qty: "4", amount: "60000" },
        { dt: "2026-08-20", machineSerial: OLMA, product: "Moxito Lime 330ml", qty: "2", amount: "24000" },
      ],
    });
    const r = await м.service.bootstrapSalePrice(14, "owner");
    assert.equal(r.set.length, 2);
    // Полсотни товаров прайса иначе дали бы полторы сотни запросов под одной
    // транзакцией, держащей блокировки строк всё это время.
    assert.deepEqual([м.вставок.get("event"), м.вставок.get("audit")], [1, 1]);
    assert.deepEqual([м.events.length, м.audit.length, м.updates.length], [2, 2, 2]);
  });

  it("повторный бутстрап ничего не пишет: эталон уже слово владельца", async () => {
    const м = мир({
      products: [{ id: "p1", name: "TUC Sour cream", purchasePrice: "9000", packSize: 1, salePrice: null }],
      sales: [{ dt: "2026-08-20", machineSerial: OLMA, product: "TUC Sour cream", qty: "4", amount: "60000" }],
    });
    const первый = await м.service.bootstrapSalePrice(14, "owner");
    assert.equal(первый.set.length, 1);
    м.применить(первый.set); // то, что после записи сделала бы база

    const второй = await м.service.bootstrapSalePrice(14, "owner");
    assert.deepEqual(второй.set, []);
    assert.deepEqual(второй.skipped, [{ product: "TUC Sour cream", reason: "already_set" }]);
    // Второй прогон не должен ни писать, ни оставлять следа в журнале — даже
    // при том, что факт витрины за окно у него тот же самый.
    assert.deepEqual([м.updates.length, м.events.length, м.audit.length], [1, 1, 1]);
  });

  it("гонка: эталон появился между чтением прайса и записью — решение владельца не затирается", async () => {
    const м = мир({
      products: [
        { id: "p1", name: "TUC Sour cream", purchasePrice: "9000", packSize: 1, salePrice: null },
        { id: "p2", name: "Moxito Lime 330ml", purchasePrice: "9800", packSize: 12, salePrice: null },
      ],
      sales: [
        { dt: "2026-08-20", machineSerial: OLMA, product: "TUC Sour cream", qty: "4", amount: "60000" },
        { dt: "2026-08-20", machineSerial: OLMA, product: "Moxito Lime 330ml", qty: "2", amount: "24000" },
      ],
      // Владелец успел сказать боту «цена продажи TUC 20000», пока бутстрап
      // читал продажи окна: строка уже не пуста, и наш факт её не касается.
      передЗаписью: (products) => {
        const строка = products.find((p) => p.id === "p1");
        if (строка) строка.salePrice = "20000.00";
      },
    });

    const r = await м.service.bootstrapSalePrice(14, "owner");
    assert.deepEqual(r.set, [{ product: "Moxito Lime 330ml", price: 12_000, qty: 2 }], "в set попадает только реально обновлённое");
    assert.deepEqual(
      r.skipped,
      [{ product: "TUC Sour cream", reason: "already_set" }],
      "проигравшая гонку строка обязана быть НАЗВАНА, а не исчезнуть",
    );
    // Событие и журнал — только на записанное: иначе журнал утверждал бы, что
    // эталон TUC поставил бутстрап, хотя его поставил владелец.
    assert.equal(м.events.filter((e) => e.type === "vending.sale_price_changed").length, 1);
    assert.deepEqual(м.events.at(-1)?.payload, {
      product: "Moxito Lime 330ml",
      oldPrice: null,
      newPrice: 12_000,
      actor: "owner",
    });
    assert.equal(м.audit.length, 1);
  });

  it("вся гонка проиграна — ни события, ни журнала, ни пустой пачки", async () => {
    const м = мир({
      products: [{ id: "p1", name: "TUC Sour cream", purchasePrice: "9000", packSize: 1, salePrice: null }],
      sales: [{ dt: "2026-08-20", machineSerial: OLMA, product: "TUC Sour cream", qty: "4", amount: "60000" }],
      передЗаписью: (products) => {
        for (const p of products) p.salePrice = "20000.00";
      },
    });

    const r = await м.service.bootstrapSalePrice(14, "owner");
    assert.deepEqual(r.set, []);
    assert.deepEqual(r.skipped, [{ product: "TUC Sour cream", reason: "already_set" }]);
    assert.deepEqual([м.events.length, м.audit.length], [0, 0]);
  });

  it("«бесплатная» продажа не роняет весь бутстрап: один товар уходит в no_fact", async () => {
    const м = мир({
      products: [
        { id: "p1", name: "Подарочный", purchasePrice: "1000", packSize: 1, salePrice: null },
        { id: "p2", name: "TUC Sour cream", purchasePrice: "9000", packSize: 1, salePrice: null },
      ],
      sales: [
        // amount = 0 при qty > 0: CHECK (sale_price > 0) из 0068 отверг бы
        // такую запись и уронил бы транзакцию вместе с законным эталоном.
        { dt: "2026-08-20", machineSerial: OLMA, product: "Подарочный", qty: "3", amount: "0" },
        { dt: "2026-08-20", machineSerial: OLMA, product: "TUC Sour cream", qty: "4", amount: "60000" },
      ],
    });

    const r = await м.service.bootstrapSalePrice(14, "owner");
    assert.deepEqual(r.set, [{ product: "TUC Sour cream", price: 15_000, qty: 4 }]);
    assert.deepEqual(r.skipped, [{ product: "Подарочный", reason: "no_fact" }]);
    assert.equal(м.updates.length, 1, "нулевую цену в базу не отправляем вовсе");
  });

  it("бутстрап без товаров без эталона не открывает транзакцию впустую", async () => {
    const м = мир({ products: [{ id: "p2", name: "Moxito Lime 330ml", purchasePrice: "9800", packSize: 12, salePrice: "12000" }] });
    const r = await м.service.bootstrapSalePrice(14, "owner");
    assert.deepEqual(r.set, []);
    assert.equal(м.events.length, 0);
  });
});

describe("Наблюдение закупочной цены при приёмке (R-P5b-5)", () => {
  it("позиция с ценой, отличной от прайса, пишет vending.purchase_price_observed", async () => {
    const м = мир({
      orders: [{ id: "o1", status: "approved", positions: [{ product: "TUC Sour cream", order: 10, price: 11_000 }] }],
      products: [{ id: "p1", name: "TUC Sour cream", purchasePrice: "9000", packSize: 1, salePrice: null }],
    });
    await м.service.receiveOrder("o1", "owner");
    const набл = м.events.filter((e) => e.type === "vending.purchase_price_observed") as {
      payload: Record<string, unknown>;
    }[];
    assert.deepEqual(
      набл.map((e) => e.payload),
      [{ product: "TUC Sour cream", price: 11_000, oldPrice: 9_000, orderId: "o1", receivedAt: набл[0]!.payload.receivedAt }],
    );
    assert.equal(typeof набл[0]!.payload.receivedAt, "string");
  });

  it("позиция без цены наблюдения не даёт (0 ≠ цена)", async () => {
    const м = мир({
      orders: [{ id: "o1", status: "approved", positions: [{ product: "TUC Sour cream", order: 10 }] }],
      products: [],
    });
    await м.service.receiveOrder("o1", "owner");
    assert.equal(м.events.filter((e) => e.type === "vending.purchase_price_observed").length, 0);
  });
});

describe("Серия отказов сбора (R-P5b-8)", () => {
  type RunRow = { id: string; status: "running" | "success" | "partial" | "failed"; startedAt: Date; error: string | null };
  type EvRow = { type: string; payload: Record<string, unknown>; occurredAt: Date };

  /** Значения-параметры из условия drizzle — стаб обязан фильтровать по тому же, о чём спросили. */
  const значения = (условие: unknown): unknown[] => {
    const out: unknown[] = [];
    const walk = (n: unknown): void => {
      if (n === null || typeof n !== "object") return;
      const chunks = (n as { queryChunks?: unknown[] }).queryChunks;
      if (Array.isArray(chunks)) {
        for (const c of chunks) walk(c);
        return;
      }
      if ("value" in (n as Record<string, unknown>)) out.push((n as { value: unknown }).value);
    };
    walk(условие);
    return out;
  };

  /**
   * Мир журнала сбора: прогоны живут между вызовами, `update` действительно
   * закрывает свою строку, а записанное событие ВИДНО следующей проверке
   * дедупа. Стаб, который отдаёт фикстуру как есть, показал бы «дедуп работает»
   * даже там, где его нет.
   */
  function мир(runs: RunRow[], events: EvRow[] = []) {
    const прогоны = runs.map((r) => ({ ...r }));
    const журнал = [...events];
    const db = {
      update: () => ({
        set: (v: Record<string, unknown>) => ({
          where: (условие: unknown) => ({
            returning: async () => {
              const id = значения(условие).find((x): x is string => typeof x === "string");
              const row = прогоны.find((r) => r.id === id);
              if (!row) return [];
              row.status = v.status as RunRow["status"];
              row.error = (v.error as string | null) ?? null;
              return [{ id: row.id }];
            },
          }),
        }),
      }),
      select: () => ({
        from: (t: unknown) => {
          if (t === event) {
            return {
              where: (условие: unknown) => ({
                limit: async () => {
                  const типы = значения(условие).filter((x): x is string => typeof x === "string");
                  const [с] = значения(условие).filter((x): x is Date => x instanceof Date);
                  return журнал.filter(
                    (e) => типы.includes(e.type) && (!с || e.occurredAt.getTime() >= с.getTime()),
                  );
                },
              }),
            };
          }
          return { orderBy: () => ({ limit: async (n: number) => прогоны.slice(0, n) }) };
        },
      }),
      insert: (t: unknown) => ({
        values: async (v: Record<string, unknown>) => {
          if (t === event) журнал.push({ ...(v as unknown as EvRow), occurredAt: new Date(СЕЙЧАС) });
        },
      }),
    } as never;
    return { service: new VendingService(db), events: журнал, прогоны };
  }

  /** Полдень Ташкента 25.08.2026: и прогоны, и дедуп считаются от него. */
  const СЕЙЧАС = new Date("2026-08-25T07:00:00.000Z");
  const ОТКАЗ_ВХОД = { status: "failed" as const, machinesTotal: 5, machinesOk: 0, durationMs: 10_000, error: "This operation was aborted" };

  const прогон = (id: string, status: RunRow["status"], startedAt: string, error: string | null = null): RunRow => ({
    id,
    status,
    startedAt: new Date(startedAt),
    error,
  });

  /** Два отказа уже в журнале и открытый третий прогон — состояние прода 25.08. */
  const ДВА_ОТКАЗА = () => [
    прогон("run-3", "running", "2026-08-25T06:00:00Z"),
    прогон("run-2", "failed", "2026-08-25T05:00:00Z", "This operation was aborted"),
    прогон("run-1", "failed", "2026-08-25T04:00:00Z", "This operation was aborted"),
  ];

  it("третий отказ подряд даёт событие один раз в сутки", async () => {
    const м = мир([прогон("run-4", "running", "2026-08-25T07:00:00Z"), ...ДВА_ОТКАЗА()]);

    await м.service.finishSyncRun("run-3", ОТКАЗ_ВХОД, СЕЙЧАС);
    const тревоги = () => м.events.filter((e) => e.type === "ourvend.sync_failed_streak");
    assert.equal(тревоги().length, 1);
    assert.deepEqual(тревоги()[0]!.payload, {
      streak: 3,
      lastError: "This operation was aborted",
      // Начало серии, а не последний отказ: владельцу нужно «с какого часа мы слепые».
      since: "2026-08-25T04:00:00.000Z",
    });

    await м.service.finishSyncRun("run-4", ОТКАЗ_ВХОД, СЕЙЧАС);
    assert.equal(тревоги().length, 1, "четвёртый отказ в те же сутки — не вторая тревога");
  });

  it("двух отказов мало: порог — третий подряд", async () => {
    const м = мир([
      прогон("run-2", "running", "2026-08-25T05:00:00Z"),
      прогон("run-1", "failed", "2026-08-25T04:00:00Z", "This operation was aborted"),
    ]);
    await м.service.finishSyncRun("run-2", ОТКАЗ_ВХОД, СЕЙЧАС);
    assert.equal(м.events.length, 0, "тревога на втором отказе научила бы владельца не читать тревоги");
  });

  it("успех события не даёт", async () => {
    const м = мир(ДВА_ОТКАЗА());
    await м.service.finishSyncRun(
      "run-3",
      { status: "success", machinesTotal: 5, machinesOk: 5, durationMs: 9_900 },
      СЕЙЧАС,
    );
    assert.equal(м.events.length, 0);
  });

  it("новые сутки — тревога снова проходит", async () => {
    const вчера = new Date("2026-08-24T07:00:00.000Z");
    const м = мир(
      [прогон("run-3", "running", "2026-08-25T06:00:00Z"), ...ДВА_ОТКАЗА().slice(1)],
      [{ type: "ourvend.sync_failed_streak", payload: { streak: 3 }, occurredAt: вчера }],
    );
    await м.service.finishSyncRun("run-3", ОТКАЗ_ВХОД, СЕЙЧАС);
    assert.equal(м.events.filter((e) => e.type === "ourvend.sync_failed_streak").length, 2);
  });

  it("неизвестный id — ни записи, ни тревоги", async () => {
    const м = мир(ДВА_ОТКАЗА());
    assert.deepEqual(await м.service.finishSyncRun("нет-такого", ОТКАЗ_ВХОД, СЕЙЧАС), { ok: false });
    assert.equal(м.events.length, 0);
  });
});
