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

  it("маршрут вендинга: серийники через запятую, без «c» и без букв (A7)", () => {
    // Форма без приставки — канон `docs/DATA_SOURCES.md`. Приставку «c»
    // отвергаем на вводе, чтобы владелец увидел отказ сразу, а не искал потом,
    // почему маршрут «не применился».
    assert.equal(validateConfig("VENDING_ROUTE_ORDER", "2508160376, 2508160359"), null);
    assert.equal(validateConfig("VENDING_ROUTE_ORDER", "2508160376"), null);
    assert.match(validateConfig("VENDING_ROUTE_ORDER", "c2508160376") ?? "", /серийники/);
    assert.match(validateConfig("VENDING_ROUTE_ORDER", "abc") ?? "", /серийники/);
    assert.match(validateConfig("VENDING_ROUTE_ORDER", "2508160376,,2508160359") ?? "", /серийники/);
    // Пусто — сброс настройки (порядок по имени), это допустимо всегда.
    assert.equal(validateConfig("VENDING_ROUTE_ORDER", ""), null);
  });

  it("полевой контур (П4): пороги усушки и детектора заливки — неотрицательные числа", () => {
    assert.equal(validateConfig("SHRINK_ALERT_UZS", "30000"), null);
    assert.match(validateConfig("SHRINK_ALERT_UZS", "-1") ?? "", /неотрицательное/);
    assert.match(validateConfig("SHRINK_ALERT_UZS", "abc") ?? "", /неотрицательное/);
    assert.equal(validateConfig("REFILL_DETECT_MIN_UNITS", "10"), null);
    assert.match(validateConfig("REFILL_DETECT_MIN_UNITS", "-1") ?? "", /неотрицательное/);
    assert.match(validateConfig("REFILL_DETECT_MIN_UNITS", "abc") ?? "", /неотрицательное/);
  });
});

/**
 * Пороги аналитики снек-контура — настройки владельца, а не константы кода
 * (R-P5b-11). Ноль здесь — законное значение: «показывай любую маржу» и
 * «любой разрыв витрины» владелец включает нулём, а не правкой сервиса.
 */
describe("Ключи аналитики П5b (R-P5b-11)", () => {
  for (const [key, fallback] of [
    ["DEAD_STOCK_DAYS", "21"],
    ["PRICE_CHANGE_PCT", "5"],
    ["PRICE_GAP_PCT", "5"],
    ["COST_WINDOW_DAYS", "90"],
    ["MARGIN_LOW_PCT", "15"],
  ] as const) {
    it(`${key}: в белом списке, дефолт ${fallback}, отрицательное отвергается`, () => {
      assert.equal(specFor(key)?.fallback, fallback);
      assert.equal(validateConfig(key, "0"), null); // ноль — значение владельца, не мусор
      assert.ok(validateConfig(key, "-1"));
      assert.ok(validateConfig(key, "двадцать"));
    });
  }
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
