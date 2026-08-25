import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
// Константа не входит в публичный экспорт пакета (`dist/index.js` её не
// реэкспортирует) — читаем напрямую из установленной версии, как для этого
// требует N1: сверено с `node_modules/@nestjs/throttler` (throttler@6.5.0).
import { THROTTLER_LIMIT } from "@nestjs/throttler/dist/throttler.constants";
import { VendingController } from "./vending.controller";

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
