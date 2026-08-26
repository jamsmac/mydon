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
  });

  it("окна аналитики не принимают ноль, пороги в процентах — принимают", () => {
    // `DEAD_STOCK_DAYS=0` уходит в дефолт 21 (`clamp`), `COST_WINDOW_DAYS=0` —
    // в единицу (`Math.max(1, …)`): панель сказала бы «сохранено», а отчёт
    // посчитался бы по другому числу.
    assert.match(validateConfig("DEAD_STOCK_DAYS", "0") ?? "", /от 1/);
    assert.match(validateConfig("COST_WINDOW_DAYS", "0") ?? "", /от 1/);
    assert.match(validateConfig("DEAD_STOCK_DAYS", "-3") ?? "", /от 1/);
    assert.equal(validateConfig("DEAD_STOCK_DAYS", "21"), null);
    assert.equal(validateConfig("COST_WINDOW_DAYS", "90"), null);
    // Пустое — это сброс к env/дефолту, оно допустимо всегда.
    assert.equal(validateConfig("DEAD_STOCK_DAYS", ""), null);

    // А вот у порогов в процентах ноль — законное «показывай всё».
    for (const key of ["PRICE_CHANGE_PCT", "PRICE_GAP_PCT", "MARGIN_LOW_PCT"]) {
      assert.equal(validateConfig(key, "0"), null, `${key}: ноль обязан приниматься`);
    }
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
 * (R-P5b-11). Ноль — законное значение У ПОРОГОВ В ПРОЦЕНТАХ: «показывай любую
 * маржу» и «любой разрыв витрины» владелец включает нулём, а не правкой
 * сервиса. У ОКОН В СУТКАХ ноль смысла не имеет и молча уходил бы в другое
 * число (см. `posNumber` в `config-spec.ts`).
 */
describe("Ключи аналитики П5b (R-P5b-11)", () => {
  for (const [key, fallback, нольЗаконен] of [
    ["DEAD_STOCK_DAYS", "21", false],
    ["PRICE_CHANGE_PCT", "5", true],
    ["PRICE_GAP_PCT", "5", true],
    ["COST_WINDOW_DAYS", "90", false],
    ["MARGIN_LOW_PCT", "15", true],
  ] as const) {
    it(`${key}: в белом списке, дефолт ${fallback}, отрицательное отвергается`, () => {
      assert.equal(specFor(key)?.fallback, fallback);
      if (нольЗаконен) assert.equal(validateConfig(key, "0"), null); // ноль — значение владельца, не мусор
      else assert.ok(validateConfig(key, "0"), "нулевое окно молча уехало бы в другое число");
      assert.ok(validateConfig(key, "-1"));
      assert.ok(validateConfig(key, "двадцать"));
    });
  }
});

describe("Ключ сторожа сбора П8a (R-P8a-6)", () => {
  it("SYNC_STALE_HOURS: дефолт 6, ноль и отрицательное отвергаются", () => {
    assert.equal(specFor("SYNC_STALE_HOURS")?.fallback, "6");
    // Ноль здесь не «показывай всё», а «тревога каждые полчаса навсегда»:
    // окно в часах нулём не выключается (тот же довод, что у posNumber).
    assert.ok(validateConfig("SYNC_STALE_HOURS", "0"));
    assert.ok(validateConfig("SYNC_STALE_HOURS", "-1"));
    assert.ok(validateConfig("SYNC_STALE_HOURS", "шесть"));
    assert.equal(validateConfig("SYNC_STALE_HOURS", "12"), null);
  });
});

describe("Ключи катовера П8b (R-P8b-3, R-P8b-7)", () => {
  it("OURVEND_ACCOUNTING_SOURCE: select из двух значений, дефолт stock", () => {
    assert.equal(specFor("OURVEND_ACCOUNTING_SOURCE")?.fallback, "stock");
    assert.deepEqual(specFor("OURVEND_ACCOUNTING_SOURCE")?.options, ["stock", "own"]);
    assert.equal(validateConfig("OURVEND_ACCOUNTING_SOURCE", "own"), null);
    assert.match(validateConfig("OURVEND_ACCOUNTING_SOURCE", "OWN") ?? "", /допустимо/);
    assert.match(validateConfig("OURVEND_ACCOUNTING_SOURCE", "snapshot") ?? "", /допустимо/);
  });

  it("CUTOVER_GREEN_DAYS и SNAPSHOT_STALE_HOURS: окна, ноль не значит «без окна»", () => {
    assert.equal(specFor("CUTOVER_GREEN_DAYS")?.fallback, "7");
    assert.equal(specFor("SNAPSHOT_STALE_HOURS")?.fallback, "36");
    for (const k of ["CUTOVER_GREEN_DAYS", "SNAPSHOT_STALE_HOURS"]) {
      assert.ok(validateConfig(k, "0"), `${k}: нулевое окно молча уехало бы в другое число`);
      assert.ok(validateConfig(k, "-1"));
    }
  });

  it("SNAPSHOT_RETENTION_DAYS: пол 90 суток — окно уже мёртвого стока стирало бы отчёты", () => {
    // DEAD_STOCK_DAYS_MAX=180 (analytics.service.ts:89) — самый широкий живой
    // потребитель. Ретенция в 30 суток «сохранилась бы» в панели и молча
    // выпилила данные под уже работающим отчётом.
    assert.equal(specFor("SNAPSHOT_RETENTION_DAYS")?.fallback, "180");
    assert.ok(validateConfig("SNAPSHOT_RETENTION_DAYS", "30"));
    assert.equal(validateConfig("SNAPSHOT_RETENTION_DAYS", "180"), null);
    assert.equal(validateConfig("SNAPSHOT_RETENTION_DAYS", "365"), null);
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
