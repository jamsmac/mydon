import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
// Константа не входит в публичный экспорт пакета (`dist/index.js` её не
// реэкспортирует) — читаем напрямую из установленной версии, как для этого
// требует N1: сверено с `node_modules/@nestjs/throttler` (throttler@6.5.0).
import { THROTTLER_LIMIT } from "@nestjs/throttler/dist/throttler.constants";
import type { AnalyticsService } from "./analytics.service";
import { LIST_DAYS_MAX } from "./refill-events.service";
import { RefillEventsListDto, StockCountsDto, VendingController } from "./vending.controller";
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
 * Потолок `?days=` для истории склада (R-FW-P3, П8a fix wave; адверсариал
 * прод-данные №3): старая граница 365 никогда не пускала бы к 26 самым
 * старым строкам истории (донор начинается 2025-08-17) — она подвинута до
 * 730. `plainToInstance` со строками, как реально приходят из query: без
 * `@Transform` DTO `IsInt()` отбивал бы даже валидное значение.
 */
describe("StockCountsDto: потолок окна — 730 суток, не 365 (R-FW-P3)", () => {
  it("730 — новая верхняя граница, законна", async () => {
    const dto = plainToInstance(StockCountsDto, { days: "730" });
    assert.deepEqual(await validate(dto), []);
  });

  it("731 — уже за границей, отказ", async () => {
    const dto = plainToInstance(StockCountsDto, { days: "731" });
    assert.ok((await validate(dto)).length > 0, "731 суток не должно проходить валидацию");
  });

  it("365 — старый потолок больше не особая граница, проходит как любое другое значение внутри окна", async () => {
    const dto = plainToInstance(StockCountsDto, { days: "365" });
    assert.deepEqual(await validate(dto), []);
  });

  it("пустая строка по-прежнему гасится в «не задано», а не в 0/NaN", async () => {
    const dto = plainToInstance(StockCountsDto, { days: "" });
    assert.deepEqual(await validate(dto), []);
    assert.equal(dto.days, undefined);
  });
});

describe("Вендинг Core: троттлинг GET /vending/refill-events (R-FW-S6)", () => {
  it("свой лимит 12/мин, как у соседних отчётных чтений, а не общий потолок", () => {
    // Окно этого чтения срез поднял с 30 до 90 суток — цена запроса выросла,
    // а защита оставалась общей (60 запросов / 10 с), которой хватало, чтобы
    // уложить Core одним циклом `curl` из докер-сети.
    const handler = VendingController.prototype.refillEventsList;
    assert.equal(Reflect.getMetadata(THROTTLER_LIMIT + "burst", handler), 12);
    assert.equal(Reflect.getMetadata(THROTTLER_LIMIT + "sustained", handler), 12);
    const keys = Reflect.getMetadataKeys(handler).filter((k): k is string => typeof k === "string");
    assert.ok(!keys.some((k) => k.endsWith("default")), "под именем default ThrottlerGuard ничего не читает");
  });
});

describe("RefillEventsListDto: потолок ЧТЕНИЯ журнала — 90 суток, не 30 (R-H-5)", () => {
  it("90 — законная верхняя граница", async () => {
    assert.deepEqual(await validate(plainToInstance(RefillEventsListDto, { days: "90" })), []);
  });

  it("91 — уже за границей, отказ", async () => {
    assert.ok((await validate(plainToInstance(RefillEventsListDto, { days: "91" }))).length > 0);
  });

  it("30 — больше не особая граница: потолок скана снимков не потолок чтения", async () => {
    assert.deepEqual(await validate(plainToInstance(RefillEventsListDto, { days: "30" })), []);
  });

  it("потолок DTO пришпилен к `LIST_DAYS_MAX` сервиса, а не к литералу рядом (ревью m6)", () => {
    // Оба числа стояли на «90» независимо: подъём потолка в сервисе оставил
    // бы страховку HTTP-входа на 90 молча, и роут отдавал бы не то окно,
    // которое просили.
    assert.equal(LIST_DAYS_MAX, 90);
  });

  it("пустая строка гасится в «не задано», как у StockCountsDto (R-FW-S8)", async () => {
    // `?days=` — незаполненное поле фильтра. `@Type(() => Number)` превращал
    // пустую строку в 0, `@Min(1)` его отбивал, и панель получала 400 вместо
    // окна по умолчанию. Докблок DTO ссылался на `StockCountsDto` как на
    // образец, но переносил из него только `@Max`.
    const dto = plainToInstance(RefillEventsListDto, { days: "" });
    assert.deepEqual(await validate(dto), []);
    assert.equal(dto.days, undefined);
  });
});

describe("StockCountsDto: длина `product` совпадает с тем, что режет панель (R-FW-S10)", () => {
  it("512 символов — законны, 513 — отказ", async () => {
    // Лист «История склада» шлёт сюда `?q=`, и запрос длиннее границы давал
    // 400, который панель показывала экраном «ядро недоступно». Граница у
    // обеих сторон обязана быть одним числом — 512.
    assert.deepEqual(await validate(plainToInstance(StockCountsDto, { product: "я".repeat(512) })), []);
    assert.ok((await validate(plainToInstance(StockCountsDto, { product: "я".repeat(513) }))).length > 0);
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
