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

  const счётчик = { select: 0 };
  const db = {
    select: () => ({
      from: (t: unknown) => {
        счётчик.select += 1;
        let текущие = rowsOf(t);
        const chain: Record<string, unknown> = {};
        chain.where = () => chain;
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
    assert.equal(h.parity.stockChecked, 0, "«сверять не по чему» обязано отличаться от «сверили и сошлось»");
  });

  it("сверенных пар остатков столько же, сколько насчитал паритет", async () => {
    const h = await сервис({}).health(20, СЕЙЧАС);
    assert.deepEqual([h.parity.stockOk, h.parity.stockChecked], [true, 14]);
  });

  it("мусорное число прогонов не роняет запрос и не читает всю таблицу", async () => {
    const runs = [УСПЕХ("r1", "2026-08-24T01:00:00Z")];
    assert.equal((await сервис({ runs }).health(0, СЕЙЧАС)).runs.length, 1);
    assert.equal((await сервис({ runs }).health(-5, СЕЙЧАС)).runs.length, 1);
    assert.equal((await сервис({ runs }).health(10_000, СЕЙЧАС)).runs.length, 1);
  });
});
