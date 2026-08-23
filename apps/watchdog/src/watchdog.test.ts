import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkOnce, WatchdogState } from "./watchdog";

describe("Состояние сторожа", () => {
  it("одиночный сбой не будит владельца", () => {
    const s = new WatchdogState(3);
    assert.equal(s.apply(false), "none");
    assert.equal(s.apply(true), "none", "восстановление без тревоги не сообщается");
  });

  it("тревога поднимается после N неудач подряд", () => {
    const s = new WatchdogState(3);
    assert.equal(s.apply(false), "none");
    assert.equal(s.apply(false), "none");
    assert.equal(s.apply(false), "alert_down");
  });

  it("о том же простое не сообщает повторно", () => {
    const s = new WatchdogState(2);
    s.apply(false);
    assert.equal(s.apply(false), "alert_down");
    assert.equal(s.apply(false), "none", "спам о том же простое недопустим");
    assert.equal(s.apply(false), "none");
  });

  it("сообщает о восстановлении ровно один раз", () => {
    const s = new WatchdogState(2);
    s.apply(false);
    s.apply(false);
    assert.equal(s.apply(true), "alert_recovered");
    assert.equal(s.apply(true), "none");
  });

  it("счётчик сбрасывается при успехе", () => {
    const s = new WatchdogState(3);
    s.apply(false);
    s.apply(false);
    s.apply(true);
    assert.equal(s.failures, 0);
    assert.equal(s.apply(false), "none", "после сброса нужно снова набрать неудачи");
  });
});

describe("Проверка доступности", () => {
  it("status=ok считается успехом", async (t) => {
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(JSON.stringify({ status: "ok", dbOk: true, tzOk: true }), { status: 200 }),
    );

    const res = await checkOnce("https://example.test/health");
    t.mock.restoreAll();
    assert.equal(res.ok, true);
  });

  it("HTTP 200 со status=degraded считается отказом", async (t) => {
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(JSON.stringify({ status: "degraded", dbOk: false }), { status: 200 }),
    );

    const res = await checkOnce("https://example.test/health");
    t.mock.restoreAll();
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /degraded/);
  });

  it("HTTP 200 с HTML вместо health JSON считается отказом", async (t) => {
    t.mock.method(
      globalThis,
      "fetch",
      async () => new Response("<html>proxy</html>", { status: 200 }),
    );

    const res = await checkOnce("https://example.test/health");
    t.mock.restoreAll();
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /не JSON/);
  });

  it("недостижимый адрес — это отказ, а не исключение", async () => {
    const res = await checkOnce("http://127.0.0.1:1/health", 2000);
    assert.equal(res.ok, false);
    assert.ok(res.reason);
  });

  it("таймаут считается отказом", async () => {
    // 203.0.113.0/24 — зарезервированный диапазон для примеров, ответа не будет
    const res = await checkOnce("http://203.0.113.1/health", 300);
    assert.equal(res.ok, false);
  });
});
