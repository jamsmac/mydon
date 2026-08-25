import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  entity,
  event,
  machineCard,
  machineSale,
  machineStock,
  productSale,
  sale,
  systemConfig,
  vendingAlias,
  vendingProduct,
  vendingPurchaseOrder,
  vendingRefillEvent,
  vendingStock,
} from "@mydon/db";
import { tashkentDay } from "@mydon/shared";
import { AnalyticsService } from "./analytics.service";
import { SALE_PRICE_FACT_DAYS, VendingService } from "./vending.service";

type SaleRow = { dt: string; machineSerial: string; product: string; qty: string; amount: string };
type MachineStockRow = { dt: string; machineSerial: string; product: string; qty: string };
type StockRow = { productName: string; quantity: number };
type OrderRow = { status: string; receivedAt: Date | null; positions: unknown[] };
type RefillEventRow = { machineSerial: string; windowTo: Date; slots: { product: string; delta: number }[] };
type EventRow = { type: string; payload: Record<string, unknown>; occurredAt: Date };
type Ent = { id: string; name: string; externalRef: string | null; type: string };
type Card = { entityId: string; status: string };
type ProdRow = {
  id: string;
  name: string;
  purchasePrice: string | null;
  salePrice: string | null;
  packSize: number;
  excludedFromPurchase: boolean;
  fixedPurchaseQty: number | null;
  isActive: boolean;
};

interface Мир {
  sales?: SaleRow[];
  machineStock?: MachineStockRow[];
  stock?: StockRow[];
  orders?: OrderRow[];
  refillEvents?: RefillEventRow[];
  events?: EventRow[];
  products?: ProdRow[];
  entities?: Ent[];
  cards?: Card[];
  config?: { key: string; value: string }[];
}

/**
 * Значения-параметры из условия drizzle: стаб обязан отвечать НА ТО ЖЕ окно,
 * которое просит сервис. Без этого проверялась бы не выборка, а её отсутствие
 * — ошибка в границе суток прошла бы зелёной (урок «заглушка врёт»).
 */
function параметры(условие: unknown): unknown[] {
  const out: unknown[] = [];
  const walk = (n: unknown): void => {
    // Массивы обходятся ВНУТРЬ: значения `inArray`/`notInArray` drizzle прячет
    // списком параметров, и без этого шага отсечка серийников в SQL выглядела
    // бы отсутствующей — стаб зеленел бы на запросе без неё.
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    if (n === null || typeof n !== "object") return;
    const chunks = (n as { queryChunks?: unknown[] }).queryChunks;
    if (Array.isArray(chunks)) {
      for (const c of chunks) walk(c);
      return;
    }
    if ("value" in (n as Record<string, unknown>)) {
      const значение = (n as { value: unknown }).value;
      walk(значение);
      out.push(значение);
    }
  };
  walk(условие);
  return out;
}

const датаИз = (условие: unknown): Date | undefined => параметры(условие).find((v): v is Date => v instanceof Date);
const строкиИз = (условие: unknown): string[] => параметры(условие).filter((v): v is string => typeof v === "string");
const числаИз = (условие: unknown): number[] => параметры(условие).filter((v): v is number => typeof v === "number");

