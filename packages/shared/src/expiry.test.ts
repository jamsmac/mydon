import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { effectiveExpiry, expiryFlag, FLAG_ORDER, DAY } from "./expiry";

const d = (s: string): Date => new Date(s + "T00:00:00Z");

// Перенесено ДОСЛОВНО (по содержанию) из mydon_1
// (~/Developer/mydon_1/src/lib/vendhub/product-stock/expiry.test.ts) — типов с
// id здесь нет (BatchDates не содержит batchId), адаптировать нечего. Синтаксис
// проверок переведён с jest (`expect`) на наш рантайм тестов пакета — node:test
// + node:assert/strict, как и в остальных файлах packages/shared.
describe("effectiveExpiry", () => {
  it("явный expiryAt имеет приоритет", () => {
    assert.deepEqual(
      effectiveExpiry({ expiryAt: d("2026-05-01"), manufactureAt: null, receivedAt: d("2026-01-01") }, 30),
      d("2026-05-01"),
    );
  });
  it("из manufactureAt + shelfLifeDays", () => {
    assert.deepEqual(
      effectiveExpiry({ expiryAt: null, manufactureAt: d("2026-01-01"), receivedAt: d("2026-02-01") }, 90),
      new Date(d("2026-01-01").getTime() + 90 * DAY),
    );
  });
  it("фолбэк на receivedAt когда нет manufacture", () => {
    assert.deepEqual(
      effectiveExpiry({ expiryAt: null, manufactureAt: null, receivedAt: d("2026-01-01") }, 10),
      new Date(d("2026-01-01").getTime() + 10 * DAY),
    );
  });
  it("нет expiryAt и нет валидного shelfLifeDays → null", () => {
    assert.equal(
      effectiveExpiry({ expiryAt: null, manufactureAt: null, receivedAt: d("2026-01-01") }, null),
      null,
    );
    assert.equal(effectiveExpiry({ expiryAt: null, manufactureAt: null, receivedAt: d("2026-01-01") }, 0), null);
  });
});

describe("expiryFlag", () => {
  const now = d("2026-06-01");
  it("нет срока → none", () => assert.equal(expiryFlag(null, now), "none"));
  it("прошёл → expired", () => assert.equal(expiryFlag(d("2026-05-31"), now), "expired"));
  it("в пределах порога → expiring", () => {
    assert.equal(expiryFlag(d("2026-06-10"), now, 14), "expiring"); // через 9 дней
    assert.equal(expiryFlag(d("2026-06-15"), now, 14), "expiring"); // ровно 14
  });
  it("далеко → ok", () => assert.equal(expiryFlag(d("2026-07-01"), now, 14), "ok"));
  it("порядок флагов", () => {
    assert.ok(FLAG_ORDER.expired < FLAG_ORDER.expiring);
    assert.ok(FLAG_ORDER.expiring < FLAG_ORDER.ok);
    assert.ok(FLAG_ORDER.ok < FLAG_ORDER.none);
  });
});
