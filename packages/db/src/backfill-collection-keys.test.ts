import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ПРЕФИКС_КЛЮЧА,
  backfillCollectionKeys,
  бэкфиллWhere,
  formatReport,
  ключСопоставления,
  нормализоватьКод,
  type DonorCollectionRow,
} from "./backfill-collection-keys";

/**
 * Значения-параметры из условия drizzle: та же техника, что в
 * `apps/core/src/vending/vending.service.test.ts` — `queryChunks` рекурсивно,
 * до листовых `.value`. Стенду это позволяет проверять НЕ только предикат
 * `бэкфиллWhere` отдельным юнит-тестом, но и то, что реализация зовёт его с
 * ПРАВИЛЬНЫМ id, не обновляя чужую строку.
 */
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

/** Текст SQL-выражения drizzle — та же техника, что в `backfill-product-ids.test.ts`. */
function текстSQL(x: unknown): string {
  if (x && typeof x === "object") {
    const chunks = (x as { queryChunks?: unknown[] }).queryChunks;
    if (Array.isArray(chunks)) return chunks.map(текстSQL).join("");
    const v = (x as { value?: unknown }).value;
    if (Array.isArray(v)) return v.join("");
    const name = (x as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return "";
}

function стендDb(наши: НашаСтрока[]) {
  return {
    select: () => ({ from: () => ({ leftJoin: () => ({ orderBy: async () => наши.map((r) => ({ ...r })) }) }) }),
    update: () => ({
      set: (patch: { clientKey: string }) => ({
        where: (условие: unknown) => ({
          returning: async () => {
            const id = параметры(условие).find((v) => typeof v === "string" && наши.some((r) => r.id === v));
            const цель = наши.find((r) => r.id === id && r.clientKey === null);
            if (!цель) return [];
            цель.clientKey = patch.clientKey;
            return [{ id: цель.id }];
          },
        }),
      }),
    }),
  } as never;
}

type НашаСтрока = {
  id: string;
  machineCode: string | null;
  collectedAt: Date;
  amount: string | null;
  status: string;
  clientKey: string | null;
};

const D = (over: Partial<DonorCollectionRow> = {}): DonorCollectionRow => ({
  id: "d1",
  machineCode: "5b7b181f0000",
  collectedAt: "2026-01-30 06:40:42.626",
  amount: "1250000.00",
  status: "received",
  ...over,
});

const M = (over: Partial<НашаСтрока> = {}): НашаСтрока => ({
  id: "m1",
  machineCode: "5b7b181f0000",
  collectedAt: new Date("2026-01-30T01:40:42.626Z"), // = 06:40 Ташкента: как прочитал прошлый импорт
  amount: "1250000.00",
  status: "received",
  clientKey: null,
  ...over,
});

const донор = (rows: DonorCollectionRow[]) => ({ collections: async () => rows });

describe("Бэкфилл ключей: предикат записи (R-I-2)", () => {
  it("предикат несёт client_key IS NULL — иначе повторный apply перезаписал бы ключ", () => {
    const выражение = текстSQL(бэкфиллWhere("m1"));
    assert.match(выражение, /client_key.*is null/i, "без этого условия повторный apply перезаписал бы ключ");
    assert.match(выражение, /id/, "без id в предикате обновились бы ВСЕ строки без ключа");
  });
});

describe("Бэкфилл ключей: правило сопоставления (R-I-3)", () => {
  it("момент донора читается как ташкентские настенные часы — пара находится", () => {
    assert.equal(
      ключСопоставления("5b7b181f0000", new Date("2026-01-30T01:40:42.626Z"), "1250000.00"),
      "5b7b181f0000|" + new Date("2026-01-30T01:40:42.626Z").getTime() + "|125000000",
    );
  });

  it("код в верхнем регистре и код, короткий на символ, нормализуются", () => {
    assert.equal(нормализоватьКод("7D9D181F0000"), "7d9d181f0000");
    assert.equal(нормализоватьКод("039ec91c000"), "039ec91c0000");
    assert.equal(нормализоватьКод("  "), null, "автомата без кода в ключе быть не может");
  });

  it("коды, различающиеся символом (…71f / …71e), НЕ сшиваются", () => {
    // Совпадение по количеству инкассаций доказывает, что автомат один, но
    // КАКОЙ из кодов настоящий, из данных не видно (R-I-8). Захардкодить
    // соответствие — значит запечь угадывание в ключ навсегда.
    assert.notEqual(нормализоватьКод("3be8c71f0000"), нормализоватьКод("3be8c71e0000"));
  });

  it("`amount IS NULL` совпадает с `amount IS NULL`, а не с нулём", () => {
    const at = new Date("2026-06-30T04:22:03.548Z");
    assert.equal(ключСопоставления("8da1181f0000", at, null), "8da1181f0000|" + at.getTime() + "|null");
    assert.notEqual(ключСопоставления("8da1181f0000", at, null), ключСопоставления("8da1181f0000", at, "0.00"));
  });
});

describe("Бэкфилл ключей: примерка и запись", () => {
  it("примерка не пишет ничего и печатает то же число «к записи», что запишет `--apply`", async () => {
    const наши = [M()];
    const примерка = await backfillCollectionKeys(стендDb(наши), донор([D()]), { apply: false });
    assert.equal(примерка.сопоставлено, 1);
    assert.equal(примерка.кЗаписи, 1);
    assert.equal(примерка.записано, 0);
    assert.equal(наши[0]!.clientKey, null, "примерка не трогает ни одной строки");

    const запись = await backfillCollectionKeys(стендDb(наши), донор([D()]), { apply: true });
    assert.equal(запись.кЗаписи, 1);
    assert.equal(запись.записано, 1);
    assert.equal(наши[0]!.clientKey, ПРЕФИКС_КЛЮЧА + "d1");
  });

  it("повторный `--apply` даёт «записано 0» — счёт по возвращённым строкам, а не по длине входа", async () => {
    const наши = [M({ clientKey: ПРЕФИКС_КЛЮЧА + "d1" })];
    const повтор = await backfillCollectionKeys(стендDb(наши), донор([D()]), { apply: true });
    assert.equal(повтор.сопоставлено, 1, "пара по-прежнему находится");
    assert.equal(повтор.кЗаписи, 0, "писать нечего: ключ уже стоит");
    assert.equal(повтор.записано, 0);
  });

  it("расхождение статуса паре не мешает, но печатается", async () => {
    // Строка 30.06.2026: `collected` у донора, `cancelled` у нас. Включи статус
    // в ключ — и получили бы ложное «нет пары» на строке, которая очевидно та же.
    const наши = [M({ status: "cancelled", amount: null })];
    const о = await backfillCollectionKeys(стендDb(наши), донор([D({ status: "collected", amount: null })]), { apply: false });
    assert.equal(о.сопоставлено, 1);
    assert.deepEqual(о.расхождениеСтатуса, [{ ourId: "m1", donorId: "d1", уНас: "cancelled", уДонора: "collected" }]);
  });

  it("две донорские строки с одним ключом — неоднозначность: не пишем ни одной, печатаем обе", async () => {
    // Тройной дубль на `fa86d006…` 30.01.2026 12:46 внесён владельцем НАМЕРЕННО
    // (Р-4 описи): схлопнуть его значит стереть след тройной ошибки ввода.
    const наши = [M({ id: "m1" }), M({ id: "m2" })];
    const о = await backfillCollectionKeys(
      стендDb(наши),
      донор([D({ id: "d1" }), D({ id: "d2" })]),
      { apply: true },
    );
    assert.equal(о.сопоставлено, 0);
    assert.equal(о.записано, 0);
    assert.equal(о.неоднозначно.length, 1);
    assert.deepEqual(о.неоднозначно[0]!.донор.sort(), ["d1", "d2"]);
    assert.deepEqual(о.неоднозначно[0]!.наши.sort(), ["m1", "m2"]);
    assert.deepEqual(наши.map((r) => r.clientKey), [null, null]);
  });

  it("строки без пары уезжают в отчёт обеими сторонами, с кодом и моментом", async () => {
    const наши = [M({ id: "m7", machineCode: "3be8c71e0000" })];
    const о = await backfillCollectionKeys(
      стендDb(наши),
      донор([D({ id: "d7", machineCode: "3be8c71f0000" })]),
      { apply: true },
    );
    assert.equal(о.сопоставлено, 0);
    assert.deepEqual(о.безПарыДонор.map((r) => [r.id, r.code]), [["d7", "3be8c71f0000"]]);
    assert.deepEqual(о.безПарыНаши.map((r) => [r.id, r.code]), [["m7", "3be8c71e0000"]]);
  });

  it("пустая примерка говорит словами, а не молчит", async () => {
    const о = await backfillCollectionKeys(стендDb([]), донор([]), { apply: false });
    assert.equal(о.уДонора, 0);
    assert.equal(о.уНас, 0);
    assert.equal(о.кЗаписи, 0);
    assert.match(formatReport(о), /нечего писать/i);
  });
});
