import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkLimit, dailyCap, startOfTashkentDay } from "./limits";

describe("Лимиты действий агентов", () => {
  it("без настройки лимита действия не ограничены", () => {
    assert.equal(dailyCap(undefined), 0);
    assert.equal(checkLimit(9999, 0).allowed, true);
  });

  it("мусор в настройке не превращается в случайный потолок", () => {
    assert.equal(dailyCap("много"), 0);
    assert.equal(dailyCap("-5"), 0);
    assert.equal(dailyCap("12.7"), 12);
  });

  it("пропускает, пока потолок не достигнут", () => {
    const d = checkLimit(4, 5);
    assert.equal(d.allowed, true);
    assert.equal(d.used, 4);
  });

  it("останавливает ровно на потолке, а не после него", () => {
    const d = checkLimit(5, 5);
    assert.equal(d.allowed, false, "пятое действие при потолке 5 уже исчерпало лимит");
    assert.match(d.reason ?? "", /потолок действий исчерпан/);
  });

  it("день считается по Ташкенту, а не по UTC", () => {
    // 22:00 UTC 26 июля = 03:00 27 июля в Ташкенте: сутки уже НОВЫЕ
    const start = startOfTashkentDay(new Date("2026-07-26T22:00:00Z"));
    const inTashkent = new Date(start.toLocaleString("en-US", { timeZone: "Asia/Tashkent" }));
    assert.equal(inTashkent.getHours(), 0, "начало суток должно приходиться на полночь Ташкента");
    assert.equal(inTashkent.getDate(), 27, "в 22:00 UTC в Ташкенте уже 27-е");
  });
});
