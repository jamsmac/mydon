import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
// Константа не входит в публичный экспорт пакета (`dist/index.js` её не
// реэкспортирует) — читаем напрямую из установленной версии, как для этого
// требует N1: сверено с `node_modules/@nestjs/throttler` (throttler@6.5.0).
import { THROTTLER_LIMIT } from "@nestjs/throttler/dist/throttler.constants";
import type { AnalyticsService } from "./analytics.service";
import { VendingController } from "./vending.controller";
import type { VendingService } from "./vending.service";

describe("Вендинг Core: троттлинг GET /vending/shrinkage (N1)", () => {
  it("`@Throttle` заведён на именованные лимитеры burst/sustained — те же имена, что регистрирует ThrottlerModule.forRoot (app.module.ts), а не «default»", () => {
    const handler = VendingController.prototype.shrinkage;

    const burstLimit = Reflect.getMetadata(THROTTLER_LIMIT + "burst", handler);
    const sustainedLimit = Reflect.getMetadata(THROTTLER_LIMIT + "sustained", handler);
    assert.equal(burstLimit, 6, "лимитер burst должен быть явно сужен до 6/мин");
    assert.equal(sustainedLimit, 6, "лимитер sustained должен быть явно сужен до 6/мин");

    // Страховка на случай, если внутренний путь к константе когда-нибудь
    // перестанет резолвиться: метаданные декоратора обязаны заканчиваться
    // именно на «burst»/«sustained» и НЕ содержать «default» — под этим
    // именем ThrottlerGuard.canActivate (throttler@6.5.0) ничего не читает,
    // и роут остаётся под общим лимитом 60/10с (N1).
    const keys = Reflect.getMetadataKeys(handler).filter((k): k is string => typeof k === "string");
    assert.ok(keys.some((k) => k.endsWith("burst")), "должны быть метаданные для лимитера burst");
    assert.ok(keys.some((k) => k.endsWith("sustained")), "должны быть метаданные для лимитера sustained");
    assert.ok(!keys.some((k) => k.endsWith("default")), "метаданных под именем default быть не должно");
  });
});

describe("Вендинг Core: троттлинг GET /vending/stock-counts (П8a)", () => {
  it("свой лимит 12/мин на именованных лимитерах, а не общий потолок", () => {
    // Выборка идёт по окну и достаёт до двух тысяч строк: под общим потолком
    // (60 запросов / 10 с) один цикл `curl` из докер-сети укладывал Core.
    const handler = VendingController.prototype.stockCounts;
    assert.equal(Reflect.getMetadata(THROTTLER_LIMIT + "burst", handler), 12);
    assert.equal(Reflect.getMetadata(THROTTLER_LIMIT + "sustained", handler), 12);
    const keys = Reflect.getMetadataKeys(handler).filter((k): k is string => typeof k === "string");
    assert.ok(!keys.some((k) => k.endsWith("default")), "под именем default ThrottlerGuard ничего не читает");
  });
});

/**
 * Инвалидация кеша аналитики на записях, которые меняют ВТОРОЙ ОПЕРАНД
 * отчётов.
 *
 * Отчёты живут в пятиминутном кеше, и без сброса владелец, поправивший цену
 * или принявший накладную, пять минут читал бы маржу по старым числам —
 * причём молча: отчёт выглядит свежим, у него та же дата окна. Проверяется
 * ПРОВОДКА (кто кого зовёт), а не расчёт: расчёт покрыт в analytics.service.
 */
describe("Вендинг Core: сброс кеша аналитики на правках цен и приёмке (П5b)", () => {
  const контроллер = (vending: Partial<VendingService>) => {
    const сбросов = { count: 0 };
    const analytics = { invalidateReports: () => (сбросов.count += 1) } as unknown as AnalyticsService;
    const c = new VendingController(
      vending as VendingService,
      {} as never,
      {} as never,
      {} as never,
      analytics,
      {} as never,
    );
    return { c, сбросов };
  };

  it("эталон витрины: удачная правка сбрасывает кеш, отказ гейта — нет", async () => {
    const удача = контроллер({ setSalePrice: async () => ({ ok: true, product: "Fanta", oldPrice: null, newPrice: 15_000, factPrice: null }) });
    await удача.c.setSalePrice({ product: "Fanta", price: 15_000 });
    assert.equal(удача.сбросов.count, 1);

    const отказ = контроллер({ setSalePrice: async () => ({ ok: false, reason: "spike" as const, product: "Fanta" }) });
    await отказ.c.setSalePrice({ product: "Fanta", price: 30_000 });
    assert.equal(отказ.сбросов.count, 0, "гейт отбил правку — данные не менялись, сбрасывать нечего");
  });

  it("закупочная цена: удачная правка сбрасывает кеш (она же — себестоимость маржи)", async () => {
    const удача = контроллер({ setProductPrice: async () => ({ ok: true, product: "Fanta", oldPrice: 5859, newPrice: 6500 }) });
    await удача.c.setProductPrice({ product: "Fanta", price: 6500 });
    assert.equal(удача.сбросов.count, 1);

    const отказ = контроллер({ setProductPrice: async () => ({ ok: false, reason: "not_found" as const }) });
    await отказ.c.setProductPrice({ product: "Нет такого", price: 6500 });
    assert.equal(отказ.сбросов.count, 0);
  });

  it("бутстрап витрины: сброс только когда что-то РЕАЛЬНО проставлено", async () => {
    const записал = контроллер({ bootstrapSalePrice: async () => ({ days: 14, set: [{ product: "Fanta", price: 12_000, qty: 4 }], skipped: [] }) });
    await записал.c.bootstrapSalePrice({});
    assert.equal(записал.сбросов.count, 1);

    const пусто = контроллер({ bootstrapSalePrice: async () => ({ days: 14, set: [], skipped: [{ product: "Fanta", reason: "no_sales" as const }] }) });
    await пусто.c.bootstrapSalePrice({});
    assert.equal(пусто.сбросов.count, 0);
  });

  it("приёмка накладной сбрасывает кеш ВСЕГДА: она двигает и склад, и себестоимость", async () => {
    const принята = контроллер({
      receiveOrder: async () => ({ received: true, replenished: 1, units: 12, distributedUnits: 0, unmatchedDistribution: [] }),
    });
    await принята.c.receiveOrder({ orderId: "o-1" });
    assert.equal(принята.сбросов.count, 1);

    // Даже отказ приёмки сбрасывает: путей отказа несколько, и решать по флагу
    // «а точно ли ничего не записалось» здесь дороже, чем один лишний пересчёт.
    const отказ = контроллер({
      receiveOrder: async () => ({ received: false, replenished: 0, units: 0, distributedUnits: 0, unmatchedDistribution: [], reason: "Эта накладная уже принята." }),
    });
    await отказ.c.receiveOrder({ orderId: "o-1" });
    assert.equal(отказ.сбросов.count, 1);
  });
});
