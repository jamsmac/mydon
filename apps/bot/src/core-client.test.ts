import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type {
  AnalyticsWarning as SharedAnalyticsWarning,
  BootstrapSalePriceResult as SharedBootstrapSalePriceResult,
  MonthlyPrice as SharedMonthlyPrice,
  OurvendHealth as SharedOurvendHealth,
  OurvendSyncRun as SharedOurvendSyncRun,
  PurchasePlan as SharedPurchasePlan,
  PurchaseSummary as SharedPurchaseSummary,
  SetSalePriceResult as SharedSetSalePriceResult,
  ShrinkReport as SharedShrinkReport,
} from "@mydon/shared";
import {
  CancelVendingRecordError,
  CoreClient,
  NotAMachineError,
  type AnalyticsWarning,
  type BootstrapSalePriceResult,
  type EntityRow,
  type MonthlyPrice,
  type OurvendHealth,
  type OurvendSyncRun,
  type SetSalePriceResult,
  type ShrinkReport,
  type VendingPlan,
  type VendingPurchase,
} from "./core-client";

/**
 * Клиент Core: проверяем ровно то, что решает судьбу записи в поле, — как
 * склеивается путь запроса и чему верим в ответе. Остальные методы проверяются
 * через мастера, у которых `core` подменён целиком.
 */

const настоящийFetch = globalThis.fetch;

/** Подмена fetch: отдаём готовую карточку и запоминаем запрошенный путь. */
function стубFetch(row: Partial<EntityRow>): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    urls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: "e1", type: "machine", name: "Olma", externalRef: null, attrs: {}, ...row }),
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  return { urls };
}

/** Подмена fetch: запоминает URL и тело запроса, отдаёт готовый JSON-ответ. */
function стубFetchТело(status: number, body: unknown): { calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  return { calls };
}

afterEach(() => {
  globalThis.fetch = настоящийFetch;
});

/**
 * Проводка автора (Task 7, Отклонение №9): `personId`/`createdBy` уезжают в
 * тело POST, только когда бот их резолвил — старое поведение (без автора)
 * не должно измениться для тех, у кого карточки нет.
 */
describe("Проводка автора: setVendingStock/recordVendingCash (Task 7)", () => {
  it("setVendingStock шлёт personId, когда передан", async () => {
    const { calls } = стубFetchТело(200, { items: 1, adjustments: [] });
    const core = new CoreClient("http://core", 1000, "");
    await core.setVendingStock([{ product: "Snickers", quantity: 5 }], "p1");
    const body = JSON.parse(String(calls[0]!.init!.body)) as { personId?: string };
    assert.equal(body.personId, "p1");
  });

  it("recordVendingCash шлёт createdBy, когда передан", async () => {
    const { calls } = стубFetchТело(200, {
      id: "cs1", receivedAmount: 100_000, categories: [], totalSpent: 0, remainder: 100_000,
      source: "own", createdBy: "person:p1", createdAt: "2026-08-26T10:00:00Z",
    });
    const core = new CoreClient("http://core", 1000, "");
    await core.recordVendingCash(100_000, [], "person:p1");
    const body = JSON.parse(String(calls[0]!.init!.body)) as { createdBy?: string };
    assert.equal(body.createdBy, "person:p1");
  });

  it("оба поля не попадают в тело, когда не переданы (обратная совместимость)", async () => {
    const stockFetch = стубFetchТело(200, { items: 1, adjustments: [] });
    const core = new CoreClient("http://core", 1000, "");
    await core.setVendingStock([{ product: "Snickers", quantity: 5 }]);
    const stockBody = JSON.parse(String(stockFetch.calls[0]!.init!.body)) as Record<string, unknown>;
    assert.ok(!("personId" in stockBody));

    const cashFetch = стубFetchТело(200, {
      id: "cs1", receivedAmount: 100_000, categories: [], totalSpent: 0, remainder: 100_000,
      source: "own", createdBy: "owner", createdAt: "2026-08-26T10:00:00Z",
    });
    await core.recordVendingCash(100_000, []);
    const cashBody = JSON.parse(String(cashFetch.calls[0]!.init!.body)) as Record<string, unknown>;
    assert.ok(!("createdBy" in cashBody));
  });
});

