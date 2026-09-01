import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { event, llmModelPrice, systemConfig } from "@mydon/db";
import { accountingSource, resetAccountingSourceCache } from "../sales/accounting-source";
import { LLM_PROFILE_KEYS } from "./config-spec";
import { SystemService, validateLlmProfileState } from "./system.service";

/** Стаб БД: select() отдаёт пустой список оверрайдов, insert/delete — no-op. */
function stubDb(rows: { key: string; value: string }[] = []) {
  const писатель = {
    insert: () => ({
      values: () => ({ onConflictDoUpdate: async () => undefined }),
    }),
    delete: () => ({ where: async () => undefined }),
  };
  return {
    select: () => ({ from: async () => rows }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(писатель),
    ...писатель,
  } as never;
}

describe("SystemService.set(): валидация тумблеров (§ config-spec)", () => {
  it("неизвестный ключ — BadRequestException (400), не голый Error (найдено внешним аудитом, P2)", async () => {
    const svc = new SystemService(stubDb());
    await assert.rejects(
      () => svc.set("НЕСУЩЕСТВУЮЩИЙ_КЛЮЧ", "x"),
      (err: unknown) => {
        assert.ok(
          err instanceof BadRequestException,
          "должен быть BadRequestException, а не обычный Error",
        );
        return true;
      },
    );
  });

  it("невалидное значение для известного ключа — тоже BadRequestException", async () => {
    const svc = new SystemService(stubDb());
    await assert.rejects(
      () => svc.set("AGENT_AUTONOMY_MAX", "T99"),
      (err: unknown) => err instanceof BadRequestException,
    );
  });

  it("валидное значение — проходит, возвращает действующие тумблеры", async () => {
    const svc = new SystemService(stubDb());
    const result = await svc.set("AGENT_AUTONOMY_MAX", "T1", "owner");
    assert.ok(Array.isArray(result));
    assert.ok(result.some((r) => r.key === "AGENT_AUTONOMY_MAX"));
  });

  it("LLM-поле нельзя записать через старый одиночный endpoint", async () => {
    const svc = new SystemService(stubDb());
    await assert.rejects(
      () => svc.set("LLM_ENABLED", "1", "owner"),
      (err: unknown) =>
        err instanceof BadRequestException && /llm-profile/.test(String(err.message)),
    );
  });
});

function стендLlmПрофиля(
  начальные: Record<string, string> = {},
  цены: { model: string; validFrom: Date }[] = [],
) {
  const карта: Record<string, string> = { ...начальные };
  const записи: { key: string; value: string; updatedBy: string | null; через: "tx" | "db" }[] = [];
  const сбросы: { через: "tx" | "db" }[] = [];
  const замки: { через: "tx" | "db" }[] = [];
  let транзакций = 0;

  const писатель = (через: "tx" | "db") => ({
    execute: async () => {
      замки.push({ через });
    },
    // `from(llmModelPrice)` даёт chainable `.where()` (как настоящий query
    // builder ledger); прочие таблицы (system_config) — awaitable список строк.
    select: () => ({
      from: (table: unknown) =>
        table === llmModelPrice
          ? { where: async () => цены }
          : Object.entries(карта).map(([key, value]) => ({ key, value })),
    }),
    insert: (table: unknown) => ({
      values: (row: { key: string; value: string; updatedBy: string | null }) => {
        assert.equal(table, systemConfig);
        return {
          onConflictDoUpdate: async () => {
            карта[row.key] = row.value;
            записи.push({ key: row.key, value: row.value, updatedBy: row.updatedBy, через });
          },
        };
      },
    }),
    delete: () => ({
      where: async () => {
        сбросы.push({ через });
      },
    }),
  });
  const db = {
    ...писатель("db"),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      транзакций += 1;
      return fn(писатель("tx"));
    },
  } as never;
  return {
    svc: new SystemService(db),
    карта,
    записи,
    сбросы,
    замки,
    транзакций: () => транзакций,
  };
}