function analyticsDb(м: Мир) {
  /** Условия, с которыми сервис ходил в `sale` — по ним проверяется окно и отсечка «в строю». */
  const условияПродаж: string[][] = [];

  const rowsOf = (t: unknown): unknown[] => {
    // R-P5b-1: скользящие семидневные окна кабинета в деньги не идут НИКОГДА.
    // Стаб на незнакомую таблицу отдаёт `[]`, поэтому без этой ловушки
    // добавление `product_sale` в расчёт прошло бы зелёным — а на проде оно
    // завышает штуки в 36 раз.
    if (t === productSale || t === machineSale) {
      throw new Error("аналитика не имеет права читать product_sale/machine_sale (R-P5b-1)");
    }
    return t === sale
      ? (м.sales ?? [])
      : t === machineStock
        ? (м.machineStock ?? [])
        : t === vendingStock
          ? (м.stock ?? [])
          : t === vendingPurchaseOrder
            ? (м.orders ?? [])
            : t === vendingRefillEvent
              ? (м.refillEvents ?? [])
              : t === event
                ? (м.events ?? [])
                : t === vendingProduct
                  ? (м.products ?? [])
                  : t === vendingAlias
                    ? []
                    : t === entity
                      ? (м.entities ?? [])
                      : t === machineCard
                        ? (м.cards ?? [])
                        : t === systemConfig
                          ? (м.config ?? [])
                          : [];
  };

  const цепочка = (t: unknown, rows: unknown[]) => {
    let текущие = rows;
    const chain: Record<string, unknown> = {};
    chain.where = (условие: unknown) => {
      const строки = строкиИз(условие);
      const дата = датаИз(условие);
      if (t === sale) {
        // gte(dt, from) [+ lte(dt, to)] — окно отчёта по ташкентским суткам,
        // дальше — сырые формы серийников не в строю (`notInArray`).
        условияПродаж.push(строки);
        const [от, до] = строки;
        текущие = (текущие as SaleRow[]).filter((r) => (!от || r.dt >= от) && (!до || r.dt <= до));
      }
      if (t === machineStock) {
        const [от] = строки;
        текущие = (текущие as MachineStockRow[]).filter((r) => !от || r.dt >= от);
      }
      if (t === vendingStock) {
        const [порог] = числаИз(условие);
        текущие = (текущие as StockRow[]).filter((r) => r.quantity > (порог ?? 0));
      }
      if (t === vendingPurchaseOrder) {
        текущие = (текущие as OrderRow[]).filter(
          (r) =>
            (строки.length === 0 || строки.includes(r.status)) &&
            (!дата || (r.receivedAt !== null && r.receivedAt.getTime() >= дата.getTime())),
        );
      }
      if (t === vendingRefillEvent) {
        текущие = (текущие as RefillEventRow[]).filter((r) => !дата || r.windowTo.getTime() >= дата.getTime());
      }
      if (t === event) {
        текущие = (текущие as EventRow[]).filter(
          (r) => (строки.length === 0 || строки.includes(r.type)) && (!дата || r.occurredAt.getTime() >= дата.getTime()),
        );
      }
      if (t === entity) {
        текущие = (текущие as Ent[]).filter((r) => строки.length === 0 || строки.includes(r.type));
      }
      return chain;
    };
    chain.groupBy = () => chain;
    chain.orderBy = () => chain;
    chain.limit = async () => текущие;
    chain.then = (res: (v: unknown) => unknown) => Promise.resolve(текущие).then(res);
    return chain;
  };

  /** Сколько раз сервис ходил в базу — по нему проверяется кеш отчёта. */
  const счётчик = { select: 0 };
  const db = {
    select: () => ({
      from: (t: unknown) => {
        счётчик.select += 1;
        return цепочка(t, rowsOf(t));
      },
    }),
  } as never;

  return { db, счётчик, условияПродаж };
}

const СУТКИ = 86_400_000;
/** «Сейчас» прибито гвоздями — полдень Ташкента 25.08.2026 (прогон через полночь иначе флакал бы). */
const СЕЙЧАС = new Date("2026-08-25T07:00:00.000Z");
const день = (сдвиг: number): string => tashkentDay(new Date(СЕЙЧАС.getTime() + сдвиг * СУТКИ));
const момент = (д: string): Date => new Date(`${д}T10:00:00.000Z`);

const OLMA = "2508160376";
const AMERICAN = "2508160359";
const SKLAD = "2508160360";

const ПАРК: Ent[] = [
  { id: "m-olma", name: "Olma Администрация", externalRef: OLMA, type: "machine" },
  { id: "m-ah", name: "American Hospital", externalRef: AMERICAN, type: "machine" },
  { id: "e-sklad", name: "SKLAD 4S", externalRef: SKLAD, type: "machine" },
];
const СКЛАД_НЕ_В_СТРОЮ: Card[] = [{ entityId: "e-sklad", status: "warehouse" }];

const товар = (
  id: string,
  name: string,
  purchasePrice: string | null,
  salePrice: string | null = null,
  isActive = true,
): ProdRow => ({
  id,
  name,
  purchasePrice,
  salePrice,
  packSize: 1,
  excludedFromPurchase: false,
  fixedPurchaseQty: null,
  isActive,
});

/** Прод-числа: Moxito 12000/9800 (18.3 %), Lays 15000/13000 (13.3 % — ниже порога 15). */
const ПРАЙС: ProdRow[] = [товар("p1", "Moxito Lime 330ml", "9800"), товар("p2", "Lays Сметана-лук", "13000")];

