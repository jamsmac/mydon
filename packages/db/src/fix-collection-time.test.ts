import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TASHKENT_OFFSET_MS, tashkentDay } from "@mydon/shared";
import { ПРЕФИКС_КЛЮЧА } from "./backfill-collection-keys";
import { AUDIT_ACTION, EVENT_TYPE, FixTimeRefusal, fixCollectionTime, ташкентскийЧас } from "./fix-collection-time";
import { auditLog, event } from "./schema";

type Строка = {
  id: string;
  source: string;
  clientKey: string | null;
  collectedAt: Date;
  receivedAt: Date | null;
  amount: string | null;
  status: string;
};

const S = (over: Partial<Строка> = {}): Строка => ({
  id: "c1",
  source: "import",
  clientKey: ПРЕФИКС_КЛЮЧА + "d1",
  // 06:40 Ташкента — «оператор выехал в 06:40», хотя на самом деле 11:40.
  collectedAt: new Date("2026-01-30T01:40:42.626Z"),
  receivedAt: new Date("2026-01-30T05:00:00.000Z"),
  amount: "1250000.00",
  status: "received",
  ...over,
});

/** Значения-параметры из условия drizzle — та же техника, что в других тестах этого среза. */
function параметры(условие: unknown): unknown[] {
  const out: unknown[] = [];
  const walk = (n: unknown): void => {
    if (n === null || typeof n !== "object") return;
    const chunks = (n as { queryChunks?: unknown[] }).queryChunks;
    if (Array.isArray(chunks)) {
      for (const c of chunks) walk(c);
      return;
    }
    if ("value" in (n as Record<string, unknown>)) out.push((n as { value: unknown }).value);
  };
  walk(условие);
  return out;
}

/**
 * Стенд: одна таблица `collection`, журнал аудита и лента событий — массивами.
 * Таблицы различаются ПО ССЫЛКЕ (`t === collection`/`event`/`auditLog`), а не
 * по форме объекта: три РАЗНЫЕ count-запроса (застава 1 — collection, застава
 * 2 — event, застава 3 — auditLog) иначе неотличимы друг от друга, и опция
 * `события` протекла бы в подсчёт безКлюча.
 *
 * Транзакция настоящая по смыслу: `сорвать` роняет её посередине, и тест
 * проверяет, что снаружи не осталось ни одной сдвинутой строки.
 */
function стенд(
  строки: Строка[],
  опции: { события?: number; аудит?: number; сорватьНа?: number; локЗанят?: boolean } = {},
) {
  const аудит: Record<string, unknown>[] = [];
  const события: Record<string, unknown>[] = [];
  let обновлений = 0;
  const снимок = строки.map((r) => ({ ...r }));
  const состояние = строки.map((r) => ({ ...r }));
  const tx = {
    select: (поля?: Record<string, unknown>) => ({
      from: (t: unknown) => ({
        where: async () => {
          if (t === event) return [{ n: опции.события ?? 0 }];
          if (t === auditLog) return [{ n: опции.аудит ?? 0 }];
          // t === collection
          if (поля && "n" in поля) {
            return [{ n: состояние.filter((r) => r.source === "import" && r.clientKey === null).length }];
          }
          return состояние.filter((r) => r.source === "import" && (r.clientKey ?? "").startsWith(ПРЕФИКС_КЛЮЧА));
        },
      }),
    }),
    update: () => ({
      set: (patch: Partial<Строка>) => ({
        where: (условие: unknown) => ({
          returning: async () => {
            обновлений += 1;
            if (опции.сорватьНа === обновлений) throw new Error("падение посреди правки");
            const id = параметры(условие).find((v) => typeof v === "string" && состояние.some((r) => r.id === v));
            const цель = состояние.find((r) => r.id === id)!;
            Object.assign(цель, patch);
            return [{ ...цель }];
          },
        }),
      }),
    }),
    insert: (t: unknown) => ({
      values: async (v: Record<string, unknown>) => {
        if (t === auditLog) аудит.push(v);
        else if (t === event) события.push(v);
      },
    }),
    // advisory-лок: по умолчанию свободен. `опции.локЗанят` моделирует
    // конкурентный прогон, который уже держит его.
    execute: async () => [{ lock: !опции.локЗанят }],
  };
  const db = {
    ...tx,
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => {
      try {
        return await cb(tx);
      } catch (e) {
        // Откат: состояние возвращается к снимку — ровно то, что делает Postgres.
        состояние.splice(0, состояние.length, ...снимок.map((r) => ({ ...r })));
        аудит.length = 0;
        события.length = 0;
        throw e;
      }
    },
  } as never;
  return { db, аудит, события, состояние, счётчики: { события: опции.события ?? 0, аудит: опции.аудит ?? 0 } };
}