describe("cancelVendingRecord: отказ Core разбирается в структурную причину (Task 7)", () => {
  it("403 too_old — CancelVendingRecordError с распознанными reason/hours", async () => {
    стубFetchТело(403, { reason: "too_old", hours: 24, message: "Записи старше 24 часов отменяет владелец" });
    const core = new CoreClient("http://core", 1000, "");
    await assert.rejects(
      () => core.cancelVendingRecord("refill", "r1", "p1"),
      (e: unknown) => e instanceof CancelVendingRecordError && e.status === 403 && e.body.reason === "too_old" && e.body.hours === 24,
    );
  });

  it("путь маршрута зависит от вида записи", async () => {
    const { calls } = стубFetchТело(200, { ok: true, kind: "stock_count", stornoId: "s1", label: "…", alreadyCancelled: false });
    const core = new CoreClient("http://core", 1000, "");
    await core.cancelVendingRecord("stock_count", "c1", "p1");
    assert.equal(calls[0]!.url, "http://core/vending/stock-counts/c1/cancel");
  });
});

describe("Серийник автомата по карточке", () => {
  it("id уезжает в путь закодированным (S7)", async () => {
    // Сегодня пикер пропускает только id-подобное, но метод публичный и живёт
    // дольше своего вызывающего: незакодированный сегмент однажды позволит
    // дописать к пути что угодно.
    const { urls } = стубFetch({ externalRef: "c2508160376" });
    const core = new CoreClient("http://core", 1000, "");
    await core.machineSerial("11111111-1111-4111-8111-111111111111/../vending/refills?x=1");
    assert.equal(
      urls[0],
      "http://core/entities/11111111-1111-4111-8111-111111111111%2F..%2Fvending%2Frefills%3Fx%3D1",
    );
  });

  it("серийник приводится к канону", async () => {
    стубFetch({ externalRef: "C2508160376" });
    const core = new CoreClient("http://core", 1000, "");
    assert.equal(await core.machineSerial("e1"), "2508160376");
  });

  it("карточка не автомата — отказ, а не чужой externalRef (S7)", async () => {
    // Иначе заливка легла бы на код склада или помещения: запись есть, автомата
    // за ней нет, и найти её потом нечем.
    стубFetch({ type: "warehouse", externalRef: "SKLAD-1" });
    const core = new CoreClient("http://core", 1000, "");
    await assert.rejects(() => core.machineSerial("e1"), NotAMachineError);
  });
});

/**
 * Зеркала типов аналитики — реэкспорт из `@mydon/shared` (N4).
 *
 * Проверка КОМПИЛЯТОРНАЯ, а не по строкам: значение объявляется общим типом
 * пакета и присваивается локальному имени. Разъезд полей (переименование,
 * новое обязательное поле, другой литерал статуса) не доживёт до прода —
 * `pnpm --filter @mydon/bot build` упадёт здесь, а не в понедельник утром на
 * недельной сводке.
 */