const ПРОД_ПРОДАЖИ: SaleRow[] = [
  { dt: день(-3), machineSerial: OLMA, product: "Moxito Lime 330ml", qty: "10", amount: "120000" },
  { dt: день(-2), machineSerial: AMERICAN, product: "Lays Сметана-лук", qty: "4", amount: "60000" },
];

/** Витринный переход 15000 → 12000 (−20 %) внутри окна и свежая продажа для разрыва витрины. */
const ЛАЙМОН: SaleRow[] = [
  { dt: день(-30), machineSerial: OLMA, product: "LaimonFresh Lime 330ml", qty: "2", amount: "30000" },
  { dt: день(-25), machineSerial: OLMA, product: "LaimonFresh Lime 330ml", qty: "2", amount: "24000" },
  { dt: день(-3), machineSerial: OLMA, product: "LaimonFresh Lime 330ml", qty: "3", amount: "36000" },
];

const сервис = (мир: Мир) => {
  const { db, счётчик, условияПродаж } = analyticsDb(мир);
  const svc = new AnalyticsService(db, new VendingService(db));
  return Object.assign(svc, { счётчик, условияПродаж });
};

describe("Аналитика: маржа (R-P5b-1, R-P5b-3)", () => {
  it("считает только по in_service; SKLAD-строка уходит в excluded", async () => {
    const s = сервис({
      sales: [
        ...ПРОД_ПРОДАЖИ,
        { dt: день(-5), machineSerial: SKLAD, product: "Moxito Lime 330ml", qty: "1", amount: "12000" },
      ],
      products: ПРАЙС,
      entities: ПАРК,
      cards: СКЛАД_НЕ_В_СТРОЮ,
    });
    const r = await s.margin(30, СЕЙЧАС);

    assert.deepEqual(
      r.excluded.map((x) => [x.serial, x.qty, x.amount]),
      [[SKLAD, 1, 12_000]],
    );
    assert.deepEqual(
      r.machines.map((m) => m.name),
      ["Olma Администрация", "American Hospital"],
    );
    assert.deepEqual(
      r.machines.map((m) => [m.revenue, m.cogs, m.margin, m.pct]),
      [
        [120_000, 98_000, 22_000, 18.3],
        [60_000, 52_000, 8_000, 13.3],
      ],
    );
    assert.ok(
      r.warnings.some((w) => w.code === "excluded_sales" && w.message.includes(SKLAD)),
      "продажи склада обязаны быть НАЗВАНЫ, а не молча выброшены",
    );
  });

  it("окно закрывается вчерашним днём: продажа старше окна не считается", async () => {
    const s = сервис({
      sales: [
        { dt: день(-40), machineSerial: OLMA, product: "Moxito Lime 330ml", qty: "99", amount: "1188000" },
        ...ПРОД_ПРОДАЖИ,
      ],
      products: ПРАЙС,
      entities: ПАРК,
    });
    const r = await s.margin(30, СЕЙЧАС);

    assert.deepEqual([r.from, r.to], [день(-30), день(-1)]);
    assert.equal(r.totals.qty, 14, "99 шт из-за окна попали в отчёт — фильтр по dt не отработал");
  });

  it("серийник без карточки остаётся в деньгах: «карточку не завели» ≠ «снят со службы»", async () => {
    const s = сервис({
      sales: [
        ...ПРОД_ПРОДАЖИ,
        { dt: день(-4), machineSerial: "2508160399", product: "Moxito Lime 330ml", qty: "2", amount: "24000" },
      ],
      products: ПРАЙС,
      entities: ПАРК,
      cards: СКЛАД_НЕ_В_СТРОЮ,
    });
    const r = await s.margin(30, СЕЙЧАС);

    assert.deepEqual(r.excluded, [], "новый автомат — не «не в строю»; его выручка не должна пропадать");
    assert.deepEqual(
      r.machines.map((m) => [m.serial, m.name]).sort(),
      [
        ["2508160359", "American Hospital"],
        ["2508160376", "Olma Администрация"],
        ["2508160399", "2508160399"],
      ].sort(),
      "имя автомата без карточки — его серийник, а не пустая строка",
    );
    assert.equal(r.totals.qty, 16);
  });

  it("R-P5b-1: деньги не читаются из product_sale/machine_sale", async () => {
    const s = сервис({ sales: ПРОД_ПРОДАЖИ, products: ПРАЙС, entities: ПАРК });
    // Стаб бросает на этих таблицах: если расчёт когда-нибудь их коснётся,
    // тест упадёт здесь, а не на проде завышением штук в 36 раз.
    await s.margin(30, СЕЙЧАС);
    await s.deadStock(21, СЕЙЧАС);
    await s.priceChanges(30, СЕЙЧАС);
    await s.priceGap(14, СЕЙЧАС);
  });

  it("порог низкой маржи берётся из настройки, а не из константы", async () => {
    const s = сервис({
      sales: ПРОД_ПРОДАЖИ,
      products: ПРАЙС,
      entities: ПАРК,
      config: [{ key: "MARGIN_LOW_PCT", value: "30" }],
    });
    const r = await s.margin(30, СЕЙЧАС);

    assert.equal(r.lowPct, 30);
    assert.ok(r.products.length > 0);
    assert.ok(r.products.every((p) => p.low === (p.pct !== null && p.pct < 30)));
  });

  it("товар без закупочной цены назван вслух: выручка есть, затрат нет", async () => {
    const s = сервис({
      sales: ПРОД_ПРОДАЖИ,
      products: [товар("p1", "Moxito Lime 330ml", "9800")],
      entities: ПАРК,
    });
    const r = await s.margin(30, СЕЙЧАС);

    assert.deepEqual(r.unknownProducts, ["Lays Сметана-лук"]);
    assert.equal(r.unknownUnits, 4);
    assert.ok(r.warnings.some((w) => w.code === "unknown_cost" && w.message.includes("Lays Сметана-лук")));
  });

  it("продаж в окне нет — это сказано словами, а не нулями", async () => {
    const s = сервис({ sales: [], products: ПРАЙС, entities: ПАРК });
    const r = await s.margin(30, СЕЙЧАС);

    assert.deepEqual(r.machines, []);
    assert.equal(r.totals.revenue, 0);
    assert.ok(r.warnings.some((w) => w.code === "no_sales"));
  });

  it("кеш: два запроса одного окна — один поход в базу", async () => {
    const s = сервис({ sales: ПРОД_ПРОДАЖИ, products: ПРАЙС, entities: ПАРК });
    await s.margin(30, СЕЙЧАС);
    const было = s.счётчик.select;
    await s.margin(30, СЕЙЧАС);

    assert.equal(s.счётчик.select, было);
    await s.margin(14, СЕЙЧАС);
    assert.ok(s.счётчик.select > было, "другое окно — другой отчёт, кеш не должен его подменять");
  });
});

