import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  entity,
  event,
  machineCard,
  machineStock,
  sale,
  systemConfig,
  vendingAlias,
  vendingProduct,
  vendingPurchaseOrder,
  vendingRefill,
  vendingRefillEvent,
  vendingStock,
  vendingStockCount,
  vendingSyncRun,
} from "@mydon/db";
import type { OurvendHealth, ParityDay } from "@mydon/shared";
import type { OurvendHealthService } from "../ourvend/ourvend-health.service";
import type { OurvendParityService } from "../ourvend/ourvend-parity.service";
import { AnalyticsService } from "./analytics.service";
import { VendingService } from "./vending.service";
import { WEEK_RUNS_LIMIT } from "../ourvend/sync-runs";
import { WeeklyDigestService } from "./weekly-digest.service";

type SaleRow = { dt: string; machineSerial: string; product: string; qty: string; amount: string };
type StockRow = { productName: string; quantity: number; countedAt: Date };
/** Строка ИСТОРИИ пересчётов: `dt` — голые ташкентские сутки, как в базе. */
type StockCountRow = { dt: string; countedAt: Date };
type OrderRow = { status: string; receivedAt: Date | null; positions: unknown[] };
type RefillEventRow = { machineSerial: string; windowTo: Date; units: number; slots: { product: string; delta: number }[] };
type RefillRow = { qty: number; performedAt: Date };
/** Строка журнала прогонов: недельный блок читает её ДВУМЯ запросами (окно и последний успех). */
type SyncRunRow = { status: string; startedAt: Date; finishedAt: Date | null; error: string | null };
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
};

interface Мир {
  sales?: SaleRow[];
  stock?: StockRow[];
  stockCounts?: StockCountRow[];
  orders?: OrderRow[];
  refillEvents?: RefillEventRow[];
  refills?: RefillRow[];
  events?: EventRow[];
  products?: ProdRow[];
  entities?: Ent[];
  cards?: Card[];
  health?: OurvendHealth;
  runs?: SyncRunRow[];
  parityDays?: ParityDay[];
  /** Падает ТОЛЬКО счёт дней паритета — прогоны недели обязаны остаться настоящими. */
  паритетПадает?: boolean;
  /** Падает чтение журнала прогонов — вся недельная секция деградирует. */
  журналПадает?: boolean;
}

/** Значения-параметры из условия drizzle — стаб обязан отвечать на ТО ЖЕ окно, о котором спросили. */
function параметры(условие: unknown): unknown[] {
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
}

/**
 * Строковые значения ВМЕСТЕ с вложенными списками: `inArray` кладёт свои
 * значения массивом SQL-кусков, и плоский обход их не видит вовсе.
 *
 * Отдельной функцией, а не правкой `параметры`: тот обход зашит в четыре
 * существующих ветки стенда, и расширять его «заодно» значило бы менять их
 * поведение мимо задачи.
 */
function статусыИз(условие: unknown): string[] {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (n === null || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    const chunks = (n as { queryChunks?: unknown[] }).queryChunks;
    if (Array.isArray(chunks)) {
      for (const c of chunks) walk(c);
      return;
    }
    const v = (n as { value?: unknown }).value;
    if (typeof v === "string") out.push(v);
  };
  walk(условие);
  return out;
}

/**
 * Текст SQL-выражения (`started_at desc`) — стенду нужно НАПРАВЛЕНИЕ сортировки.
 *
 * Журнал прогонов читают двумя запросами в РАЗНЫЕ стороны: «свежие сверху» для
 * недельного блока и «самый ранний» для даты начала журнала (R-FW-P5). Стенд,
 * который сортирует всегда одинаково, показал бы «первым» не тот прогон, и
 * тест зеленел бы на сломанном запросе.
 */
function текстВыражения(x: unknown): string {
  if (x === null || typeof x !== "object") return "";
  const chunks = (x as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(chunks)) return chunks.map(текстВыражения).join("");
  const v = (x as { value?: unknown }).value;
  if (Array.isArray(v)) return v.join("");
  const name = (x as { name?: unknown }).name;
  return typeof name === "string" ? name : "";
}

const датыИз = (условие: unknown): Date[] => параметры(условие).filter((v): v is Date => v instanceof Date);
const строкиИз = (условие: unknown): string[] => параметры(условие).filter((v): v is string => typeof v === "string");
const числаИз = (условие: unknown): number[] => параметры(условие).filter((v): v is number => typeof v === "number");

/** Момент внутри ташкентских суток `день` (полдень — чтобы граница читалась однозначно). */
const момент = (день: string): Date => new Date(`${день}T07:00:00.000Z`);

/**
 * Стаб БД сводки: та же техника, что в `analytics.service.test.ts`, плюс
 * ОКНО ПО ДВУМ ГРАНИЦАМ. Полуинтервал `[начало, конец)` — весь смысл недельных
 * выборок: стаб, отдающий фикстуру целиком, пропустил бы заливку соседней
 * недели зелёной (урок «заглушка врёт»).
 */