describe("Формы аналитики приходят из @mydon/shared", () => {
  it("WeeklyDigest/OurvendHealth/MonthlyPrice/AnalyticsWarning — те же типы", () => {
    const прогон: SharedOurvendSyncRun = {
      id: "r1",
      startedAt: "2026-08-25T16:00:00Z",
      finishedAt: "2026-08-25T16:00:11Z",
      status: "success",
      machinesTotal: 5,
      machinesOk: 5,
      durationMs: 11_400,
      error: null,
    };
    const здоровье: SharedOurvendHealth = {
      runs: [прогон],
      failedStreak: 0,
      lastSuccessAt: "2026-08-25T16:00:11Z",
      staleHours: 0,
      staleThresholdH: 6,
      slotsLagMin: 12,
      salesLagH: 13,
      snapshotStale: false,
      productSaleLagH: 0.2,
      parityStreak: 3,
      cutoverThreshold: 7,
      parityLastRed: "2026-08-25",
      parityStreakSince: "2026-08-26",
      parity: { days: 7, ok: false, mismatches: 0, stockOk: false, checked: 0, stockChecked: 0, mode: "mirror", note: null },
    };
    // Локальные имена — те же типы: присваивание в обе стороны компилируется.
    const местное: OurvendSyncRun = прогон;
    const местноеЗдоровье: OurvendHealth = здоровье;
    const цена: MonthlyPrice = { product: "TUC", month: "2026-07", retail: 13_000, purchase: null };
    const общаяЦена: SharedMonthlyPrice = цена;
    const тревога: AnalyticsWarning = { code: "no_sales", message: "продаж нет" };
    const общаяТревога: SharedAnalyticsWarning = тревога;
    // Причины отказа и пропуска — литералы Core, а не строки бота: новая
    // причина в Core обязана сломать сборку бота, иначе он напечатает
    // «пропущено 5: A 2, B 1» и потеряет две позиции молча (S9).
    const эталон: SetSalePriceResult = { ok: false, product: "TUC", reason: "invalid_price", message: "цена должна быть больше нуля" };
    const общийЭталон: SharedSetSalePriceResult = эталон;
    const бутстрап: BootstrapSalePriceResult = {
      days: 14,
      set: [],
      skipped: [
        { product: "A", reason: "already_set" },
        { product: "B", reason: "no_sales" },
        { product: "C", reason: "no_fact" },
        { product: "D", reason: "inactive" },
      ],
    };
    const общийБутстрап: SharedBootstrapSalePriceResult = бутстрап;
    assert.equal(общийЭталон.reason, "invalid_price");
    assert.equal(общийБутстрап.skipped.length, 4);
    assert.equal(местное.status, "success");
    assert.equal(местноеЗдоровье.failedStreak, 0);
    assert.equal(общаяЦена.month, "2026-07");
    assert.equal(общаяТревога.code, "no_sales");
  });

  it("усушка и план закупа — те же формы: бот их читает, а не переписывает (сторож двусторонний)", () => {
    // Свои копии этих форм бот держал ровно до тех пор, пока их не было в
    // общем пакете. Разъезжались они молча: `formatShrinkage` печатал бы
    // пустую строку там, где Core переименовал поле, — и узнал бы об этом
    // владелец, а не сборка.
    //
    // Присваивание идёт в ОБЕ стороны — это проверка ТОЖДЕСТВА форм.
    // Одностороннее («общая → ботовская») ловит переименование и лишнее
    // обязательное поле в копии, но копия, у которой поля НЕ ХВАТАЕТ, приняла
    // бы общее значение молча: обычная структурная совместимость. Именно так
    // разъехался закуп — семь полей копия просто не описывала.
    const усушкаОбщая: SharedShrinkReport = {
      from: "2026-08-11",
      to: "2026-08-24",
      threshold: 30_000,
      machines: [
        {
          serial: "2508160376",
          name: "Olma",
          summary: {
            items: [{ product: "Kinder Bueno", lossUnits: 9, lossValue: 99_000, surplusUnits: 0, daysCounted: 9, noPrice: false, alert: true }],
            lossValue: 99_000,
            daysCounted: 9,
            daysSkipped: 5,
            threshold: 30_000,
          },
          refillDays: [{ date: "2026-08-19", detectedUnits: 183, recordedUnits: 0 }],
        },
      ],
      warnings: [{ code: "no_counted_days", message: "все дни были заливкой" }],
    };
    const усушкаБота: ShrinkReport = усушкаОбщая;
    const планОбщий: SharedPurchasePlan = {
      generatedAt: "2026-08-25T09:00:00.000Z",
      stock: { asOf: "2026-08-22T09:40:00.000Z", totalBefore: 120, use: 40, back: 12, totalAfter: 92, stale: false, unmatched: 0 },
      summary: {
        items: [], excludedNoSales: [], excludedByRule: [], noPrice: [],
        allocation: "purchase-first",
        totalNeed: 0, totalCovered: 0, totalBuy: 0, totalOrder: 0,
        costExact: 0, costRounded: 0, overpay: 0, shortfallCost: 0, costByPriceFull: 0,
        totalFromPurchase: 0, totalFromStock: 0, totalUnfilled: 0, totalToStock: 0,
      },
      machines: [],
      routeConfigured: true,
      warnings: [{ code: "sales_partial", message: "автомата нет в свежем батче продаж" }],
    };
    const планБота: VendingPlan = планОбщий;
    const усушкаОбратно: SharedShrinkReport = усушкаБота;
    const планОбратно: SharedPurchasePlan = планБота;
    assert.equal(усушкаБота, усушкаОбщая);
    assert.equal(планБота, планОбщий);
    assert.equal(усушкаОбратно, усушкаОбщая);
    assert.equal(планОбратно, планОбщий);
  });

  it("сводный закуп — та же форма, что у ядра, и сторож двусторонний", () => {
    // `/vending/purchase` и `/vending/plan` отдают ОДИН объект
    // (`PurchaseContext.summary`), но `VendingPurchase` пережил переезд
    // рукописным и уже недоописывал семь полей. Присваивание в ОБЕ стороны —
    // проверка тождества форм: одностороннее пропустило бы копию, у которой
    // поля НЕ ХВАТАЕТ (обычная структурная совместимость), а это и есть тот
    // самый способ разъехаться.
    const общая: SharedPurchaseSummary = {
      items: [], excludedNoSales: [], excludedByRule: [], noPrice: [],
      allocation: "purchase-first",
      totalNeed: 0, totalCovered: 0, totalBuy: 0, totalOrder: 0,
      costExact: 0, costRounded: 0, overpay: 0, shortfallCost: 0, costByPriceFull: 0,
      totalFromPurchase: 0, totalFromStock: 0, totalUnfilled: 0, totalToStock: 0,
    };
    const бота: VendingPurchase = общая;
    const обратно: SharedPurchaseSummary = бота;
    assert.equal(обратно, общая);
  });
});