describe("Аналитика: себестоимость прогона (R-P5b-2)", () => {
  it("принятая накладная окна важнее цены карточки, source = orders", async () => {
    const s = сервис({
      sales: ПРОД_ПРОДАЖИ,
      products: ПРАЙС,
      entities: ПАРК,
      orders: [
        {
          status: "received",
          receivedAt: момент(день(-10)),
          positions: [{ product: "Moxito Lime 330ml", order: 10, price: 9000 }],
        },
      ],
    });
    const { cost, sourceOf, counts } = await s.costIndex(СЕЙЧАС);

    assert.equal(cost("Moxito Lime 330ml"), 9000);
    assert.equal(sourceOf("Moxito Lime 330ml"), "orders");
    assert.equal(cost("Lays Сметана-лук"), 13_000, "чего нет в накладных — по карточке");
    assert.equal(sourceOf("Lays Сметана-лук"), "price", "признак товарный: одна накладная не переводит на неё весь прайс");
    assert.equal(cost("Товар без цены"), null);
    assert.equal(sourceOf("Товар без цены"), "unknown");
    assert.deepEqual(counts, { orders: 1, price: 1 });
  });

  it("два лота взвешиваются по штукам, а не усредняются по ценам", async () => {
    const s = сервис({
      products: ПРАЙС,
      entities: ПАРК,
      orders: [
        {
          status: "received",
          receivedAt: момент(день(-30)),
          positions: [{ product: "Moxito Lime 330ml", order: 10, price: 10_000 }],
        },
        {
          status: "received",
          receivedAt: момент(день(-2)),
          positions: [{ product: "Moxito Lime 330ml", order: 90, price: 20_000 }],
        },
      ],
    });
    const { cost } = await s.costIndex(СЕЙЧАС);

    // (10×10 000 + 90×20 000) / 100 = 19 000. Среднее двух ЦЕН дало бы 15 000 —
    // на 4 000 сум с единицы мимо, и это ровно та ошибка, которую прячет
    // подмена `order` на любое другое поле позиции.
    assert.equal(cost("Moxito Lime 330ml"), 19_000);
  });

  it("накладная старше окна себестоимость не двигает", async () => {
    const s = сервис({
      products: ПРАЙС,
      entities: ПАРК,
      orders: [
        {
          status: "received",
          receivedAt: момент(день(-200)),
          positions: [{ product: "Moxito Lime 330ml", order: 10, price: 9000 }],
        },
      ],
    });
    const { cost, sourceOf } = await s.costIndex(СЕЙЧАС);

    assert.equal(sourceOf("Moxito Lime 330ml"), "price");
    assert.equal(cost("Moxito Lime 330ml"), 9800);
  });
});

