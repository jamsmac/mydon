import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveAll, resolveEffective, specFor, validateConfig } from "./config-spec";

describe("config-spec: белый список тумблеров", () => {
  it("ключ вне списка отклоняется (нельзя протащить секрет/произвольный env)", () => {
    assert.match(validateConfig("LLM_API_KEY", "sk-123") ?? "", /неизвестный ключ/);
    assert.match(validateConfig("SERVICE_TOKEN", "x") ?? "", /неизвестный ключ/);
    assert.equal(specFor("LLM_API_KEY"), undefined);
  });

  it("пустое значение = сброс, всегда допустимо", () => {
    assert.equal(validateConfig("AGENT_AUTONOMY_MAX", ""), null);
    assert.equal(validateConfig("LLM_PROVIDER", "   "), null);
  });

  it("валидирует по типу тумблера", () => {
    assert.equal(validateConfig("AGENT_AUTONOMY_MAX", "T2"), null);
    assert.match(validateConfig("AGENT_AUTONOMY_MAX", "T9") ?? "", /допустимо/);
    assert.equal(validateConfig("AGENTS_SCHEDULES_PAUSED", "0"), null);
    assert.match(validateConfig("AGENTS_SCHEDULES_PAUSED", "yes") ?? "", /допустимо/);
    assert.equal(validateConfig("AGENT_DAILY_BUDGET_USD", "3.5"), null);
    assert.match(validateConfig("AGENT_DAILY_BUDGET_USD", "-1") ?? "", /неотрицательное/);
    assert.equal(validateConfig("EMBED_BASE_URL", "http://100.1.2.3:8080"), null);
    assert.match(validateConfig("EMBED_BASE_URL", "ftp://x") ?? "", /URL/);
    assert.equal(validateConfig("LLM_PROVIDER", "claude-cli"), null);
    assert.match(validateConfig("LLM_PROVIDER", "gpt") ?? "", /допустимо/);
  });
});

describe("resolveEffective: приоритет база > env > дефолт", () => {
  const spec = specFor("AGENT_AUTONOMY_MAX")!;

  it("база важнее env", () => {
    const e = resolveEffective(spec, { AGENT_AUTONOMY_MAX: "T3" }, { AGENT_AUTONOMY_MAX: "T1" });
    assert.equal(e.value, "T3");
    assert.equal(e.source, "db");
  });

  it("нет базы → env", () => {
    const e = resolveEffective(spec, {}, { AGENT_AUTONOMY_MAX: "T1" });
    assert.equal(e.value, "T1");
    assert.equal(e.source, "env");
  });

  it("нет ни базы, ни env → дефолт", () => {
    const e = resolveEffective(spec, {}, {});
    assert.equal(e.value, "T0");
    assert.equal(e.source, "default");
  });

  it("пустое значение в базе не перекрывает env", () => {
    const e = resolveEffective(spec, { AGENT_AUTONOMY_MAX: "  " }, { AGENT_AUTONOMY_MAX: "T2" });
    assert.equal(e.value, "T2");
    assert.equal(e.source, "env");
  });

  it("resolveAll покрывает все тумблеры", () => {
    const all = resolveAll({}, {});
    assert.ok(all.length >= 10);
    assert.ok(all.every((i) => typeof i.value === "string" && i.source));
    // Секретов среди ключей нет.
    assert.ok(!all.some((i) => /API_KEY|TOKEN|SECRET|PASSWORD/i.test(i.key)));
  });
});
