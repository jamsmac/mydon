import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OutRate, type Clock } from "./out-rate";

/** Часы под управлением теста: sleep не ждёт, а двигает время. */
function fakeClock(): Clock & { t: number; slept: number[] } {
  const c = {
    t: 1_000_000,
    slept: [] as number[],
    now: () => c.t,
    sleep: async (ms: number) => {
      c.slept.push(ms);
      c.t += ms;
    },
  };
  return c;
}

describe("Ограничитель исходящих", () => {
  it("держит зазор между сообщениями в один чат", () => {
    // Персональный лимит Telegram ~1 сообщение в секунду. Десять карточек
    // подряд одному человеку без зазора уходят в 429 вместе со всей очередью.
    const clock = fakeClock();
    const rate = new OutRate(clock);
    return (async () => {
      await rate.take(1);
      const before = clock.t;
      await rate.take(1);
      assert.ok(clock.t - before >= 1_000, `подождали всего ${clock.t - before} мс`);
    })();
  });

  it("разные чаты не ждут друг друга по секунде", async () => {
    const clock = fakeClock();
    const rate = new OutRate(clock);
    await rate.take(1);
    const before = clock.t;
    await rate.take(2);
    assert.ok(clock.t - before < 1_000, "второй чат не должен ждать персональный зазор первого");
  });

  it("общий поток тоже ограничен — 30/сек с запасом", async () => {
    const clock = fakeClock();
    const rate = new OutRate(clock);
    const start = clock.t;
    for (let i = 0; i < 10; i += 1) await rate.take(1000 + i);
    assert.ok(clock.t - start >= 9 * 40, "десять разных чатов подряд должны занять хотя бы 360 мс");
  });

  it("429 тормозит ВСЮ отправку, а не одно сообщение", async () => {
    // Лимит общий: попытка отправить следующее сразу же получит тот же отказ
    // и только продлит наказание.
    const clock = fakeClock();
    const rate = new OutRate(clock);
    rate.pause(5);
    const before = clock.t;
    await rate.take(42);
    assert.ok(clock.t - before >= 5_000, `пауза не сработала: ${clock.t - before} мс`);
  });

  it("более длинная пауза не укорачивается более короткой", async () => {
    const clock = fakeClock();
    const rate = new OutRate(clock);
    rate.pause(10);
    rate.pause(2);
    const before = clock.t;
    await rate.take(1);
    assert.ok(clock.t - before >= 10_000);
  });

  it("нулевой retry_after всё равно даёт паузу", async () => {
    // Telegram иногда присылает retry_after: 0. Ноль паузы означал бы
    // мгновенный повтор и ещё один 429.
    const clock = fakeClock();
    const rate = new OutRate(clock);
    rate.pause(0);
    const before = clock.t;
    await rate.take(1);
    assert.ok(clock.t - before >= 1_000);
  });

  it("уборка забывает старые чаты", async () => {
    const clock = fakeClock();
    const rate = new OutRate(clock);
    await rate.take(1);
    await rate.take(2);
    assert.equal(rate.size, 2);
    clock.t += 11 * 60_000;
    rate.sweep();
    assert.equal(rate.size, 0, "иначе карта растёт вместе с историей переписки");
  });

  it("свежие чаты уборка не трогает", async () => {
    const clock = fakeClock();
    const rate = new OutRate(clock);
    await rate.take(1);
    clock.t += 60_000;
    rate.sweep();
    assert.equal(rate.size, 1);
  });
});