function digestDb(м: Мир) {
  const фикстуры = new Map<unknown, () => unknown[]>([
    [sale, () => м.sales ?? []],
    [machineStock, () => []],
    [vendingStock, () => м.stock ?? []],
    [vendingStockCount, () => м.stockCounts ?? []],
    [vendingPurchaseOrder, () => м.orders ?? []],
    [vendingRefillEvent, () => м.refillEvents ?? []],
    [vendingRefill, () => м.refills ?? []],
    [
      vendingSyncRun,
      () => {
        if (м.журналПадает) throw new Error("журнал прогонов недоступен");
        return м.runs ?? [];
      },
    ],
    [event, () => м.events ?? []],
    [vendingProduct, () => м.products ?? []],
    [vendingAlias, () => []],
    [entity, () => м.entities ?? []],
    [machineCard, () => м.cards ?? []],
    [systemConfig, () => []],
  ]);
  const rowsOf = (t: unknown): unknown[] => фикстуры.get(t)?.() ?? [];

  const вОкне = (at: Date | null, окно: Date[]): boolean => {
    if (at === null) return false;
    const [от, до] = окно;
    return (!от || at.getTime() >= от.getTime()) && (!до || at.getTime() < до.getTime());
  };

  const цепочка = (t: unknown, rows: unknown[]) => {
    let текущие = rows;
    const chain: Record<string, unknown> = {};
    chain.where = (условие: unknown) => {
      const строки = строкиИз(условие);
      const окно = датыИз(условие);
      if (t === sale) {
        const [от, до] = строки;
        текущие = (текущие as SaleRow[]).filter((r) => (!от || r.dt >= от) && (!до || r.dt <= до));
      }
      if (t === vendingStock) {
        // Один и тот же справочник спрашивают двое: мёртвый сток — по остатку,
        // сводка — по дате пересчёта. Различаем по типу параметра условия.
        if (окно.length > 0) текущие = (текущие as StockRow[]).filter((r) => вОкне(r.countedAt, окно));
        else {
          const [порог] = числаИз(условие);
          текущие = (текущие as StockRow[]).filter((r) => r.quantity > (порог ?? 0));
        }
      }
      if (t === vendingStockCount) {
        // Окно у `dt` — ГОЛЫЕ СУТКИ-строки, а не Date: сравнение `date`-колонки
        // с `timestamptz` уехало бы на 05:00 Ташкента (урок VendCash).
        const [от, до] = строки;
        текущие = (текущие as StockCountRow[]).filter((r) => (!от || r.dt >= от) && (!до || r.dt < до));
      }
      if (t === vendingPurchaseOrder) {
        текущие = (текущие as OrderRow[]).filter(
          (r) => (строки.length === 0 || строки.includes(r.status)) && вОкне(r.receivedAt, окно),
        );
      }
      if (t === vendingRefillEvent) {
        текущие = (текущие as RefillEventRow[]).filter((r) => вОкне(r.windowTo, окно));
      }
      if (t === vendingRefill) {
        текущие = (текущие as RefillRow[]).filter((r) => вОкне(r.performedAt, окно));
      }
      if (t === vendingSyncRun) {
        // Статусы приходят через `inArray` — их надо доставать глубоким
        // обходом, иначе «последний успех недели» вернул бы последний ЛЮБОЙ
        // прогон, и тест про `null` был бы зелёным на сломанном запросе.
        const статусы = статусыИз(условие);
        текущие = (текущие as SyncRunRow[]).filter(
          (r) => (статусы.length === 0 || статусы.includes(r.status)) && вОкне(r.startedAt, окно),
        );
      }
      if (t === event) {
        текущие = (текущие as EventRow[]).filter(
          (r) => (строки.length === 0 || строки.includes(r.type)) && вОкне(r.occurredAt, окно),
        );
      }
      if (t === entity) {
        текущие = (текущие as Ent[]).filter((r) => строки.length === 0 || строки.includes(r.type));
      }
      return chain;
    };
    chain.groupBy = () => chain;
    chain.orderBy = (...выражения: unknown[]) => {
      // Направление берём ИЗ ВЫРАЖЕНИЯ, а не «журнал всегда свежими сверху»:
      // недельный блок читает `desc` (последний успех — первой строкой), а
      // дата начала журнала — `asc` (самый ранний прогон), и одна фиксированная
      // сортировка зеленила бы второй запрос на любой реализации.
      if (t === vendingSyncRun) {
        const текст = выражения.map(текстВыражения).join(" ");
        const вниз = !текст.includes("asc");
        текущие = [...(текущие as SyncRunRow[])].sort((a, b) =>
          вниз ? b.startedAt.getTime() - a.startedAt.getTime() : a.startedAt.getTime() - b.startedAt.getTime(),
        );
      }
      return chain;
    };
    // Стенд УВАЖАЕТ `limit` (ре-ревью T8, D3): без этого признак обрезки
    // журнала (`WEEK_RUNS_LIMIT + 1`) не проверялся бы ничем — стаб отдавал
    // бы фикстуру целиком, и `capped` зеленел бы на любой реализации.
    chain.limit = async (n: number) => (typeof n === "number" ? текущие.slice(0, n) : текущие);
    chain.then = (res: (v: unknown) => unknown) => Promise.resolve(текущие).then(res);
    return chain;
  };

  const счётчик = { select: 0 };
  const db = {
    select: () => ({
      from: (t: unknown) => {
        счётчик.select += 1;
        return цепочка(t, rowsOf(t));
      },
    }),
  } as never;
  return { db, счётчик };
}

const ЗДОРОВЬЕ: OurvendHealth = {
  runs: [],
  failedStreak: 12,
  lastSuccessAt: "2026-08-24T01:00:00.000Z",
  staleHours: 27,
  staleThresholdH: 6,
  slotsLagMin: 42,
  salesLagH: 27,
  // Режим `stock` (зеркало ещё живо) — застой снапшота там ничего не значит.
  snapshotStale: false,
  productSaleLagH: 27,
  // Серия оборвана: сводка недели, в которой сбор падал, не может звать
  // переключать учёт.
  parityStreak: 0,
  cutoverThreshold: 7,
  parity: { days: 7, ok: false, checked: 14, mismatches: 3, stockOk: false, stockChecked: 0, mode: "mirror", note: "снимков остатков нет" },
};

