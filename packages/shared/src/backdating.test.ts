import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  backdateDays,
  backdateLabel,
  isBackdated,
  parseOccurred,
  tashkentLocalInput,
  truncateToMinute,
} from "./backdating";

/** Момент по ташкентским настенным часам — как его вводит человек. */
const t = (s: string) => new Date(`${s}+05:00`);

describe("два времени операции: разбор введённого (R-H-2…R-H-4)", () => {
  const now = t("2026-09-11T14:00");

  it("строка без зоны читается ташкентскими часами, а не часами процесса", () => {
    const r = parseOccurred("2026-09-11 09:40", now);
    assert.ok("at" in r);
    assert.equal(r.at.toISOString(), "2026-09-11T04:40:00.000Z");
  });

  it("секунды отбрасываются: точность до минуты", () => {
    const r = parseOccurred("2026-09-11T09:40:59", now);
    assert.ok("at" in r);
    assert.equal(r.at.toISOString(), "2026-09-11T04:40:00.000Z");
    assert.equal(truncateToMinute(t("2026-09-11T09:40")).getTime(), t("2026-09-11T09:40").getTime());
  });

  it("будущее отвергается словами (R-H-4), минутный запас на расхождение часов — нет", () => {
    const future = parseOccurred("2026-09-11 15:00", now);
    assert.ok("problem" in future);
    assert.match(future.problem, /будущем/);
    assert.ok("at" in parseOccurred("2026-09-11 14:00", now));
    assert.ok("at" in parseOccurred("2026-09-11T14:00:30", now));
  });

  it("мусор — отказ, а не «сейчас» молча", () => {
    const r = parseOccurred("вчера утром", now);
    assert.ok("problem" in r);
  });

  it("значение для поля формы — ташкентские часы (не UTC на пять часов назад)", () => {
    assert.equal(tashkentLocalInput(t("2026-09-11T09:40")), "2026-09-11T09:40");
    assert.equal(tashkentLocalInput(new Date("2026-09-11T19:05:00.000Z")), "2026-09-12T00:05");
  });
});

describe("граница «задним числом» — вчерашний день по Ташкенту (R-H-12)", () => {
  it("сегодняшнее событие, записанное позже в тот же день, — не задним числом", () => {
    assert.equal(isBackdated(t("2026-09-11T09:40"), t("2026-09-11T23:59")), false);
    assert.equal(backdateLabel(t("2026-09-11T09:40"), t("2026-09-11T14:00")), null);
  });

  it("вчерашнее — задним числом, и это названо словами", () => {
    assert.equal(isBackdated(t("2026-09-10T23:50"), t("2026-09-11T00:10")), true);
    assert.equal(backdateLabel(t("2026-09-10T23:50"), t("2026-09-11T00:10")), "задним числом: за вчера");
  });

  it("глубже — подпись называет дату события и разрыв в днях", () => {
    assert.equal(backdateDays(t("2026-08-19T10:00"), t("2026-09-11T10:00")), 23);
    assert.equal(backdateLabel(t("2026-08-19T10:00"), t("2026-09-11T10:00")), "задним числом: за 2026-08-19 (23 дн. назад)");
  });

  it("граница считается по ташкентским суткам: 23:30 по Ташкенту — ещё сегодня (в UTC это уже другой день)", () => {
    // 2026-09-11T18:30Z = 23:30 Ташкента того же дня; 2026-09-11T19:30Z = 00:30 следующего.
    assert.equal(isBackdated(new Date("2026-09-11T18:30:00Z"), new Date("2026-09-11T18:40:00Z")), false);
    assert.equal(isBackdated(new Date("2026-09-11T18:30:00Z"), new Date("2026-09-11T19:30:00Z")), true);
  });
});
