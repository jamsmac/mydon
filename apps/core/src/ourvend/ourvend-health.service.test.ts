import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ourvendSaleSnapshot, productSale, slotSnapshot, vendingSyncRun } from "@mydon/db";
import { OurvendHealthService } from "./ourvend-health.service";
import type { OurvendParityService } from "./ourvend-parity.service";

type Прогон = {
  id: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: "running" | "success" | "partial" | "failed";
  machinesTotal: number;
  machinesOk: number;
  error: string | null;
  durationMs: number | null;
};
type Снимок = { at: Date };

interface Мир {
  runs?: Прогон[];
  slots?: Снимок[];
  sales?: Снимок[];
  productSales?: Снимок[];
  parity?: Паритет;
}

type Паритет = Awaited<ReturnType<OurvendParityService["parity"]>>;

const ПАРИТЕТ_ОК: Паритет = {
  days: 7,
  checked: 14,
  ok: true,
  mismatches: [],
  ownRows: 14,
  note: null,
  stock: { days: 7, checked: 14, ok: true, mismatches: [], note: null },
};

/**
 * Стаб БД: `order by <время> desc` эмулируется НАСТОЯЩЕЙ сортировкой, а `limit`
 * — настоящей резкой. Отдай стаб фикстуру как есть — и «последний снимок»
 * проверялся бы порядком строк в тесте, а не кодом сервиса (урок «заглушка
 * врёт»).
 */
function healthDb(м: Мир) {
  const время = (t: unknown, r: unknown): number =>
    t === vendingSyncRun ? (r as Прогон).startedAt.getTime() : (r as Снимок).at.getTime();

  const rowsOf = (t: unknown): unknown[] =>
    t === vendingSyncRun
      ? (м.runs ?? [])
      : t === slotSnapshot
        ? (м.slots ?? [])
        : t === ourvendSaleSnapshot
          ? (м.sales ?? [])
          : t === productSale
            ? (м.productSales ?? [])
            : [];

  /** Значения-параметры из условия drizzle: стабу надо увидеть `status = 'success'`. */
  const параметры = (cond: unknown): unknown[] => {
    const out: unknown[] = [];
    const walk = (n: unknown): void => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) {
        for (const x of n) walk(x);
        return;
      }
      const chunks = (n as { queryChunks?: unknown[] }).queryChunks;
      if (Array.isArray(chunks)) {
        for (const c of chunks) walk(c);
        return;
      }
      const v = (n as { value?: unknown }).value;
      if (typeof v === "string" || typeof v === "number") out.push(v);
    };
    walk(cond);
    return out;
  };

  const счётчик = { select: 0 };
  const db = {
    select: () => ({
      from: (t: unknown) => {
        счётчик.select += 1;
        let текущие = rowsOf(t);
        const chain: Record<string, unknown> = {};
        // `where(eq(status, 'success'))` обязан ФИЛЬТРОВАТЬ: иначе «последний
        // успех» брался бы из последней строки журнала любого статуса, и
        // отдельный запрос проверялся бы как несуществующий.
        chain.where = (cond?: unknown) => {
          const статусы = параметры(cond).filter((v): v is string => typeof v === "string");
          if (t === vendingSyncRun && статусы.length > 0) {
            текущие = (текущие as Прогон[]).filter((r) => статусы.includes(r.status));
          }
          return chain;
        };
        chain.orderBy = () => {
          текущие = [...текущие].sort((a, b) => время(t, b) - время(t, a));
          return chain;
        };
        chain.limit = async (n: number) => текущие.slice(0, n);
        chain.then = (res: (v: unknown) => unknown) => Promise.resolve(текущие).then(res);
        return chain;
      },
    }),
  } as never;

  const parity = { parity: async () => м.parity ?? ПАРИТЕТ_ОК } as unknown as OurvendParityService;
  return { db, parity, счётчик };
}

const сервис = (м: Мир) => {
  const { db, parity } = healthDb(м);
  return new OurvendHealthService(db, parity);
};

const СЕЙЧАС = new Date("2026-08-25T07:00:00.000Z");

const прогон = (
  id: string,
  status: Прогон["status"],
  startedAt: string,
  finishedAt: string | null,
  error: string | null = null,
): Прогон => ({
  id,
  startedAt: new Date(startedAt),
  finishedAt: finishedAt === null ? null : new Date(finishedAt),
  status,
  machinesTotal: 2,
  machinesOk: status === "success" ? 2 : 0,
  error,
  durationMs: 10_000,
});

const ОТКАЗ = (id: string, at: string) => прогон(id, "failed", at, at, "This operation was aborted");
const УСПЕХ = (id: string, at: string) => прогон(id, "success", at, at);

