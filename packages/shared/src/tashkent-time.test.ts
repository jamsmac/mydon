import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tashkentDay, tashkentDayEnd, tashkentDayStart, tashkentDayStartOf, tashkentInstant } from "./tashkent-time";

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
