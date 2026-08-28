import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PUSH_HOURS, внутриРабочихЧасов } from "./push-hours";

describe("Тихие часы новых пушей (П7, R-P7-11)", () => {
  it("окно 7:00–22:00 по Ташкенту, границы включительно снизу и исключительно сверху", () => {
    assert.deepEqual({ ...PUSH_HOURS }, { from: 7, to: 22 });
    assert.equal(внутриРабочихЧасов(new Date("2026-08-26T06:59:00+05:00")), false);
    assert.equal(внутриРабочихЧасов(new Date("2026-08-26T07:00:00+05:00")), true);
    assert.equal(внутриРабочихЧасов(new Date("2026-08-26T21:59:00+05:00")), true);
    assert.equal(внутриРабочихЧасов(new Date("2026-08-26T22:00:00+05:00")), false);
    assert.equal(внутриРабочихЧасов(new Date("2026-08-26T23:40:00+05:00")), false);
  });

  it("решение принимается по Ташкенту, а не по часам процесса", () => {
    assert.equal(внутриРабочихЧасов(new Date("2026-08-26T03:00:00.000Z")), true);
    assert.equal(внутриРабочихЧасов(new Date("2026-08-26T18:00:00.000Z")), false);
  });
});