describe("Аналитика: мёртвый сток (R-P5b-4)", () => {
  it("берёт последний день machine_stock и исключает автоматы не в строю", async () => {
    const s = сервис({
      machineStock: [
        { dt: день(0), machineSerial: OLMA, product: "TUC Sour cream", qty: "5" },
        { dt: день(-1), machineSerial: OLMA, product: "TUC Sour cream", qty: "99" },
        { dt: день(0), machineSerial: SKLAD, product: "Kinder Bueno 43gr", qty: "7960" },
      ],
      entities: ПАРК,
      cards: СКЛАД_НЕ_В_СТРОЮ,
      products: [товар("p1", "TUC Sour cream", "13500")],
    });
    const r = await s.deadStock(21, СЕЙЧАС);

    assert.deepEqual(
      r.machines.map((x) => [x.product, x.qty, x.value]),
      [["TUC Sour cream", 5, 67_500]],
    );
    assert.equal(r.machines[0]?.machineName, "Olma Администрация");
    assert.equal(r.totalValue, 67_500);
  });

  it("заливка по снимку снимает флаг у ЭТОГО автомата", async () => {
    const s = сервис({
      machineStock: [{ dt: день(0), machineSerial: OLMA, product: "TUC Sour cream", qty: "5" }],
      refillEvents: [
        {
          machineSerial: OLMA,
          windowTo: момент(день(-5)),
          slots: [{ product: "TUC Sour cream", delta: 5 }],
        },
      ],
      entities: ПАРК,
    });

    assert.equal((await s.deadStock(21, СЕЙЧАС)).machines.length, 0);
  });

  it("движение: склад — глобально, автомат — по паре (автомат, товар)", async () => {
    const мир: Мир = {
      stock: [
        { productName: "TUC Sour cream", quantity: 4 },
        { productName: "Kinder Bueno 43gr", quantity: 3 },
        { productName: "Cheers Сметана-зелень 70gr", quantity: 6 },
      ],
      machineStock: [{ dt: день(0), machineSerial: OLMA, product: "Kinder Bueno 43gr", qty: "2" }],
      sales: [{ dt: день(-2), machineSerial: AMERICAN, product: "Kinder Bueno 43gr", qty: "1", amount: "12000" }],
      orders: [
        {
          status: "received",
          receivedAt: момент(день(-4)),
          positions: [{ product: "TUC Sour cream", order: 10, price: 13_500 }],
        },
      ],
      entities: ПАРК,
      products: [
        товар("p1", "TUC Sour cream", "13500"),
        товар("p2", "Kinder Bueno 43gr", "10000"),
        товар("p3", "Cheers Сметана-зелень 70gr", "9000"),
      ],
    };
    const r = await сервис(мир).deadStock(21, СЕЙЧАС);

    assert.deepEqual(
      r.warehouse.map((x) => x.product),
      ["Cheers Сметана-зелень 70gr"],
      "приход по накладной и продажа где угодно — движение склада; без них позиция мёртвая",
    );
    assert.deepEqual(
      r.machines.map((x) => [x.serial, x.product]),
      [[OLMA, "Kinder Bueno 43gr"]],
      "продажа в American Hospital не снимает флаг с Olma (R-P5b-4)",
    );
  });

  it("товар без себестоимости остаётся строкой с noPrice, а не нулём сум", async () => {
    const s = сервис({
      stock: [{ productName: "Товар без цены", quantity: 3 }],
      entities: ПАРК,
    });
    const r = await s.deadStock(21, СЕЙЧАС);

    assert.deepEqual(
      r.warehouse.map((x) => [x.product, x.value, x.noPrice]),
      [["Товар без цены", 0, true]],
    );
    assert.equal(r.noPriceCount, 1);
    assert.ok(r.warnings.some((w) => w.code === "unknown_cost"));
  });

  it("автомат торгует, а остатка на последний день нет — предупреждение, а не тишина", async () => {
    const s = сервис({
      sales: [{ dt: день(-2), machineSerial: OLMA, product: "Moxito Lime 330ml", qty: "1", amount: "12000" }],
      machineStock: [],
      entities: ПАРК,
      products: ПРАЙС,
    });
    const r = await s.deadStock(21, СЕЙЧАС);

    assert.deepEqual(r.machines, []);
    assert.ok(
      r.warnings.some((w) => w.code === "stock_missing" && w.message.includes("Olma Администрация")),
      "молчание читалось бы как «мёртвого стока нет»",
    );
  });
});