const сервис = (м: Мир, здоровьеПадает = false) => {
  const { db, счётчик } = digestDb(м);
  const health = {
    health: async () => {
      if (здоровьеПадает) throw new Error("паритет не посчитался");
      return м.health ?? ЗДОРОВЬЕ;
    },
  } as unknown as OurvendHealthService;
  const parity = {
    streak: async () => {
      if (м.паритетПадает) throw new Error("серия паритета не посчиталась");
      return {
        greenDays: 0,
        threshold: 7,
        readyForCutover: false,
        days: м.parityDays ?? [],
        lastRed: null,
        since: null,
      };
    },
  } as unknown as OurvendParityService;
  const svc = new WeeklyDigestService(db, new AnalyticsService(db, new VendingService(db)), health, parity);
  return Object.assign(svc, { счётчик });
};

/** Прогон сбора как строка журнала: успех датируется завершением, поэтому оно есть. */
const прогонСтрокой = (status: string, startedAt: string): SyncRunRow => ({
  status,
  startedAt: new Date(startedAt),
  finishedAt: new Date(startedAt),
  error: null,
});

const ДЕНЬ_ЗЕЛ = (date: string): ParityDay => ({ date, ok: true, salesChecked: 2, stockChecked: 68, note: null });
const ДЕНЬ_КРАС = (date: string): ParityDay => ({ date, ok: false, salesChecked: 2, stockChecked: 0, note: "снимков остатков нет" });

/** Вторник 25.08.2026, 12:00 Ташкента: неделя 2026-35 идёт, предыдущая — 2026-34. */
const СЕЙЧАС = new Date("2026-08-25T07:00:00.000Z");

const OLMA = "2508160376";
const AMERICAN = "2508160359";
const SKLAD = "2508160360";

const ПАРК: Ent[] = [
  { id: "m-olma", name: "Olma Администрация", externalRef: OLMA, type: "machine" },
  { id: "m-ah", name: "American Hospital", externalRef: AMERICAN, type: "machine" },
  { id: "e-sklad", name: "SKLAD 4S", externalRef: SKLAD, type: "machine" },
];
const СКЛАД_НЕ_В_СТРОЮ: Card[] = [{ entityId: "e-sklad", status: "warehouse" }];

const товар = (id: string, name: string, purchasePrice: string | null): ProdRow => ({
  id,
  name,
  purchasePrice,
  salePrice: null,
  packSize: 1,
  excludedFromPurchase: false,
  fixedPurchaseQty: null,
});

const ПРАЙС: ProdRow[] = [товар("p1", "Moxito Lime 330ml", "9800"), товар("p2", "Lays Сметана-лук", "13000")];

/**
 * Неделя 2026-34 (пн 17.08 — вс 23.08) и предыдущая 2026-33 (10–16.08).
 * Числа прод-порядка: продажи падают неделя к неделе.
 */
const НЕДЕЛИ_34_И_33: SaleRow[] = [
  { dt: "2026-08-18", machineSerial: OLMA, product: "Moxito Lime 330ml", qty: "100", amount: "1200000" },
  { dt: "2026-08-20", machineSerial: AMERICAN, product: "Lays Сметана-лук", qty: "40", amount: "600000" },
  { dt: "2026-08-11", machineSerial: OLMA, product: "Moxito Lime 330ml", qty: "150", amount: "1800000" },
  { dt: "2026-08-13", machineSerial: AMERICAN, product: "Lays Сметана-лук", qty: "50", amount: "750000" },
];

