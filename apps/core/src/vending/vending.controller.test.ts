import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
// Константа не входит в публичный экспорт пакета (`dist/index.js` её не
// реэкспортирует) — читаем напрямую из установленной версии, как для этого
// требует N1: сверено с `node_modules/@nestjs/throttler` (throttler@6.5.0).
import { THROTTLER_LIMIT } from "@nestjs/throttler/dist/throttler.constants";
import type { AnalyticsService } from "./analytics.service";
import type { CancelResult, RecordCancelService } from "./record-cancel.service";
import { LIST_DAYS_MAX } from "./refill-events.service";
import {
  CancelRecordDto,
  MyRecordsDto,
  RefillEventsListDto,
  SetProductFiscalDto,
  STOCK_COUNTS_PRODUCT_MAX,
  StockCountsDto,
  VendingController,
} from "./vending.controller";
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

describe("SetProductFiscalDto: вход держит форму, а не только сервис (П6)", () => {
  const productId = "0f8e1a4c-1111-4222-8333-444455556666";

  it("16 цифр отвергнуты сообщением донора", async () => {
    const dto = plainToInstance(SetProductFiscalDto, { productId, ikpu: "2202002001010032" });
    const ошибки = await validate(dto);
    assert.equal(ошибки.length, 1);
    assert.deepEqual(Object.values(ошибки[0].constraints ?? {}), ["ИКПУ должен быть 17 цифр или пусто"]);
  });

  it("пустая строка гасится в null до сервиса", async () => {
    const dto = plainToInstance(SetProductFiscalDto, { productId, ikpu: "  " });
    assert.deepEqual(await validate(dto), []);
    assert.equal(dto.ikpu, null);
  });

  it("разделители копирования вырезаются до проверки длины", async () => {
    const dto = plainToInstance(SetProductFiscalDto, { productId, ikpu: "022 0200-3001 086 002" });
    assert.deepEqual(await validate(dto), []);
    assert.equal(dto.ikpu, "02202003001086002");
  });

  it("vatPct вне набора 12/0/15 отвергнут, а 0 принят", async () => {
    assert.deepEqual(await validate(plainToInstance(SetProductFiscalDto, { productId, vatPct: 0 })), []);
    assert.equal((await validate(plainToInstance(SetProductFiscalDto, { productId, vatPct: 7 }))).length, 1);
  });

  it("packageCode вне словаря ОКЕИ отвергнут", async () => {
    const dto = plainToInstance(SetProductFiscalDto, { productId, packageCode: "1218841" });
    assert.equal((await validate(dto)).length, 1);
  });

  it("productId — uuid: адресуемся по карточке, а не по спорному имени", async () => {
    const dto = plainToInstance(SetProductFiscalDto, { productId: "Snickers 50gr", marked: true });
    assert.equal((await validate(dto)).length, 1);
  });
});

describe("DTO сторно и «Моих записей» (П6)", () => {
  const personId = "0f8e1a4c-1111-4222-8333-444455556666";

  it("personId обязателен и должен быть UUID", async () => {
    assert.ok((await validate(plainToInstance(CancelRecordDto, {}))).length > 0);
    assert.ok((await validate(plainToInstance(CancelRecordDto, { personId: "owner" }))).length > 0);
    assert.deepEqual(await validate(plainToInstance(CancelRecordDto, { personId })), []);
  });

  it("limit принимает 1..15 и отвергает выход за границы", async () => {
    assert.deepEqual(await validate(plainToInstance(MyRecordsDto, { person: personId, limit: "1" })), []);
    assert.deepEqual(await validate(plainToInstance(MyRecordsDto, { person: personId, limit: "15" })), []);
    assert.ok((await validate(plainToInstance(MyRecordsDto, { person: personId, limit: "0" }))).length > 0);
    assert.ok((await validate(plainToInstance(MyRecordsDto, { person: personId, limit: "16" }))).length > 0);
  });
});

/**
 * Проводка ответа `RecordCancelService` в HTTP-статусы (R-P6-12): запрос
 * корректен (`personId` — валидный UUID), отказ — по правам, а не по форме
 * входа, поэтому `not_yours`/`too_old` — 403, а не 400.
 */
describe("Вендинг Core: сторно — статусы отказа (П6)", () => {
  const контроллер = (cancel: CancelResult) => {
    const recordCancel = { cancel: async () => cancel } as unknown as RecordCancelService;
    const c = new VendingController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      recordCancel,
      {} as never,
      {} as never,
      {} as never,
    );
    return c;
  };

  it("отмена без прав автора — 403 not_yours, а не 400", async () => {
    const c = контроллер({ ok: false, reason: "not_yours" });
    await assert.rejects(
      () => c.cancelRefill("r1", { personId: "0f8e1a4c-1111-4222-8333-444455556666" }),
      (e: unknown) => e instanceof ForbiddenException && (e.getResponse() as { reason: string }).reason === "not_yours",
    );
  });

  it("окно истекло — 403 too_old с числом часов в сообщении", async () => {
    const c = контроллер({ ok: false, reason: "too_old", hours: 24 });
    await assert.rejects(
      () => c.cancelStockCount("c1", { personId: "0f8e1a4c-1111-4222-8333-444455556666" }),
      (e: unknown) => e instanceof ForbiddenException && /24 часов/.test((e.getResponse() as { message: string }).message),
    );
  });

  it("запись не найдена — 404, а не 403", async () => {
    const c = контроллер({ ok: false, reason: "not_found" });
    await assert.rejects(
      () => c.cancelCash("cash1", { personId: "0f8e1a4c-1111-4222-8333-444455556666" }),
      (e: unknown) => e instanceof NotFoundException,
    );
  });

  it("успех уходит как есть — не оборачивается в исключение", async () => {
    const c = контроллер({ ok: true, kind: "refill", stornoId: "s1", label: "…", alreadyCancelled: false });
    const res = await c.cancelRefill("r1", { personId: "0f8e1a4c-1111-4222-8333-444455556666" });
    assert.equal(res.ok, true);
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

describe("StockCountsDto: длинный запрос ЗАЖИМАЕТСЯ, а не отбивается (R-FW-S10)", () => {
  it("512 символов проходят как есть", async () => {
    const dto = plainToInstance(StockCountsDto, { product: "я".repeat(STOCK_COUNTS_PRODUCT_MAX) });
    assert.deepEqual(await validate(dto), []);
    assert.equal(dto.product?.length, STOCK_COUNTS_PRODUCT_MAX);
  });

  it("вставленный абзац НЕ даёт 400 — он режется по той же границе", async () => {
    // Лист «История склада» шлёт сюда содержимое поля поиска. Пока длина
    // отбивалась, вставленный из буфера абзац давал 400, а панель подменяла
    // весь лист экраном «Core недоступен» — живое ядро выглядело упавшим.
    const dto = plainToInstance(StockCountsDto, { product: `  ${"я".repeat(5000)}  ` });
    assert.deepEqual(await validate(dto), [], "длина запроса больше не повод отказывать");
    assert.equal(dto.product?.length, STOCK_COUNTS_PRODUCT_MAX);
  });

  it("короткий запрос не портится: только `trim`, без обрезки", async () => {
    const dto = plainToInstance(StockCountsDto, { product: "  Montella pet 0.33 " });
    assert.deepEqual(await validate(dto), []);
    assert.equal(dto.product, "Montella pet 0.33");
  });

  it("`@MaxLength` держит ту же константу, что и зажим — договор и зажим не расходятся", async () => {
    assert.equal(STOCK_COUNTS_PRODUCT_MAX, 512);
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
