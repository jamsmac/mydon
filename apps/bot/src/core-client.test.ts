import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type {
  AnalyticsWarning as SharedAnalyticsWarning,
  BootstrapSalePriceResult as SharedBootstrapSalePriceResult,
  MonthlyPrice as SharedMonthlyPrice,
  OurvendHealth as SharedOurvendHealth,
  OurvendSyncRun as SharedOurvendSyncRun,
  SetSalePriceResult as SharedSetSalePriceResult,
} from "@mydon/shared";
import {
  CoreClient,
  NotAMachineError,
  type AnalyticsWarning,
  type BootstrapSalePriceResult,
  type EntityRow,
  type MonthlyPrice,
  type OurvendHealth,
  type OurvendSyncRun,
  type SetSalePriceResult,
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

afterEach(() => {
  globalThis.fetch = настоящийFetch;
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
      productSaleLagH: 0.2,
      parity: { days: 7, ok: false, mismatches: 0, stockOk: false, checked: 0, stockChecked: 0, note: null },
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
});
