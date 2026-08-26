import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { Logger } from "@nestjs/common";
import { systemConfig } from "@mydon/db";
import {
  ACCOUNTING_SOURCE_CACHE_MS,
  accountingSource,
  resetAccountingSourceCache,
  resolveAccountingSource,
} from "./accounting-source";

/** Стенд БД: `select().from(systemConfig)` отдаёт заданные строки настроек. */
const стенд = (настройки: Record<string, string>) =>
  ({
    select: () => ({
      from: (t: unknown) =>
        Promise.resolve(
          t === systemConfig ? Object.entries(настройки).map(([key, value]) => ({ key, value })) : [],
        ),
    }),
  }) as never;

/** Подменить окружение на время одного теста и вернуть как было. */
async function сОкружением(env: Record<string, string | undefined>, тело: () => Promise<void>): Promise<void> {
  const было: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    было[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetAccountingSourceCache();
  try {
    await тело();
  } finally {
    for (const [k, v] of Object.entries(было)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetAccountingSourceCache();
  }
}

describe("Источник учёта (R-P8b-3)", () => {
  const ЗЕРКАЛО = { STOCK_DATABASE_URL: "postgres://ro@stock/mydon" };

  it("по умолчанию при живом зеркале — stock", () => {
    assert.equal(resolveAccountingSource("stock", ЗЕРКАЛО), "stock");
    assert.equal(resolveAccountingSource("", ЗЕРКАЛО), "stock");
  });

  it("настройка own переключает", () => {
    assert.equal(resolveAccountingSource("own", ЗЕРКАЛО), "own");
    assert.equal(resolveAccountingSource(" Own ", ЗЕРКАЛО), "own");
  });

  it("ФОЛБЭК: нет STOCK_DATABASE_URL — own, даже если настройка говорит stock", () => {
    // Зеркала нет — читать нечего. «stock без зеркала» означало бы вечные
    // {upserted: 0} без единого события: тихая остановка учёта вместо работы.
    assert.equal(resolveAccountingSource("stock", {}), "own");
    assert.equal(resolveAccountingSource("stock", { STOCK_DATABASE_URL: "  " }), "own");
  });

  it("мусор в настройке — stock, а не отказ: учёт не должен вставать из-за опечатки", () => {
    assert.equal(resolveAccountingSource("snapshot", ЗЕРКАЛО), "stock");
  });

  it("мусор в env не остаётся молчаливым: строка в лог + stock", async (t: TestContext) => {
    // PUT такое режет `oneOf`, а env — не режет никто: OURVEND_ACCOUNTING_SOURCE
    // =snapsot в .env даст stock, и при этом панель покажет в select вариант,
    // которого в списке нет. Прецедент репо — readIntSetting.
    const предупреждения: string[] = [];
    t.mock.method(Logger.prototype, "warn", (m: unknown) => {
      предупреждения.push(String(m));
    });
    await сОкружением({ ...ЗЕРКАЛО, OURVEND_ACCOUNTING_SOURCE: undefined }, async () => {
      assert.equal(await accountingSource(стенд({ OURVEND_ACCOUNTING_SOURCE: "snapsot" })), "stock");
    });
    assert.equal(предупреждения.length, 1, "непонятное значение обязано попасть в лог");
    assert.match(предупреждения[0]!, /snapsot/);
    assert.match(предупреждения[0]!, /stock, own/);
  });

  it("понятные значения лог не засоряют — предупреждение только на мусор", async (t: TestContext) => {
    const предупреждения: string[] = [];
    t.mock.method(Logger.prototype, "warn", (m: unknown) => {
      предупреждения.push(String(m));
    });
    await сОкружением({ ...ЗЕРКАЛО, OURVEND_ACCOUNTING_SOURCE: undefined }, async () => {
      assert.equal(await accountingSource(стенд({ OURVEND_ACCOUNTING_SOURCE: "own" })), "own");
      assert.equal(await accountingSource(стенд({}), new Date(Date.now() + 61_000)), "stock");
    });
    assert.deepEqual(предупреждения, []);
  });

  it("база важнее env: панель перекрывает переменную контейнера", async () => {
    await сОкружением({ ...ЗЕРКАЛО, OURVEND_ACCOUNTING_SOURCE: "stock" }, async () => {
      assert.equal(await accountingSource(стенд({ OURVEND_ACCOUNTING_SOURCE: "own" })), "own");
    });
  });

  it("нет записи в базе — читаем env (переменная осталась фолбэком)", async () => {
    await сОкружением({ ...ЗЕРКАЛО, OURVEND_ACCOUNTING_SOURCE: "own" }, async () => {
      assert.equal(await accountingSource(стенд({})), "own");
    });
  });

  it("ни базы, ни env, но зеркало живо — дефолт stock", async () => {
    await сОкружением({ ...ЗЕРКАЛО, OURVEND_ACCOUNTING_SOURCE: undefined }, async () => {
      assert.equal(await accountingSource(стенд({})), "stock");
    });
  });

  it("нет зеркала — own, что бы ни лежало в базе и в env", async () => {
    await сОкружением({ STOCK_DATABASE_URL: undefined, OURVEND_ACCOUNTING_SOURCE: "stock" }, async () => {
      assert.equal(await accountingSource(стенд({ OURVEND_ACCOUNTING_SOURCE: "stock" })), "own");
    });
  });

  it("кеш живёт минуту и не переживает её", async () => {
    await сОкружением({ ...ЗЕРКАЛО, OURVEND_ACCOUNTING_SOURCE: undefined }, async () => {
      const t0 = new Date("2026-08-26T08:00:00+05:00");
      assert.equal(await accountingSource(стенд({ OURVEND_ACCOUNTING_SOURCE: "stock" }), t0), "stock");
      // База уже сказала «own», но 30 с не прошли — читатель ещё видит прежнее.
      const позже = new Date(t0.getTime() + 30_000);
      assert.equal(await accountingSource(стенд({ OURVEND_ACCOUNTING_SOURCE: "own" }), позже), "stock");
      const минута = new Date(t0.getTime() + ACCOUNTING_SOURCE_CACHE_MS + 1_000);
      assert.equal(await accountingSource(стенд({ OURVEND_ACCOUNTING_SOURCE: "own" }), минута), "own");
    });
  });

  it("сброс кеша применяет флип немедленно — ради него сброс и зовёт SystemService.set", async () => {
    await сОкружением({ ...ЗЕРКАЛО, OURVEND_ACCOUNTING_SOURCE: undefined }, async () => {
      const t0 = new Date("2026-08-26T08:00:00+05:00");
      assert.equal(await accountingSource(стенд({ OURVEND_ACCOUNTING_SOURCE: "stock" }), t0), "stock");
      resetAccountingSourceCache();
      const через_секунду = new Date(t0.getTime() + 1_000);
      assert.equal(await accountingSource(стенд({ OURVEND_ACCOUNTING_SOURCE: "own" }), через_секунду), "own");
    });
  });
});