describe("Здоровье сбора (R-P5b-8)", () => {
  it("считает серию отказов подряд и последний успех", async () => {
    const h = await сервис({
      runs: [
        ОТКАЗ("r3", "2026-08-25T04:00:00Z"),
        ОТКАЗ("r2", "2026-08-24T22:00:00Z"),
        УСПЕХ("r1", "2026-08-24T01:00:00Z"),
      ],
    }).health(20, СЕЙЧАС);

    assert.deepEqual([h.failedStreak, h.lastSuccessAt], [2, "2026-08-24T01:00:00.000Z"]);
    assert.deepEqual(
      h.runs.map((r) => r.id),
      ["r3", "r2", "r1"],
      "прогоны отдаются свежими сверху",
    );
  });

  it("успех датируется завершением, а не стартом", async () => {
    const h = await сервис({
      runs: [прогон("r1", "success", "2026-08-23T03:05:00Z", "2026-08-23T03:07:00Z")],
    }).health(20, СЕЙЧАС);
    assert.equal(h.lastSuccessAt, "2026-08-23T03:07:00.000Z");
  });

  it("снимков нет — лаг null, а не ноль (нулём читалось бы «свежо»)", async () => {
    const h = await сервис({ runs: [], slots: [], sales: [] }).health(20, СЕЙЧАС);
    assert.deepEqual([h.slotsLagMin, h.salesLagH, h.productSaleLagH, h.failedStreak], [null, null, null, 0]);
    assert.equal(h.lastSuccessAt, null);
  });

  it("лаг считается от самого свежего снимка: минуты для слотов, часы для продаж", async () => {
    const h = await сервис({
      slots: [{ at: new Date("2026-08-25T04:00:00Z") }, { at: new Date("2026-08-25T06:18:00Z") }],
      sales: [{ at: new Date("2026-08-25T04:00:00Z") }],
      productSales: [{ at: new Date("2026-08-25T02:30:00Z") }],
    }).health(20, СЕЙЧАС);

    assert.deepEqual([h.slotsLagMin, h.salesLagH, h.productSaleLagH], [42, 3, 4.5]);
  });

  it("серия считается по ВСЕМ прогонам, а показываются только запрошенные", async () => {
    const runs = Array.from({ length: 30 }, (_, i) =>
      ОТКАЗ(`r${i}`, new Date(Date.parse("2026-08-25T04:00:00Z") - i * 3_600_000).toISOString()),
    );
    const h = await сервис({ runs }).health(5, СЕЙЧАС);

    assert.equal(h.runs.length, 5, "показываем ровно столько, сколько просили");
    assert.equal(h.failedStreak, 30, "серия обрезанным списком не считается — иначе тревога занижена");
  });

  it("паритет всегда объект: расхождения числом, остатки отдельным флагом", async () => {
    const h = await сервис({
      parity: {
        ...ПАРИТЕТ_ОК,
        ok: false,
        mismatches: [
          { dt: "2026-08-24", serial: "2508160376", ownQty: 1, stockQty: 0, ownAmount: 1, stockAmount: 0, reason: "нет дня" },
        ],
        note: "остатки: снимков остатков OurVend за период нет",
        stock: { days: 7, checked: 0, ok: false, mismatches: [], note: "снимков остатков OurVend за период нет" },
      },
    }).health(20, СЕЙЧАС);

    assert.deepEqual(
      [h.parity.days, h.parity.ok, h.parity.mismatches, h.parity.stockOk],
      [7, false, 1, false],
    );
    assert.equal(h.parity.note, "остатки: снимков остатков OurVend за период нет");
    assert.deepEqual(
      [h.parity.checked, h.parity.stockChecked],
      [14, 0],
      "«сверять не по чему» обязано отличаться от «сверили и сошлось» — числом, а не текстом примечания",
    );
  });

  it("сверенных пар остатков столько же, сколько насчитал паритет", async () => {
    const h = await сервис({}).health(20, СЕЙЧАС);
    assert.deepEqual([h.parity.stockOk, h.parity.stockChecked, h.parity.checked], [true, 14, 14]);
  });

  it("последний успех НЕ теряется за окном показанных прогонов", async () => {
    // 250 почасовых отказов — это больше, чем читает счёт серии (200 строк).
    // Успех старше окна обязан найтись отдельным запросом, иначе поле станет
    // `null`, а бот напечатает «успехов не было», то есть «сбор не заводили».
    const успех = УСПЕХ("старый", "2026-08-01T00:00:00Z");
    const отказы = Array.from({ length: 250 }, (_, i) =>
      ОТКАЗ(`f${i}`, new Date(Date.parse("2026-08-25T06:00:00Z") - i * 3_600_000).toISOString()),
    );
    const h = await сервис({ runs: [...отказы, успех] }).health(20, СЕЙЧАС);

    assert.equal(h.failedStreak, 200, "серия считается по окну сканирования STREAK_SCAN_LIMIT");
    assert.equal(h.lastSuccessAt, "2026-08-01T00:00:00.000Z", "«успеха давно не было» ≠ «успехов не было вовсе»");
  });

  it("кеш минуты: повторный запрос в ту же минуту базу не трогает, следующая — трогает", async () => {
    const { db, parity, счётчик } = healthDb({ runs: [УСПЕХ("r1", "2026-08-25T06:00:00Z")] });
    const svc = new OurvendHealthService(db, parity);

    await svc.health(20, СЕЙЧАС);
    const было = счётчик.select;
    await svc.health(20, СЕЙЧАС);
    assert.equal(счётчик.select, было, "внутри минуты здоровье измениться не может — сбор ходит раз в три часа");

    await svc.health(20, new Date(СЕЙЧАС.getTime() + 61_000));
    assert.ok(счётчик.select > было, "в следующую минуту отчёт обязан пересчитаться: весь его смысл — свежесть");
  });

  it("мусорное число прогонов не роняет запрос и не читает всю таблицу", async () => {
    const runs = [УСПЕХ("r1", "2026-08-24T01:00:00Z")];
    assert.equal((await сервис({ runs }).health(0, СЕЙЧАС)).runs.length, 1);
    assert.equal((await сервис({ runs }).health(-5, СЕЙЧАС)).runs.length, 1);
    assert.equal((await сервис({ runs }).health(10_000, СЕЙЧАС)).runs.length, 1);
  });
});
