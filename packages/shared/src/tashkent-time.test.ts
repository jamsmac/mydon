import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TASHKENT_OFFSET_MS,
  tashkentDay,
  tashkentDayEnd,
  tashkentDayStart,
  tashkentDayStartOf,
  tashkentHour,
  tashkentInstant,
  tashkentMinute,
} from "./tashkent-time";

describe("Время источника: разбор явный, не по TZ процесса (R-K8)", () => {
  it("строка без зоны — ташкентские часы, а не часы процесса", () => {
    // 14:30 в Ташкенте — это 09:30 UTC, независимо от TZ процесса.
    assert.equal(tashkentInstant("2026-06-08 14:30:00")?.toISOString(), "2026-06-08T09:30:00.000Z");
    assert.equal(tashkentInstant("2026-06-08T14:30:00")?.toISOString(), "2026-06-08T09:30:00.000Z");
  });

  it("строка с зоной не трогается", () => {
    assert.equal(tashkentInstant("2026-06-08T09:30:00Z")?.toISOString(), "2026-06-08T09:30:00.000Z");
    assert.equal(tashkentInstant("2026-06-08T14:30:00+05:00")?.toISOString(), "2026-06-08T09:30:00.000Z");
  });

  it("голая дата — границы ташкентских суток", () => {
    assert.equal(tashkentDayStart("2026-06-08")?.toISOString(), "2026-06-07T19:00:00.000Z");
    assert.equal(tashkentDayEnd("2026-06-08")?.toISOString(), "2026-06-08T18:59:59.999Z");
  });

  it("мусор — null, а не Invalid Date", () => {
    assert.equal(tashkentInstant("не дата"), null);
  });

  it("момент → ташкентские сутки YYYY-MM-DD (граница полуночи)", () => {
    // 18:59:59.999Z — ещё 08.06 по Ташкенту, 19:00:00Z — уже 09.06.
    assert.equal(tashkentDay(new Date("2026-06-08T18:59:59.999Z")), "2026-06-08");
    assert.equal(tashkentDay(new Date("2026-06-08T19:00:00.000Z")), "2026-06-09");
  });

  it("момент → начало его ташкентских суток", () => {
    assert.equal(tashkentDayStartOf(new Date("2026-06-08T18:59:59.999Z")).toISOString(), "2026-06-07T19:00:00.000Z");
    assert.equal(tashkentDayStartOf(new Date("2026-06-08T19:00:00.000Z")).toISOString(), "2026-06-08T19:00:00.000Z");
  });
});

describe("Час ташкентских суток", () => {
  it("полночь UTC — это пять утра в Ташкенте", () => {
    assert.equal(tashkentHour(new Date("2026-08-26T00:00:00.000Z")), 5);
  });

  it("границы суток не съезжают", () => {
    assert.equal(tashkentHour(new Date("2026-08-26T00:00:00+05:00")), 0);
    assert.equal(tashkentHour(new Date("2026-08-26T23:59:59+05:00")), 23);
    assert.equal(tashkentHour(new Date("2026-08-25T19:00:00.000Z")), 0);
  });
});

describe("Ташкентская минута и смещение (срез «правда о пробеле»)", () => {
  it("минута режется по Ташкенту, а не по часам процесса", () => {
    assert.equal(tashkentMinute(new Date("2026-01-30T06:40:42.626Z")), "2026-01-30T11:40");
    assert.equal(tashkentMinute(new Date("2026-01-30T18:59:59.999Z")), "2026-01-30T23:59");
    assert.equal(tashkentMinute(new Date("2026-01-30T19:00:00.000Z")), "2026-01-31T00:00");
  });

  it("секунды в минуту не входят — повтор нажатия внутри минуты даёт ТУ ЖЕ строку", () => {
    const a = tashkentMinute(new Date("2026-01-30T06:40:00.000Z"));
    const b = tashkentMinute(new Date("2026-01-30T06:40:59.999Z"));
    assert.equal(a, b);
  });

  it("смещение экспортировано и равно ровно пяти часам — второй копии в репозитории быть не должно", () => {
    assert.equal(TASHKENT_OFFSET_MS, 5 * 3_600_000);
    // Тот же сдвиг, что применяет `tashkentDay`: если однажды разойдутся,
    // разовая правка времени уедет не туда, а тест это скажет.
    const at = new Date("2026-06-08T20:30:00.000Z");
    assert.equal(new Date(at.getTime() + TASHKENT_OFFSET_MS).toISOString().slice(0, 10), tashkentDay(at));
  });
});