describe("Аналитика: цены и витрина (R-P5b-5, R-P5b-6)", () => {
  it("порог из настройки; события и продажи дают две ленты", async () => {
    const s = сервис({
      sales: [
        ...ЛАЙМОН,
        // Склад «продал» по 30 000: витринная лента обязана его не заметить,
        // иначе последним переходом стал бы скачок +150 %.
        { dt: день(-2), machineSerial: SKLAD, product: "LaimonFresh Lime 330ml", qty: "1", amount: "30000" },
      ],
      cards: СКЛАД_НЕ_В_СТРОЮ,
      events: [
        {
          type: "vending.price_changed",
          payload: { product: "Montella 330ml", oldPrice: 20_000, newPrice: 22_000 },
          occurredAt: момент(день(-15)),
        },
      ],
      entities: ПАРК,
      config: [{ key: "PRICE_CHANGE_PCT", value: "5" }],
    });
    const r = await s.priceChanges(30, СЕЙЧАС);

    assert.equal(r.pct, 5);
    assert.deepEqual(
      r.retail.map((x) => x.pct),
      [-20],
    );
    assert.deepEqual(
      r.purchase.map((x) => [x.product, x.from, x.to]),
      [["Montella 330ml", 20_000, 22_000]],
    );
    // Помесячная динамика — отдельный тест ниже: в 30-суточном окне ПОЛНОГО
    // месяца нет, и обрезок панели не отдаётся.
    assert.deepEqual(r.monthly, []);
  });

  it("наблюдение приёмки — вторая лента закупочных цен", async () => {
    const s = сервис({
      events: [
        {
          type: "vending.purchase_price_observed",
          payload: { product: "Moxito Lime 330ml", oldPrice: 9800, price: 12_000, orderId: "o-1" },
          occurredAt: момент(день(-4)),
        },
      ],
      entities: ПАРК,
      products: ПРАЙС,
    });
    const r = await s.priceChanges(30, СЕЙЧАС);

    assert.deepEqual(
      r.purchase.map((x) => [x.product, x.from, x.to]),
      [["Moxito Lime 330ml", 9800, 12_000]],
    );
    assert.ok(r.warnings.some((w) => w.code === "no_sales"), "витринной ленты нет — это сказано словами");
  });

  it("эталона нет — товар в noReference, а не нулевая строка", async () => {
    const s = сервис({
      sales: ЛАЙМОН,
      products: [товар("p1", "LaimonFresh Lime 330ml", "9000", null)],
      entities: ПАРК,
    });
    const r = await s.priceGap(14, СЕЙЧАС);

    assert.deepEqual([r.rows.length, r.noReference], [0, ["LaimonFresh Lime 330ml"]]);
    assert.ok(r.warnings.some((w) => w.code === "no_reference"));
  });

  it("факт ниже эталона — строка с недобором; продажа склада в факт не входит", async () => {
    const s = сервис({
      sales: [
        ...ЛАЙМОН,
        // SKLAD «продал» по 30 000 — прод-случай 09.07 (ловушка §7.4). Попади
        // он в факт витрины, разрыв перевернулся бы знаком.
        { dt: день(-2), machineSerial: SKLAD, product: "LaimonFresh Lime 330ml", qty: "1", amount: "30000" },
      ],
      products: [товар("p1", "LaimonFresh Lime 330ml", "9000", "15000.00")],
      entities: ПАРК,
      cards: СКЛАД_НЕ_В_СТРОЮ,
      config: [{ key: "PRICE_GAP_PCT", value: "5" }],
    });
    const r = await s.priceGap(14, СЕЙЧАС);

    assert.deepEqual(
      r.rows.map((x) => [x.product, x.fact, x.reference, x.qty, x.lost, x.action]),
      [["LaimonFresh Lime 330ml", 12_000, 15_000, 3, 9_000, "raise"]],
    );
    assert.equal(r.lostTotal, 9_000);
    assert.deepEqual(r.noReference, []);
  });

  it("окно по умолчанию — то же, что у гейта эталона (SALE_PRICE_FACT_DAYS), и отсечка «в строю» уходит в SQL", async () => {
    const s = сервис({
      sales: ЛАЙМОН,
      products: [товар("p1", "LaimonFresh Lime 330ml", "9000", "15000.00")],
      entities: ПАРК,
      cards: СКЛАД_НЕ_В_СТРОЮ,
    });
    const r = await s.priceGap(undefined, СЕЙЧАС);

    assert.equal(r.days, SALE_PRICE_FACT_DAYS, "своей константы окна у отчёта быть не должно");
    const условие = s.условияПродаж.at(-1) ?? [];
    assert.deepEqual(условие.slice(0, 2), [день(-SALE_PRICE_FACT_DAYS), день(-1)], "окно — N полных суток по вчера");
    assert.ok(
      условие.includes(SKLAD) && условие.includes(`c${SKLAD}`),
      "серийники не в строю обязаны отсекаться прямо в SQL, обеими формами написания",
    );
  });

  it("снятый с продажи товар не попадает в «эталон не задан»", async () => {
    const s = сервис({
      sales: [
        ...ЛАЙМОН,
        { dt: день(-3), machineSerial: OLMA, product: "Старый вкус 0,5", qty: "1", amount: "9000" },
      ],
      products: [
        товар("p1", "LaimonFresh Lime 330ml", "9000", "12000.00"),
        товар("p2", "Старый вкус 0,5", "5000", null, false),
      ],
      entities: ПАРК,
    });
    const r = await s.priceGap(14, СЕЙЧАС);

    assert.deepEqual(r.noReference, [], "эталон нужен тому, что продаётся дальше");
    assert.ok(!r.warnings.some((w) => w.code === "no_reference"));
  });

  it("товар без карточки в прайсе из «эталон не задан» НЕ прячется", async () => {
    const s = сервис({
      sales: [{ dt: день(-3), machineSerial: OLMA, product: "Неизвестный товар", qty: "1", amount: "9000" }],
      products: [],
      entities: ПАРК,
    });
    const r = await s.priceGap(14, СЕЙЧАС);

    assert.deepEqual(r.noReference, ["Неизвестный товар"]);
  });

  it("monthly: только ПОЛНЫЕ месяцы окна", async () => {
    const s = сервис({ sales: ЛАЙМОН, entities: ПАРК });
    const узкое = await s.priceChanges(30, СЕЙЧАС);
    assert.deepEqual(узкое.monthly, [], "в 30 сутках до вчера полного месяца нет — обрезок хуже пустоты");

    const широкое = await s.priceChanges(180, СЕЙЧАС);
    assert.ok(широкое.monthly.length > 0, "полугодовое окно обязано дать полные месяцы");
    assert.ok(
      широкое.monthly.every((m) => m.month >= "2026-03" && m.month <= "2026-07"),
      `в окне 180 суток до ${день(-1)} полные месяцы — с марта по июль: ${JSON.stringify(широкое.monthly)}`,
    );
  });

  it("сброс кеша: после правки эталона отчёт считается заново", async () => {
    const s = сервис({
      sales: ЛАЙМОН,
      products: [товар("p1", "LaimonFresh Lime 330ml", "9000", null)],
      entities: ПАРК,
    });
    await s.priceGap(14, СЕЙЧАС);
    const было = s.счётчик.select;
    await s.priceGap(14, СЕЙЧАС);
    assert.equal(s.счётчик.select, было);

    s.invalidate();
    await s.priceGap(14, СЕЙЧАС);
    assert.ok(s.счётчик.select > было, "после invalidate() отчёт обязан пойти в базу заново");
  });
});
