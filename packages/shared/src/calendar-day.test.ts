import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dayNumber, isoOfDay } from "./calendar-day";

describe("Календарные сутки: YYYY-MM-DD ↔ номер суток", () => {
  it("эпоха — нулевые сутки, и обратно", () => {
    assert.equal(dayNumber("1970-01-01"), 0);
    assert.equal(isoOfDay(0), "1970-01-01");
  });

  it("соседние сутки отличаются ровно на единицу через границу месяца и года", () => {
    assert.equal(dayNumber("2026-09-01") - dayNumber("2026-08-31"), 1);
    assert.equal(dayNumber("2027-01-01") - dayNumber("2026-12-31"), 1);
    assert.equal(isoOfDay(dayNumber("2026-12-31") + 1), "2027-01-01");
  });

  it("високосный февраль считается сутками, а не «+31»", () => {
    assert.equal(dayNumber("2028-03-01") - dayNumber("2028-02-01"), 29);
    assert.equal(dayNumber("2026-03-01") - dayNumber("2026-02-01"), 28);
  });

  it("обход туда-обратно не теряет дня ни на одной дате года", () => {
    for (let n = dayNumber("2026-01-01"); n <= dayNumber("2026-12-31"); n += 1) {
      assert.equal(dayNumber(isoOfDay(n)), n);
    }
  });
});