describe("Недельная сводка (R-P5b-7)", () => {
  it("без параметра берёт ПРЕДЫДУЩУЮ ISO-неделю по Ташкенту", async () => {
    const d = await сервис({ sales: НЕДЕЛИ_34_И_33, products: ПРАЙС, entities: ПАРК }).digest(undefined, СЕЙЧАС);
    assert.deepEqual(
      [d.week, d.from, d.to, d.previousWeek],
      ["2026-34", "2026-08-17", "2026-08-23", "2026-33"],
    );
  });

  it("боевые числа недели 2026-34 и дельта к 33-й", async () => {
    const d = await сервис({ sales: НЕДЕЛИ_34_И_33, products: ПРАЙС, entities: ПАРК }).digest("2026-34", СЕЙЧАС);

    assert.deepEqual(
      [d.totals.qty, d.totals.revenue, d.totals.cogs, d.totals.margin, d.totals.pct],
      [140, 1_800_000, 1_500_000, 300_000, 16.7],
    );
    assert.deepEqual([d.delta.qty, d.delta.revenue, d.delta.revenuePct], [-60, -750_000, -29.4]);
    assert.deepEqual(
      d.machines.map((m) => [m.name, m.qty, m.revenue, m.margin, m.pct]),
      [
        ["Olma Администрация", 100, 1_200_000, 220_000, 18.3],
        ["American Hospital", 40, 600_000, 80_000, 13.3],
      ],
      "автоматы идут по марже вниз, серийник и имя — из реестра",
    );
  });

  it("продажи склада-заглушки в неделю не входят (R-P5b-1)", async () => {
    const d = await сервис({
      sales: [
        ...НЕДЕЛИ_34_И_33,
        { dt: "2026-08-19", machineSerial: SKLAD, product: "Moxito Lime 330ml", qty: "1", amount: "12000" },
      ],
      products: ПРАЙС,
      entities: ПАРК,
      cards: СКЛАД_НЕ_В_СТРОЮ,
    }).digest("2026-34", СЕЙЧАС);

    assert.equal(d.totals.qty, 140, "строка SKLAD доехала до денег недели");
    assert.deepEqual(d.machines.map((m) => m.serial), [OLMA, AMERICAN]);
  });

  it("топ и худшие не пересекаются: два товара — топ есть, худших нет", async () => {
    const d = await сервис({ sales: НЕДЕЛИ_34_И_33, products: ПРАЙС, entities: ПАРК }).digest("2026-34", СЕЙЧАС);
    assert.deepEqual(d.topProducts.map((p) => p.product), ["Moxito Lime 330ml", "Lays Сметана-лук"]);
    assert.deepEqual(d.worstProducts, []);
  });

  it("товаров много — топ-5 сверху, худшие-3 снизу и в обратном порядке", async () => {
    const много: SaleRow[] = Array.from({ length: 9 }, (_, i) => ({
      dt: "2026-08-18",
      machineSerial: OLMA,
      product: `Товар ${i}`,
      // Маржа падает с ростом i: цена закупки одна, выручка разная.
      qty: "10",
      amount: String(200_000 - i * 10_000),
    }));
    const прайс = Array.from({ length: 9 }, (_, i) => товар(`p${i}`, `Товар ${i}`, "1000"));
    const d = await сервис({ sales: много, products: прайс, entities: ПАРК }).digest("2026-34", СЕЙЧАС);

    assert.deepEqual(d.topProducts.map((p) => p.product), ["Товар 0", "Товар 1", "Товар 2", "Товар 3", "Товар 4"]);
    assert.deepEqual(d.worstProducts.map((p) => p.product), ["Товар 8", "Товар 7", "Товар 6"]);
  });

  it("нет продаж за неделю — нули названы пустотой, а не «всё хорошо»", async () => {
    const d = await сервис({ sales: [], products: ПРАЙС, entities: ПАРК }).digest("2026-30", СЕЙЧАС);
    assert.deepEqual([d.machines.length, d.totals.revenue, d.totals.pct], [0, 0, null]);
    assert.deepEqual([d.week, d.previousWeek], ["2026-30", "2026-29"]);
  });

  it("негодный ключ недели не роняет чтение, а даёт предыдущую неделю", async () => {
    const d = await сервис({ sales: НЕДЕЛИ_34_И_33, products: ПРАЙС, entities: ПАРК }).digest("2026-99", СЕЙЧАС);
    assert.equal(d.week, "2026-34");
  });

  it("заливки: по снимкам и записанные мастером — разные числа", async () => {
    const d = await сервис({
      products: ПРАЙС,
      entities: ПАРК,
      refillEvents: [
        { machineSerial: OLMA, windowTo: new Date("2026-08-19T09:00:00Z"), units: 183, slots: [] },
        // Соседняя неделя: в сводку недели 34 попасть не должна.
        { machineSerial: OLMA, windowTo: new Date("2026-08-24T09:00:00Z"), units: 99, slots: [] },
      ],
      refills: [{ qty: 40, performedAt: new Date("2026-08-19T10:00:00Z") }],
    }).digest("2026-34", СЕЙЧАС);

    assert.deepEqual(
      [d.refills.events, d.refills.detectedUnits, d.refills.recordedUnits],
      [1, 183, 40],
      "заливка соседней недели просочилась в окно",
    );
  });

  it("приходы и инвентаризации считаются по неделе; позиция без цены даёт штуки, но не деньги", async () => {
    const d = await сервис({
      products: ПРАЙС,
      entities: ПАРК,
      orders: [
        {
          status: "received",
          receivedAt: момент("2026-08-19"),
          positions: [
            { product: "Moxito Lime 330ml", order: 240, price: 9800 },
            { product: "Без цены", order: 60, price: 0 },
          ],
        },
        { status: "received", receivedAt: момент("2026-08-24"), positions: [{ product: "Lays", order: 10, price: 13000 }] },
      ],
      // Инвентаризации считаются по ИСТОРИИ (R-FW-P4): `vending_stock`
      // перезаписной и на вопрос «сколько раз считали НА ТОЙ неделе» не отвечает.
      stockCounts: [
        { dt: "2026-08-21", countedAt: момент("2026-08-21") },
        { dt: "2026-08-22", countedAt: момент("2026-08-22") },
        { dt: "2026-08-24", countedAt: момент("2026-08-24") },
      ],
    }).digest("2026-34", СЕЙЧАС);

    assert.deepEqual([d.intake.orders, d.intake.units, d.intake.amount], [1, 300, 2_352_000]);
    assert.deepEqual(
      [d.stocktakes.positions, d.stocktakes.lastCountedAt],
      [2, момент("2026-08-22").toISOString()],
    );
  });

  it("инвентаризации считаются по ИСТОРИИ склада, а не по перезаписной таблице (R-FW-P4)", async () => {
    // `vending_stock` перезаписной: 20 строк с датой последнего пересчёта. Письмо
    // о ЛЮБОЙ прошлой неделе говорило по нему «инвентаризаций 0», хотя история
    // за те недели есть (прод: 460 строк на 20 дат), а число текущей недели
    // менялось задним числом на следующем пересчёте.
    const d = await сервис({
      products: ПРАЙС,
      entities: ПАРК,
      // Перезаписная таблица говорит про СЕГОДНЯ — и в неделю 2026-34 не попадает.
      stock: [{ productName: "Moxito Lime 330ml", quantity: 12, countedAt: момент("2026-08-25") }],
      stockCounts: [
        { dt: "2026-08-18", countedAt: момент("2026-08-18") },
        { dt: "2026-08-22", countedAt: момент("2026-08-22") },
        // Соседняя неделя — в окно не входит.
        { dt: "2026-08-24", countedAt: момент("2026-08-24") },
      ],
    }).digest("2026-34", СЕЙЧАС);

    assert.deepEqual(
      [d.stocktakes.positions, d.stocktakes.lastCountedAt],
      [2, момент("2026-08-22").toISOString()],
      "строка соседней недели просочилась в окно либо счёт по-прежнему идёт по vending_stock",
    );
  });

  it("мёртвый сток — топ-5 по оценке из обеих половин, итог по всему стоку", async () => {
    const склад: StockRow[] = [
      { productName: "Moxito Lime 330ml", quantity: 100, countedAt: момент("2026-08-01") },
      { productName: "Lays Сметана-лук", quantity: 10, countedAt: момент("2026-08-01") },
    ];
    const d = await сервис({ products: ПРАЙС, entities: ПАРК, stock: склад }).digest("2026-34", СЕЙЧАС);

    assert.deepEqual(
      d.deadStock.rows.map((r) => [r.product, r.value]),
      [
        ["Moxito Lime 330ml", 980_000],
        ["Lays Сметана-лук", 130_000],
      ],
      "дороже — выше, независимо от того, склад это или автомат",
    );
    assert.equal(d.deadStock.totalValue, 1_110_000);
  });

  it("цены режутся по НЕДЕЛЕ: изменение после воскресенья в письмо не попадает", async () => {
    const d = await сервис({
      sales: НЕДЕЛИ_34_И_33,
      products: ПРАЙС,
      entities: ПАРК,
      events: [
        {
          type: "vending.price_changed",
          payload: { product: "Moxito Lime 330ml", oldPrice: 9000, newPrice: 9800 },
          occurredAt: момент("2026-08-18"),
        },
        {
          type: "vending.price_changed",
          payload: { product: "Lays Сметана-лук", oldPrice: 12_000, newPrice: 13_000 },
          occurredAt: момент("2026-08-24"),
        },
      ],
    }).digest("2026-34", СЕЙЧАС);

    assert.deepEqual(
      d.priceChanges.purchase.map((c) => [c.product, c.from, c.to, c.at]),
      [["Moxito Lime 330ml", 9000, 9800, "2026-08-18"]],
      "изменение понедельника СЛЕДУЮЩЕЙ недели просочилось в сводку",
    );
  });

  it("здоровье сбора едет в сводке целиком — паритет объектом, а не null", async () => {
    const d = await сервис({ sales: НЕДЕЛИ_34_И_33, products: ПРАЙС, entities: ПАРК }).digest("2026-34", СЕЙЧАС);
    assert.equal(d.health.failedStreak, 12);
    assert.deepEqual(
      [d.health.parity.days, d.health.parity.mismatches, d.health.parity.stockOk],
      [7, 3, false],
    );
  });

  it("границы недели: продажи 17.08 и 23.08 внутри, 16.08 и 24.08 снаружи", async () => {
    // Сдвиг окна на сутки в любую сторону меняет ЧИСЛА — иначе тест зелен и на
    // сдвинутом окне (именно так граница и уезжает незаметно).
    const края: SaleRow[] = [
      { dt: "2026-08-16", machineSerial: OLMA, product: "Moxito Lime 330ml", qty: "1", amount: "12000" },
      { dt: "2026-08-17", machineSerial: OLMA, product: "Moxito Lime 330ml", qty: "10", amount: "120000" },
      { dt: "2026-08-23", machineSerial: OLMA, product: "Moxito Lime 330ml", qty: "20", amount: "240000" },
      { dt: "2026-08-24", machineSerial: OLMA, product: "Moxito Lime 330ml", qty: "100", amount: "1200000" },
    ];
    const d = await сервис({ sales: края, products: ПРАЙС, entities: ПАРК }).digest("2026-34", СЕЙЧАС);
    assert.deepEqual([d.totals.qty, d.totals.revenue], [30, 360_000], "в неделю вошли ровно понедельник и воскресенье");
  });

  it("неделя из будущего и текущая гасятся в предыдущую — как негодный ключ", async () => {
    const s = сервис({ sales: НЕДЕЛИ_34_И_33, products: ПРАЙС, entities: ПАРК });
    // 2026-35 идёт ПРЯМО СЕЙЧАС (пн 24.08), она ещё не прожита.
    assert.equal((await s.digest("2026-35", СЕЙЧАС)).week, "2026-34");
    assert.equal((await s.digest("2027-05", СЕЙЧАС)).week, "2026-34");
  });

  it("неделя старше двух лет гасится в предыдущую, ровно на границе — пропускается", async () => {
    const s = сервис({ sales: [], products: ПРАЙС, entities: ПАРК });
    // 104 недели назад от 2026-34 — это 2024-34 (пн 19.08.2024): последняя годная.
    assert.equal((await s.digest("2024-34", СЕЙЧАС)).week, "2024-34");
    assert.equal((await s.digest("2024-33", СЕЙЧАС)).week, "2026-34", "105 недель назад — уже вне диапазона");
    assert.equal((await s.digest("1990-01", СЕЙЧАС)).week, "2026-34");
  });

  it("здоровье сбора упало — письмо уходит, секция деградирует и говорит об этом", async () => {
    const d = await сервис({ sales: НЕДЕЛИ_34_И_33, products: ПРАЙС, entities: ПАРК }, true).digest("2026-34", СЕЙЧАС);

    assert.equal(d.totals.qty, 140, "деньги недели посчитаны и от здоровья сбора не зависят");
    assert.deepEqual(
      [d.health.runs.length, d.health.failedStreak, d.health.lastSuccessAt, d.health.slotsLagMin],
      [0, 0, null, null],
      "заглушка обязана читаться как «оценить нечем», а не как «всё хорошо»",
    );
    assert.equal(d.health.parity.stockChecked, 0);
    assert.deepEqual(d.warnings.map((w) => w.code), ["health_unavailable"]);
    assert.match(d.warnings[0]!.message, /паритет не посчитался/);
  });

  it("здоровье посчиталось — предупреждений нет", async () => {
    const d = await сервис({ sales: НЕДЕЛИ_34_И_33, products: ПРАЙС, entities: ПАРК }).digest("2026-34", СЕЙЧАС);
    assert.deepEqual(d.warnings, []);
  });

  it("кеш: два запроса одной недели — один расчёт", async () => {
    const s = сервис({ sales: НЕДЕЛИ_34_И_33, products: ПРАЙС, entities: ПАРК });
    await s.digest("2026-34", СЕЙЧАС);
    const было = s.счётчик.select;
    await s.digest("2026-34", СЕЙЧАС);

    assert.equal(s.счётчик.select, было);
    await s.digest("2026-33", СЕЙЧАС);
    assert.ok(s.счётчик.select > было, "другая неделя — другой расчёт, кеш не должен её подменять");
  });
});