async function безLlmEnv(тело: () => Promise<void>): Promise<void> {
  const было = new Map<string, string | undefined>();
  for (const key of LLM_PROFILE_KEYS) {
    было.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    await тело();
  } finally {
    for (const key of LLM_PROFILE_KEYS) {
      const value = было.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("SystemService.setLlmProfile(): атомарный несекретный профиль", () => {
  it("openai-api и enabled пишутся одной транзакцией", async () => {
    await безLlmEnv(async () => {
      const { svc, карта, записи, сбросы, замки, транзакций } = стендLlmПрофиля();
      const result = await svc.setLlmProfile(
        [
          { key: "LLM_ENABLED", value: "1" },
          { key: "LLM_ROUTE", value: "openai-api" },
          { key: "LLM_MODEL", value: "gpt-5.6-sol" },
          { key: "LLM_BASE_URL", value: "https://api.openai.com/v1" },
          { key: "LLM_PRICE_PROVIDER_ID", value: "openai" },
          { key: "LLM_FALLBACK_MODELS", value: "" },
          { key: "LLM_GLOBAL_DAILY_BUDGET_USD", value: "10" },
          { key: "LLM_MAX_RESERVATION_USD", value: "3" },
        ],
        "owner:panel",
      );

      assert.equal(транзакций(), 1);
      assert.deepEqual(замки, [{ через: "tx" }]);
      assert.ok(
        записи.every((row) => row.через === "tx"),
        "ни одного write мимо tx",
      );
      assert.deepEqual(
        записи.map(({ key, value, updatedBy }) => ({ key, value, updatedBy })),
        [
          { key: "LLM_ENABLED", value: "1", updatedBy: "owner:panel" },
          { key: "LLM_ROUTE", value: "openai-api", updatedBy: "owner:panel" },
          { key: "LLM_MODEL", value: "gpt-5.6-sol", updatedBy: "owner:panel" },
          {
            key: "LLM_BASE_URL",
            value: "https://api.openai.com/v1",
            updatedBy: "owner:panel",
          },
          { key: "LLM_PRICE_PROVIDER_ID", value: "openai", updatedBy: "owner:panel" },
          { key: "LLM_GLOBAL_DAILY_BUDGET_USD", value: "10", updatedBy: "owner:panel" },
          { key: "LLM_MAX_RESERVATION_USD", value: "3", updatedBy: "owner:panel" },
        ],
      );
      assert.deepEqual(сбросы, [{ через: "tx" }], "пустой fallback сбрасывается в той же tx");
      assert.equal(карта.LLM_ENABLED, "1");
      assert.deepEqual(
        result.profile.map((item) => item.key),
        [...LLM_PROFILE_KEYS],
      );
      // Каталог пуст → метрируемый маршрут включён без действующей цены:
      // предупреждение видимое, но профиль всё равно сохранён (writes прошли).
      assert.match(result.warning ?? "", /нет действующей цены/);
      assert.match(result.warning ?? "", /openai\/gpt-5\.6-sol/);
    });
  });

  it("модель с действующей ценой в каталоге → без предупреждения", async () => {
    await безLlmEnv(async () => {
      const { svc } = стендLlmПрофиля({}, [
        { model: "gpt-5.6-sol", validFrom: new Date("2026-08-29T19:00:00.000Z") },
      ]);
      const result = await svc.setLlmProfile([
        { key: "LLM_ENABLED", value: "1" },
        { key: "LLM_ROUTE", value: "openai-api" },
        { key: "LLM_MODEL", value: "gpt-5.6-sol" },
        { key: "LLM_BASE_URL", value: "https://api.openai.com/v1" },
        { key: "LLM_PRICE_PROVIDER_ID", value: "openai" },
        { key: "LLM_GLOBAL_DAILY_BUDGET_USD", value: "10" },
        { key: "LLM_MAX_RESERVATION_USD", value: "3" },
      ]);
      assert.equal(result.warning, undefined);
      assert.deepEqual(
        result.profile.map((item) => item.key),
        [...LLM_PROFILE_KEYS],
      );
    });
  });

  it("выключенный LLM без цены не предупреждает (вызовов нет)", async () => {
    await безLlmEnv(async () => {
      const { svc } = стендLlmПрофиля();
      const result = await svc.setLlmProfile([
        { key: "LLM_ENABLED", value: "0" },
        { key: "LLM_ROUTE", value: "openai-api" },
        { key: "LLM_MODEL", value: "gpt-5.6-sol" },
        { key: "LLM_BASE_URL", value: "https://api.openai.com/v1" },
        { key: "LLM_PRICE_PROVIDER_ID", value: "openai" },
      ]);
      assert.equal(result.warning, undefined);
    });
  });

  it("секреты, чужие ключи и дубликаты отклоняет до транзакции", async () => {
    await безLlmEnv(async () => {
      for (const items of [
        [{ key: "LLM_API_KEY", value: "sk-secret" }],
        [{ key: "AGENT_DAILY_BUDGET_USD", value: "3" }],
        [
          { key: "LLM_MODEL", value: "gpt-5.6-sol" },
          { key: "LLM_MODEL", value: "gpt-5.6-sol" },
        ],
      ]) {
        const { svc, записи, транзакций } = стендLlmПрофиля();
        await assert.rejects(() => svc.setLlmProfile(items), BadRequestException);
        assert.equal(транзакций(), 0);
        assert.deepEqual(записи, []);
      }
    });
  });

  it("не включает codex-subscription и не пишет половину пачки", async () => {
    await безLlmEnv(async () => {
      const { svc, записи, карта } = стендLlmПрофиля();
      await assert.rejects(
        () =>
          svc.setLlmProfile([
            { key: "LLM_MODEL", value: "gpt-5.6-sol" },
            { key: "LLM_ROUTE", value: "codex-subscription" },
            { key: "LLM_ENABLED", value: "1" },
          ]),
        /codex-subscription/,
      );
      assert.deepEqual(записи, []);
      assert.deepEqual(карта, {});
    });
  });

  it("openai-api принимает только exact endpoint и pricing provider", () => {
    assert.match(
      validateLlmProfileState(
        { LLM_ROUTE: "openai-api", LLM_BASE_URL: "https://proxy.invalid/v1" },
        {},
      ) ?? "",
      /точное значение LLM_BASE_URL/,
    );
    assert.match(
      validateLlmProfileState({ LLM_ROUTE: "openai-api", LLM_PRICE_PROVIDER_ID: "custom" }, {}) ??
        "",
      /точное значение LLM_PRICE_PROVIDER_ID/,
    );
    assert.equal(
      validateLlmProfileState(
        {
          LLM_ROUTE: "openai-api",
          LLM_BASE_URL: "https://api.openai.com/v1",
          LLM_PRICE_PROVIDER_ID: "openai",
          LLM_ENABLED: "1",
        },
        {},
      ),
      null,
    );
  });
});

/**
 * Стенд настроек: `select()` отдаёт текущую карту оверрайдов, `insert`
 * в `system_config` её обновляет, `insert` в `event` копит записанные события.
 * Без живой карты «до/после» проверить смену действующего значения нечем —
 * стаб с пустым списком показал бы одно и то же в обеих точках.
 *
 * Каждая запись помечена ТЕМ ЖЕ, чем сделана: `tx` — через хэндл транзакции,
 * `db` — мимо неё. Иначе «обернули в транзакцию» проверяется только глазами, а
 * забытый `tx.` в одной из двух вставок выглядел бы точно так же зелёным.
 */
function стендНастроек(настройки: Record<string, string>) {
  const карта: Record<string, string> = { ...настройки };
  const события: {
    type: string;
    payload: Record<string, unknown>;
    occurredAt?: Date;
    через: "tx" | "db";
  }[] = [];
  const записи: { таблица: "system_config" | "event" | "?"; через: "tx" | "db" }[] = [];

  const писатель = (через: "tx" | "db") => ({
    insert: (t: unknown) => ({
      values: (v: {
        key?: string;
        value?: string;
        type?: string;
        payload?: Record<string, unknown>;
        occurredAt?: Date;
      }) => {
        if (t === event) {
          записи.push({ таблица: "event", через });
          // `occurredAt` копится тоже: событие флипа обязано быть датировано
          // моментом ЗАПИСИ, а не `now()` базы (конвенция ветки).
          события.push({
            type: String(v.type),
            payload: v.payload ?? {},
            occurredAt: v.occurredAt,
            через,
          });
          return Promise.resolve(undefined);
        }
        записи.push({ таблица: t === systemConfig ? "system_config" : "?", через });
        return {
          onConflictDoUpdate: async () => {
            карта[String(v.key)] = String(v.value);
          },
        };
      },
    }),
    delete: (t: unknown) => ({
      where: async () => {
        записи.push({ таблица: t === systemConfig ? "system_config" : "?", через });
        // Сброс тумблера: запись уходит, под ней снова видно env/дефолт.
        for (const k of Object.keys(карта)) delete карта[k];
      },
    }),
  });

  const db = {
    select: () => ({
      from: async () => Object.entries(карта).map(([key, value]) => ({ key, value })),
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(писатель("tx")),
    ...писатель("db"),
  } as never;
  return { svc: new SystemService(db), db, события, записи, карта };
}

/** Подменить переменную окружения на время одного теста. */
async function сПеременной(
  имя: string,
  значение: string | undefined,
  тело: () => Promise<void>,
): Promise<void> {
  const было = process.env[имя];
  if (значение === undefined) delete process.env[имя];
  else process.env[имя] = значение;
  try {
    await тело();
  } finally {
    if (было === undefined) delete process.env[имя];
    else process.env[имя] = было;
  }
}

describe("Флип источника учёта пишет событие (R-P8b-3)", () => {
  // ЗЕРКАЛО ЖИВО НА ВЕСЬ НАБОР. Без `STOCK_DATABASE_URL` действующий источник
  // равен `own` при ЛЮБОЙ настройке, и «смена» перестаёт быть сменой — событие
  // не эмитится по построению (это отдельный тест ниже). Изобразить настоящий
  // флип нечем, кроме переменной.
  const былURL = process.env.STOCK_DATABASE_URL;
  before(() => {
    process.env.STOCK_DATABASE_URL = "postgres://ro@stock/mydon";
    resetAccountingSourceCache();
  });
  after(() => {
    if (былURL === undefined) delete process.env.STOCK_DATABASE_URL;
    else process.env.STOCK_DATABASE_URL = былURL;
    resetAccountingSourceCache();
  });

  it("смена stock → own: событие с from/to/actor", async () => {
    const { svc, события } = стендНастроек({ OURVEND_ACCOUNTING_SOURCE: "stock" });
    await svc.set("OURVEND_ACCOUNTING_SOURCE", "own", "owner");
    assert.equal(события.length, 1);
    assert.equal(события[0]!.type, "ourvend.accounting_source_changed");
    assert.deepEqual(события[0]!.payload, {
      from: "stock",
      to: "own",
      effective: "own",
      actor: "owner",
    });
    assert.ok(события[0]!.occurredAt instanceof Date, "момент записи — явно, а не now() базы");
  });

  it("тумблер и событие — ОДНОЙ транзакцией, ни одной записи мимо неё", async () => {
    // Двумя операторами отказ вставки события оставил бы флип совершённым и
    // неозвученным: учёт уже читает другой источник, а в журнале ни строки.
    const { svc, записи } = стендНастроек({ OURVEND_ACCOUNTING_SOURCE: "stock" });
    await svc.set("OURVEND_ACCOUNTING_SOURCE", "own", "owner");
    assert.deepEqual(записи, [
      { таблица: "system_config", через: "tx" },
      { таблица: "event", через: "tx" },
    ]);
  });

  it("сброс тумблера тоже идёт транзакцией: delete и событие вместе", async () => {
    await сПеременной("OURVEND_ACCOUNTING_SOURCE", "own", async () => {
      const { svc, записи } = стендНастроек({ OURVEND_ACCOUNTING_SOURCE: "stock" });
      await svc.set("OURVEND_ACCOUNTING_SOURCE", "", "owner");
      assert.deepEqual(записи, [
        { таблица: "system_config", через: "tx" },
        { таблица: "event", через: "tx" },
      ]);
    });
  });

  it("запись того же значения событием не считается", async () => {
    const { svc, события } = стендНастроек({ OURVEND_ACCOUNTING_SOURCE: "own" });
    await svc.set("OURVEND_ACCOUNTING_SOURCE", "own", "owner");
    assert.equal(события.length, 0);
  });

  it("сброс тумблера — тоже смена, если под ним лежит другое env", async () => {
    // Сравниваем ДЕЙСТВУЮЩЕЕ значение, а не сырой ввод: пустая строка удаляет
    // запись, и наружу вылезает env — для учёта это такое же переключение.
    await сПеременной("OURVEND_ACCOUNTING_SOURCE", "own", async () => {
      const { svc, события } = стендНастроек({ OURVEND_ACCOUNTING_SOURCE: "stock" });
      await svc.set("OURVEND_ACCOUNTING_SOURCE", "", "owner");
      assert.equal(события.length, 1);
      assert.deepEqual(события[0]!.payload, {
        from: "stock",
        to: "own",
        effective: "own",
        actor: "owner",
      });
    });
  });

  it("actor не указан — null, а не выдуманное имя", async () => {
    const { svc, события } = стендНастроек({ OURVEND_ACCOUNTING_SOURCE: "stock" });
    await svc.set("OURVEND_ACCOUNTING_SOURCE", "own");
    assert.deepEqual(события[0]!.payload, {
      from: "stock",
      to: "own",
      effective: "own",
      actor: null,
    });
  });

  it("БЕЗ ЗЕРКАЛА СОБЫТИЯ НЕТ: действующий источник не менялся (R-FW/final-4)", async () => {
    // После шага 3 рунбука источник равен `own` при любой записи. Событие о
    // «переключении» и немедленное сообщение в Telegram там врали бы фактом
    // эмиссии: `accountingSource()` как отвечал `own`, так и отвечает.
    const былУрл = process.env.STOCK_DATABASE_URL;
    delete process.env.STOCK_DATABASE_URL;
    resetAccountingSourceCache();
    try {
      const { svc, события, записи } = стендНастроек({ OURVEND_ACCOUNTING_SOURCE: "own" });
      await svc.set("OURVEND_ACCOUNTING_SOURCE", "stock", "owner");
      assert.equal(события.length, 0, "запись есть, а переключения нет — событию взяться неоткуда");
      assert.deepEqual(
        записи,
        [{ таблица: "system_config", через: "tx" }],
        "сама настройка при этом сохраняется",
      );
    } finally {
      if (былУрл === undefined) delete process.env.STOCK_DATABASE_URL;
      else process.env.STOCK_DATABASE_URL = былУрл;
      resetAccountingSourceCache();
    }
  });

  it("панель видит ДЕЙСТВУЮЩИЙ источник рядом с записанным (R-FW-S5)", async () => {
    // После шага 3 рунбука `value` покажет `stock` (так записано), а учёт уже
    // свой — панель обязана показывать оба ответа, иначе экран катовера врёт.
    const былУрл = process.env.STOCK_DATABASE_URL;
    delete process.env.STOCK_DATABASE_URL;
    resetAccountingSourceCache();
    try {
      const { svc } = стендНастроек({ OURVEND_ACCOUNTING_SOURCE: "stock" });
      const строка = (await svc.effective()).find((i) => i.key === "OURVEND_ACCOUNTING_SOURCE");
      assert.deepEqual([строка?.value, строка?.effective], ["stock", "own"]);
    } finally {
      if (былУрл === undefined) delete process.env.STOCK_DATABASE_URL;
      else process.env.STOCK_DATABASE_URL = былУрл;
      resetAccountingSourceCache();
    }
  });

  it("другие тумблеры событий не порождают", async () => {
    const { svc, события, записи } = стендНастроек({});
    await svc.set("DEAD_STOCK_DAYS", "30", "owner");
    assert.equal(события.length, 0);
    assert.deepEqual(записи, [{ таблица: "system_config", через: "tx" }]);
  });

  it("флип сбрасывает кеш: синк видит новый источник, не дожидаясь минуты", async () => {
    // Ради этого R-P8b-3 и написан: владелец жмёт тумблер в панели, а не идёт
    // править .env и рестартовать Core. Без resetAccountingSourceCache() в
    // set() всё остальное в этом наборе остаётся зелёным, а ближайший прогон
    // синка ещё минуту читает ПРЕЖНИЙ источник.
    await сПеременной("STOCK_DATABASE_URL", "postgres://ro@stock/mydon", async () => {
      await сПеременной("OURVEND_ACCOUNTING_SOURCE", undefined, async () => {
        resetAccountingSourceCache();
        try {
          const { svc, db } = стендНастроек({ OURVEND_ACCOUNTING_SOURCE: "stock" });
          const момент = new Date("2026-08-26T09:00:00+05:00");
          // Прогрев: читатель (синк) закешировал прежний источник.
          assert.equal(await accountingSource(db, момент), "stock");
          await svc.set("OURVEND_ACCOUNTING_SOURCE", "own", "owner");
          // ТОТ ЖЕ момент времени — минута не прошла, и только сброс кеша
          // отличает «доехало сразу» от «доедет через минуту».
          assert.equal(await accountingSource(db, момент), "own");
        } finally {
          resetAccountingSourceCache();
        }
      });
    });
  });
});