describe("Правка времени: множество доказано ключом, а не полем source (R-I-4)", () => {
  it("правятся только строки с `source='import'` И ключом донора", async () => {
    const { db, состояние } = стенд([S({ id: "c1" }), S({ id: "c2", source: "manual_history", clientKey: null })]);
    const о = await fixCollectionTime(db, { apply: true, expect: 1 });
    assert.equal(о.найдено, 1);
    assert.equal(о.правлено, 1);
    assert.equal(состояние[1]!.collectedAt.toISOString(), "2026-01-30T01:40:42.626Z", "manual_history не трогаем");
  });

  it("строка `source='import'` без ключа — отказ: происхождение не доказано", async () => {
    // `source` пускает клиент (`collections.controller.ts`), а ключ доказывает
    // происхождение. Обычно эта застава срабатывает там, где T2 упёрся в R-I-8.
    const { db } = стенд([S({ id: "c1" }), S({ id: "c9", clientKey: null })]);
    await assert.rejects(() => fixCollectionTime(db, { apply: true, expect: 1 }), FixTimeRefusal);
  });

  it("сдвиг берёт смещение из `tashkent-time`, а не из числа в скрипте", async () => {
    const было = new Date("2026-01-30T01:40:42.626Z");
    const { db, состояние } = стенд([S({ collectedAt: было })]);
    await fixCollectionTime(db, { apply: true, expect: 1 });
    assert.equal(состояние[0]!.collectedAt.getTime() - было.getTime(), TASHKENT_OFFSET_MS);
  });

  it("`received_at` сдвигается вместе с `collected_at`, `NULL` остаётся `NULL`", async () => {
    const { db, состояние } = стенд([
      S({ id: "c1", receivedAt: new Date("2026-01-30T05:00:00.000Z") }),
      S({ id: "c2", receivedAt: null, amount: null, status: "collected" }),
    ]);
    await fixCollectionTime(db, { apply: true, expect: 2 });
    assert.equal(состояние[0]!.receivedAt!.toISOString(), "2026-01-30T10:00:00.000Z");
    assert.equal(состояние[1]!.receivedAt, null);
    assert.equal(состояние[1]!.amount, null, "`amount IS NULL` — «ждёт приёма», а не ноль");
  });

  it("суммы и статусы до и после совпадают — правится время, не деньги", async () => {
    const { db } = стенд([S({ id: "c1" }), S({ id: "c2", status: "cancelled", amount: "3931000.00" })]);
    const о = await fixCollectionTime(db, { apply: true, expect: 2 });
    assert.deepEqual(о.суммыДо, о.суммыПосле);
  });

  it("ташкентские сутки не меняются ни у одной строки: часы 4–14 становятся 9–19", async () => {
    const { db, состояние } = стенд([
      S({ id: "c1", collectedAt: new Date("2026-01-29T23:00:00.000Z") }), // 04:00 Ташкента
      S({ id: "c2", collectedAt: new Date("2026-01-30T09:00:00.000Z") }), // 14:00 Ташкента
    ]);
    const о = await fixCollectionTime(db, { apply: true, expect: 2 });
    assert.deepEqual(о.часыДо, { мин: 4, макс: 14, сред: 9 });
    assert.deepEqual(о.часыПосле, { мин: 9, макс: 19, сред: 14 });
    assert.deepEqual(о.суткиДо, о.суткиПосле, "полночь не пересекает ни одна строка");
    assert.equal(tashkentDay(состояние[0]!.collectedAt), "2026-01-30");
  });

  it("`--dry-run` печатает те же числа и не пишет ни строки, ни отметки", async () => {
    const { db, состояние, аудит, события } = стенд([S()]);
    const о = await fixCollectionTime(db, { apply: false, expect: 1 });
    assert.equal(о.кПравке, 1);
    assert.equal(о.правлено, 0);
    assert.equal(состояние[0]!.collectedAt.toISOString(), "2026-01-30T01:40:42.626Z");
    assert.deepEqual([аудит.length, события.length], [0, 0]);
  });

  it("найдено не столько, сколько ожидалось, — остановка, а не флаг", async () => {
    const { db } = стенд([S()]);
    await assert.rejects(() => fixCollectionTime(db, { apply: true }), /найдено 1.*247/s);
  });
});