/** Мир с деньгами недели 2026-34: недельный блок здоровья их портить не должен. */
const ДЕНЬГИ_34 = { sales: НЕДЕЛИ_34_И_33, products: ПРАЙС, entities: ПАРК };

describe("Здоровье сбора в письме — за ОТЧЁТНУЮ неделю (R-H-9)", () => {
  it("прогоны считаются по окну [понедельник, следующий понедельник)", async () => {
    // Полуинтервал: прогон в полночь понедельника СЛЕДУЮЩЕЙ недели в неделю
    // НЕ входит — иначе он посчитался бы в обеих.
    const d = await сервис({
      ...ДЕНЬГИ_34,
      runs: [
        прогонСтрокой("success", "2026-08-17T00:00:00+05:00"),
        прогонСтрокой("failed", "2026-08-23T23:00:00+05:00"),
        прогонСтрокой("success", "2026-08-24T00:00:00+05:00"),
      ],
    }).digest("2026-34", СЕЙЧАС);
    assert.deepEqual([d.weekHealth.runs, d.weekHealth.success, d.weekHealth.failed], [2, 1, 1]);
    assert.equal(d.weekHealth.week, "2026-34");
  });

  it("авария ТЕКУЩЕЙ недели не попадает в письмо о ПРОШЛОЙ — регресс на дефект O7", async () => {
    // Письмо про 2026-34 уходит в понедельник 35-й. До правки блок здоровья
    // был подписан неделей, а числа брал моментом отправки, и владелец искал
    // аварию в логах не того дня.
    const d = await сервис({
      ...ДЕНЬГИ_34,
      runs: [
        прогонСтрокой("success", "2026-08-20T04:00:00+05:00"),
        прогонСтрокой("failed", "2026-08-25T04:00:00+05:00"),
        прогонСтрокой("failed", "2026-08-25T07:00:00+05:00"),
      ],
      health: { ...ЗДОРОВЬЕ, failedStreak: 2 },
    }).digest("2026-34", СЕЙЧАС);
    assert.deepEqual([d.weekHealth.failed, d.weekHealth.worstFailedStreak], [0, 0]);
    assert.equal(d.health.failedStreak, 2, "«сейчас» осталось «сейчас» — два разных набора чисел в одном ответе");
  });

  it("данные НЕДЕЛИ, а не вообще: null — данные в неделю не приезжали ВОВСЕ", async () => {
    const d = await сервис({
      ...ДЕНЬГИ_34,
      runs: [прогонСтрокой("failed", "2026-08-20T04:00:00+05:00")],
    }).digest("2026-34", СЕЙЧАС);
    assert.equal(d.weekHealth.lastDataAt, null);
    assert.equal(d.weekHealth.runs, 1, "прогон был — просто неуспешный; это не «сбор не запускался»");
  });

  it("данные датируются ЗАВЕРШЕНИЕМ прогона — тем же правилом, что и «сейчас»", async () => {
    const d = await сервис({
      ...ДЕНЬГИ_34,
      runs: [
        {
          status: "success",
          startedAt: new Date("2026-08-23T03:05:00Z"),
          finishedAt: new Date("2026-08-23T03:07:00Z"),
          error: null,
        },
      ],
    }).digest("2026-34", СЕЙЧАС);
    assert.equal(d.weekHealth.lastDataAt, "2026-08-23T03:07:00.000Z");
  });

  it("неделя из одних `partial`: успехов 0, а данные всё это время ПРИЕЗЖАЛИ", async () => {
    // Разряд `success` строгий, `lastDataAt` — «донёс данные». Одно слово на
    // два смысла дало бы «успешных 0» и «последний успех 23.08» в одном блоке.
    const d = await сервис({
      ...ДЕНЬГИ_34,
      runs: [
        прогонСтрокой("partial", "2026-08-23T03:05:00+05:00"),
        прогонСтрокой("partial", "2026-08-21T03:05:00+05:00"),
      ],
    }).digest("2026-34", СЕЙЧАС);
    assert.deepEqual([d.weekHealth.success, d.weekHealth.partial], [0, 2]);
    assert.equal(d.weekHealth.lastDataAt, "2026-08-22T22:05:00.000Z");
  });

  it("`runs` — сумма разрядов, зависший прогон назван отдельно", async () => {
    // «прогонов 4 · успешных 2 · частичных 0 · отказов 1» не сходилось бы, а
    // незакрытый прогон ПРОШЛОЙ недели — сигнал сам по себе.
    const d = await сервис({
      ...ДЕНЬГИ_34,
      runs: [
        прогонСтрокой("success", "2026-08-23T03:05:00+05:00"),
        прогонСтрокой("running", "2026-08-22T03:05:00+05:00"),
        прогонСтрокой("failed", "2026-08-21T03:05:00+05:00"),
        прогонСтрокой("success", "2026-08-20T03:05:00+05:00"),
      ],
    }).digest("2026-34", СЕЙЧАС);
    const w = d.weekHealth;
    assert.deepEqual([w.runs, w.success, w.partial, w.failed, w.running], [4, 2, 0, 1, 1]);
    assert.equal(w.runs, w.success + w.partial + w.failed + w.running);
  });

  it("прогонов больше потолка чтения: capped и предупреждение, а не молчаливая обрезка", async () => {
    // 201 прогон недели: числа блока честно считаются по свежим 200, но
    // «отказов 3» при зациклившемся кроне обязано быть подписано.
    const много = Array.from({ length: 201 }, (_, i) =>
      прогонСтрокой(i < 3 ? "failed" : "success", new Date(Date.UTC(2026, 7, 16, 19, i)).toISOString()),
    );
    const d = await сервис({ ...ДЕНЬГИ_34, runs: много }).digest("2026-34", СЕЙЧАС);
    assert.equal(d.weekHealth.capped, true);
    assert.equal(d.weekHealth.runs, 200, "в счёт ушёл свежий хвост окна, а не всё, что прочитали");
    assert.ok(d.warnings.some((w) => w.code === "history_capped" && /потолка чтения/.test(w.message)));
  });

  it("прогонов ровно по потолок — capped НЕ взводится и предупреждения нет", async () => {
    // Граница: «ровно 200» — посчитанный результат, а не обрезанный. Числа
    // пришпилены к самой константе, а не к литералу рядом: подъём потолка
    // иначе оставил бы тест зелёным про другое число.
    const ровно = Array.from({ length: WEEK_RUNS_LIMIT }, (_, i) =>
      прогонСтрокой("success", new Date(Date.UTC(2026, 7, 16, 19, i)).toISOString()),
    );
    const d = await сервис({ ...ДЕНЬГИ_34, runs: ровно }).digest("2026-34", СЕЙЧАС);
    assert.deepEqual([d.weekHealth.capped, d.weekHealth.runs], [false, WEEK_RUNS_LIMIT]);
    assert.deepEqual(d.warnings, []);
  });

  it("журнал не достаёт до недели: `journalSince` и предупреждение вместо голого нуля (R-FW-P5)", async () => {
    // Прод: журнал `vending_sync_run` начинается 06.08.2026, а `?week=`
    // пускает 104 недели назад — любая неделя до этой даты отдавала `runs: 0`
    // и ни слова о причине. Соседний блок (паритет) ровно этот случай уже
    // называет словами.
    const d = await сервис({
      ...ДЕНЬГИ_34,
      runs: [прогонСтрокой("success", "2026-08-06T23:08:00+05:00"), прогонСтрокой("success", "2026-08-20T03:05:00+05:00")],
    }).digest("2026-31", СЕЙЧАС);

    assert.equal(d.weekHealth.week, "2026-31");
    assert.equal(d.weekHealth.runs, 0);
    assert.equal(d.weekHealth.journalSince, "2026-08-06", "дата берётся из САМОГО РАННЕГО прогона журнала");
    assert.ok(
      d.warnings.some((w) => w.code === "journal_short" && /журнал прогонов начинается с 06\.08\.2026/i.test(w.message)),
      `предупреждения о начале журнала нет: ${JSON.stringify(d.warnings)}`,
    );
  });

  it("неделя ВНУТРИ журнала предупреждения не получает, а дату начала всё равно несёт", async () => {
    const d = await сервис({
      ...ДЕНЬГИ_34,
      runs: [прогонСтрокой("success", "2026-08-06T23:08:00+05:00"), прогонСтрокой("success", "2026-08-20T03:05:00+05:00")],
    }).digest("2026-34", СЕЙЧАС);
    assert.equal(d.weekHealth.journalSince, "2026-08-06");
    assert.equal(
      d.warnings.some((w) => /журнал прогонов начинается/i.test(w.message)),
      false,
      "неделя внутри журнала — предупреждать не о чем",
    );
  });

  it("журнал пуст ВОВСЕ — `journalSince` null, а не выдуманная дата", async () => {
    const d = await сервис({ ...ДЕНЬГИ_34, runs: [] }).digest("2026-34", СЕЙЧАС);
    assert.equal(d.weekHealth.journalSince, null);
    assert.equal(d.weekHealth.runs, 0);
  });

  it("понедельничное письмо — про ЗАКОНЧЕННУЮ неделю: partialWeek false", async () => {
    // `нормализоватьНеделю` гасит текущую и будущую неделю в предыдущую,
    // поэтому сегодня флаг взвестись не может. Тест — сторож на случай, если
    // это когда-нибудь изменят: «отказов 0» за неполную неделю читалось бы
    // как итог семи суток.
    const d = await сервис(ДЕНЬГИ_34).digest(undefined, СЕЙЧАС);
    assert.deepEqual([d.week, d.weekHealth.partialWeek], ["2026-34", false]);
    assert.equal((await сервис(ДЕНЬГИ_34).digest("2026-35", СЕЙЧАС)).weekHealth.partialWeek, false);
  });

  it("прогонов на неделе не было ВОВСЕ — нули и null, а не «всё хорошо»", async () => {
    const d = await сервис(ДЕНЬГИ_34).digest("2026-34", СЕЙЧАС);
    const w = d.weekHealth;
    assert.deepEqual([w.runs, w.success, w.partial, w.failed, w.running, w.lastDataAt], [0, 0, 0, 0, 0, null]);
  });

  it("дни паритета режутся неделей и считаются зелёными/красными", async () => {
    const d = await сервис({
      ...ДЕНЬГИ_34,
      parityDays: [ДЕНЬ_ЗЕЛ("2026-08-22"), ДЕНЬ_КРАС("2026-08-21"), ДЕНЬ_ЗЕЛ("2026-08-25")],
    }).digest("2026-34", СЕЙЧАС);
    assert.deepEqual(d.weekHealth.parityDays.map((x) => x.date), ["2026-08-22", "2026-08-21"]);
    assert.deepEqual([d.weekHealth.parityGreen, d.weekHealth.parityRed], [1, 1]);
  });

  it("неделя вне окна счёта серии: parityDays пуст И в warnings есть health_unavailable", async () => {
    const d = await сервис({ ...ДЕНЬГИ_34, parityDays: [ДЕНЬ_ЗЕЛ("2026-08-25")] }).digest("2026-28", СЕЙЧАС);
    assert.deepEqual(d.weekHealth.parityDays, []);
    assert.ok(
      d.warnings.some((w) => w.code === "health_unavailable" && /не достаёт до этой недели/.test(w.message)),
      "молчаливый пустой список читается как «сверки не было»",
    );
    // UX-5: строка обязана звать туда, куда владелец может дойти.
    assert.ok(
      d.warnings.some((w) => /команда «сверка» в боте/.test(w.message)),
      "предупреждение без действия — это отказ, притворяющийся подсказкой",
    );
  });

  it("неделя В окне, а дней просто нет — молчим: «сверки не было» скажет здоровье момента", async () => {
    // Ложное предупреждение на каждой неделе без сверки обесценило бы то
    // единственное, ради которого оно заведено.
    const d = await сервис(ДЕНЬГИ_34).digest("2026-34", СЕЙЧАС);
    assert.deepEqual(d.weekHealth.parityDays, []);
    assert.deepEqual(d.warnings, []);
  });

  it("ни одно предупреждение письма не отправляет владельца по адресу роута (UX-5)", async () => {
    // `/ourvend/health` и `/ourvend/parity/streak` — внутренние JSON-эндпоинты
    // Core за докер-сетью: владелец их не откроет ничем. Собираем предупреждения
    // ВСЕХ ветвей письма разом — отказ здоровья «сейчас», отказ дней паритета,
    // неделя вне окна серии, обрезка журнала — и проверяем, что ни одна строка
    // не зовёт туда, куда не попасть.
    const много = Array.from({ length: WEEK_RUNS_LIMIT + 1 }, (_, i) =>
      прогонСтрокой("success", new Date(Date.UTC(2026, 6, 6, 19, i)).toISOString()),
    );
    const наборы = [
      await сервис({ ...ДЕНЬГИ_34, parityDays: [ДЕНЬ_ЗЕЛ("2026-08-25")] }).digest("2026-28", СЕЙЧАС),
      await сервис({ ...ДЕНЬГИ_34, паритетПадает: true }).digest("2026-34", СЕЙЧАС),
      await сервис(ДЕНЬГИ_34, true).digest("2026-34", СЕЙЧАС),
      await сервис({ ...ДЕНЬГИ_34, журналПадает: true }).digest("2026-34", СЕЙЧАС),
      await сервис({ ...ДЕНЬГИ_34, runs: много }).digest("2026-28", СЕЙЧАС),
    ];
    const строки = наборы.flatMap((d) => d.warnings.map((w) => w.message));
    assert.ok(строки.length >= 5, `предупреждений собралось ${строки.length} — ветки перестали срабатывать`);
    for (const строка of строки) {
      assert.equal(
        /\/(ourvend|vending|system)\//.test(строка),
        false,
        `предупреждение зовёт по адресу роута: ${строка}`,
      );
    }
  });

  it("упал ТОЛЬКО паритет — прогоны недели остаются настоящими (ревью M1)", async () => {
    // Под общим `catch` отказ скана `event` обнулял бы и прогоны, и письмо
    // печатало бы «за неделю прогонов не было — сбор не запускался» о неделе,
    // в которой сбор отработал трижды. Владелец шёл бы чинить рабочий крон.
    const d = await сервис({
      ...ДЕНЬГИ_34,
      runs: [
        прогонСтрокой("success", "2026-08-20T04:00:00+05:00"),
        прогонСтрокой("failed", "2026-08-21T04:00:00+05:00"),
        прогонСтрокой("failed", "2026-08-21T07:00:00+05:00"),
      ],
      parityDays: [ДЕНЬ_ЗЕЛ("2026-08-22")],
      паритетПадает: true,
    }).digest("2026-34", СЕЙЧАС);

    const w = d.weekHealth;
    assert.deepEqual([w.runs, w.success, w.failed, w.worstFailedStreak], [3, 1, 2, 2]);
    assert.equal(w.lastDataAt, "2026-08-19T23:00:00.000Z", "успех недели никуда не делся");
    assert.deepEqual([w.parityDays, w.parityGreen, w.parityRed], [[], 0, 0], "пропала только сверка");
    assert.ok(
      d.warnings.some((x) => x.code === "health_unavailable" && /Дни паритета за неделю 2026-34 не посчитались/.test(x.message)),
      "причина обязана быть названа и назвать ИМЕННО паритет",
    );
  });

  it("падение недельного здоровья не роняет письмо: деньги недели на месте, причина в warnings", async () => {
    const d = await сервис({ ...ДЕНЬГИ_34, журналПадает: true }).digest("2026-34", СЕЙЧАС);
    assert.ok(d.totals.revenue > 0, "деньги недели от секции здоровья не зависят");
    assert.deepEqual([d.weekHealth.runs, d.weekHealth.lastDataAt], [0, null]);
    assert.ok(d.warnings.some((w) => w.code === "health_unavailable"));
    assert.equal(d.weekHealth.week, "2026-34", "подпись недели остаётся даже у несчитанного блока");
    assert.equal(d.weekHealth.capped, false, "потолок не срабатывал — читать не вышло вовсе");
  });

  it("упали ОБЕ секции здоровья — оба предупреждения, а не первое из двух", async () => {
    const d = await сервис({ ...ДЕНЬГИ_34, журналПадает: true }, true).digest("2026-34", СЕЙЧАС);
    assert.equal(d.warnings.length, 2);
    assert.deepEqual(d.warnings.map((w) => w.code), ["health_unavailable", "health_unavailable"]);
  });
});
