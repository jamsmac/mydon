import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AUTONOMY_TIERS, DOMAINS, DOMAIN_LABELS, TZ, formatTashkent } from "./index";

describe("@mydon/shared", () => {
  it("часовой пояс проекта — Asia/Tashkent (правило ТЗ, включая cron)", () => {
    assert.equal(TZ, "Asia/Tashkent");
  });

  it("у каждого направления есть читаемое название для UI", () => {
    for (const d of DOMAINS) {
      assert.ok(DOMAIN_LABELS[d], `нет названия для домена ${d}`);
    }
    assert.equal(DOMAINS.length, 5);
  });

  it("уровни автономии агентов — от T0 до T4", () => {
    assert.deepEqual([...AUTONOMY_TIERS], ["T0", "T1", "T2", "T3", "T4"]);
  });

  it("форматирует время в ташкентском поясе независимо от системного", () => {
    // 2026-01-01T00:00:00Z в Ташкенте (UTC+5) — это 05:00 того же дня
    const out = formatTashkent(new Date("2026-01-01T00:00:00Z"));
    assert.match(out, /01\.01\.2026/);
    assert.match(out, /05:00/);
  });
});