describe("Правка времени: заставы повторного прогона (R-I-4)", () => {
  it("отметка события в журнале останавливает повторный прогон", async () => {
    const { db } = стенд([S()], { события: 1 });
    await assert.rejects(() => fixCollectionTime(db, { apply: true, expect: 1 }), /cash\.collection_time_corrected/);
  });

  it("записи `collection.time_corrected` в аудите останавливают повторный прогон", async () => {
    const { db } = стенд([S()], { аудит: 1 });
    await assert.rejects(() => fixCollectionTime(db, { apply: true, expect: 1 }), /collection\.time_corrected/);
  });

  it("час больше 19 в множестве — отказ: данные выглядят уже сдвинутыми", async () => {
    // Ремень для правки ЧУЖОЙ рукой: после нашей отметки в наших таблицах есть
    // след, а после чужой — нет, и распределение часов остаётся единственным
    // свидетелем.
    const { db } = стенд([S({ collectedAt: new Date("2026-01-30T15:30:00.000Z") })]); // 20:30 Ташкента
    await assert.rejects(() => fixCollectionTime(db, { apply: true, expect: 1 }), /уже сдвинут/i);
  });

  it("advisory-лок занят конкурентным прогоном — отказ ДО единого UPDATE (TOCTOU, adversarial-ревью PR #221)", async () => {
    // Заставы 1–4 читают ВНЕ транзакции: между тем чтением и открытием
    // транзакции мог успеть закоммититься другой запуск. Лок берётся ПЕРВОЙ
    // строкой внутри транзакции — если он занят, ни одна строка не тронута.
    const { db, состояние, аудит, события } = стенд([S({ id: "c1" }), S({ id: "c2" })], { локЗанят: true });
    await assert.rejects(() => fixCollectionTime(db, { apply: true, expect: 2 }), /другой прогон.*advisory-лок/i);
    assert.deepEqual(
      состояние.map((r) => r.collectedAt.toISOString()),
      ["2026-01-30T01:40:42.626Z", "2026-01-30T01:40:42.626Z"],
      "занятый лок обязан остановить ДО первого UPDATE",
    );
    assert.deepEqual([аудит.length, события.length], [0, 0]);
  });
});

describe("Правка времени: след и транзакция (R-I-5)", () => {
  it("на каждую правленую строку — запись аудита с полными `before` и `after`", async () => {
    const { db, аудит } = стенд([S({ id: "c1" }), S({ id: "c2" })]);
    await fixCollectionTime(db, { apply: true, expect: 2 });
    assert.equal(аудит.length, 2);
    for (const a of аудит) {
      assert.equal(a.action, AUDIT_ACTION);
      assert.equal(a.actorKind, "system");
      assert.equal(a.actorRef, "script:fix-collection-time");
      // Полная строка, а не пара полей: `before` — единственный настоящий путь
      // отката 247 отметок времени (полный дамп откатывает 70 таблиц).
      assert.ok((a.before as Record<string, unknown>).amount !== undefined);
      assert.ok((a.after as Record<string, unknown>).status !== undefined);
    }
  });

  it("событие несёт число строк, границы и сам сдвиг в часах", async () => {
    const { db, события } = стенд([S()]);
    await fixCollectionTime(db, { apply: true, expect: 1, now: new Date("2026-08-27T05:00:00.000Z") });
    assert.equal(события.length, 1);
    assert.equal(события[0]!.source, "vendcash");
    assert.equal(события[0]!.type, EVENT_TYPE);
    // `hours` в отметке нужен потому, что скрипт разовый и однажды будет
    // удалён — отметка обязана рассказывать, НА СКОЛЬКО сдвинули.
    assert.deepEqual(события[0]!.payload, { rows: 1, from: "2026-01-30", to: "2026-01-30", hours: 5 });
    assert.equal(String(события[0]!.occurredAt), String(new Date("2026-08-27T05:00:00.000Z")));
  });

  it("правка и отметка едут одной транзакцией: падение на середине не оставляет половину строк сдвинутыми", async () => {
    const { db, состояние, аудит, события } = стенд([S({ id: "c1" }), S({ id: "c2" })], { сорватьНа: 2 });
    await assert.rejects(() => fixCollectionTime(db, { apply: true, expect: 2 }), /падение посреди правки/);
    assert.deepEqual(
      состояние.map((r) => r.collectedAt.toISOString()),
      ["2026-01-30T01:40:42.626Z", "2026-01-30T01:40:42.626Z"],
    );
    assert.deepEqual([аудит.length, события.length], [0, 0]);
  });
});

describe("Ташкентский час", () => {
  it("час считается по Ташкенту, а не по часам процесса", () => {
    assert.equal(ташкентскийЧас(new Date("2026-01-30T01:40:42.626Z")), 6);
    assert.equal(ташкентскийЧас(new Date("2026-01-29T19:00:00.000Z")), 0);
  });
});
