import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { event, systemConfig } from "@mydon/db";
import { accountingSource, resetAccountingSourceCache } from "../sales/accounting-source";
import { SystemService } from "./system.service";

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
        assert.ok(err instanceof BadRequestException, "должен быть BadRequestException, а не обычный Error");
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
  const события: { type: string; payload: Record<string, unknown>; через: "tx" | "db" }[] = [];
  const записи: { таблица: "system_config" | "event" | "?"; через: "tx" | "db" }[] = [];

  const писатель = (через: "tx" | "db") => ({
    insert: (t: unknown) => ({
      values: (v: { key?: string; value?: string; type?: string; payload?: Record<string, unknown> }) => {
        if (t === event) {
          записи.push({ таблица: "event", через });
          события.push({ type: String(v.type), payload: v.payload ?? {}, через });
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
    select: () => ({ from: async () => Object.entries(карта).map(([key, value]) => ({ key, value })) }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(писатель("tx")),
    ...писатель("db"),
  } as never;
  return { svc: new SystemService(db), db, события, записи, карта };
}

/** Подменить переменную окружения на время одного теста. */
async function сПеременной(имя: string, значение: string | undefined, тело: () => Promise<void>): Promise<void> {
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
  it("смена stock → own: событие с from/to/actor", async () => {
    const { svc, события } = стендНастроек({ OURVEND_ACCOUNTING_SOURCE: "stock" });
    await svc.set("OURVEND_ACCOUNTING_SOURCE", "own", "owner");
    assert.equal(события.length, 1);
    assert.equal(события[0]!.type, "ourvend.accounting_source_changed");
    assert.deepEqual(события[0]!.payload, { from: "stock", to: "own", actor: "owner" });
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
      assert.deepEqual(события[0]!.payload, { from: "stock", to: "own", actor: "owner" });
    });
  });

  it("actor не указан — null, а не выдуманное имя", async () => {
    const { svc, события } = стендНастроек({ OURVEND_ACCOUNTING_SOURCE: "stock" });
    await svc.set("OURVEND_ACCOUNTING_SOURCE", "own");
    assert.deepEqual(события[0]!.payload, { from: "stock", to: "own", actor: null });
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
