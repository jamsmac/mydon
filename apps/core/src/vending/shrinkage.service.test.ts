import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  entity,
  event,
  machineCard,
  machineSlot,
  sale,
  slotSnapshot,
  systemConfig,
  vendingAlias,
  vendingProduct,
  vendingRefill,
  vendingRefillEvent,
} from "@mydon/db";
import { ShrinkageService, деньТашкента, началоСутокТашкента } from "./shrinkage.service";
import { VendingService } from "./vending.service";

type SnapRow = {
  machineSerial: string;
  coilId: string;
  productName: string | null;
  capacity: number;
  quantity: number;
  capturedAt: Date;
};
type SaleRow = { dt: string; machineSerial: string; product: string; qty: string };
type EvRow = { machineSerial: string; windowTo: Date; units: number };
type HumanRow = { machineSerial: string; performedAt: Date; qty: number };
type SlotRow = {
  machineSerial: string;
  coilId: string;
  productName: string | null;
  capacity: number;
  quantity: number;
  syncedAt: Date;
};
type Ent = { id: string; name: string; externalRef: string | null; type: string };
type Card = { entityId: string; status: string };
type ProdRow = { id: string; name: string; purchasePrice: string | null; packSize: number };
type FeedRow = { source: string; type: string; payload: Record<string, unknown>; occurredAt: Date };

interface Мир {
  snapshots?: SnapRow[];
  sales?: SaleRow[];
  refillEvents?: EvRow[];
  refills?: HumanRow[];
  slots?: SlotRow[];
  products?: ProdRow[];
  entities?: Ent[];
  cards?: Card[];
  config?: { key: string; value: string }[];
  events?: FeedRow[];
  /** Выборка снимков по этому серийнику падает — проверка изоляции сбоя. */
  brokenSerial?: string;
}

/**
 * Значения-параметры из условия drizzle: стаб обязан отвечать НА ТО ЖЕ окно и
 * тот же серийник, которые просит сервис. Без этого проверялась бы не
 * выборка, а её отсутствие: ошибка в границе суток дедупа или в фильтре
 * свежести планограммы прошла бы зелёной (урок «заглушка врёт»).
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

const датаИз = (условие: unknown): Date | undefined =>
  параметры(условие).find((v): v is Date => v instanceof Date);
const строкиИз = (условие: unknown): string[] =>
  параметры(условие).filter((v): v is string => typeof v === "string");

function shrinkDb(м: Мир) {
  const лента: FeedRow[] = [...(м.events ?? [])];

  const rowsOf = (t: unknown): unknown[] =>
    t === slotSnapshot
      ? (м.snapshots ?? [])
      : t === sale
        ? (м.sales ?? [])
        : t === vendingRefillEvent
          ? (м.refillEvents ?? [])
          : t === vendingRefill
            ? (м.refills ?? [])
            : t === machineSlot
              ? (м.slots ?? [])
              : t === vendingProduct
                ? (м.products ?? [])
                : t === vendingAlias
                  ? []
                  : t === entity
                    ? (м.entities ?? [])
                    : t === machineCard
                      ? (м.cards ?? [])
                      : t === systemConfig
                        ? (м.config ?? [])
                        : t === event
                          ? лента
                          : [];

  const цепочка = (t: unknown, rows: unknown[]) => {
    let текущие = rows;
    let сгруппировано = false;
    const ответ = (): unknown[] =>
      сгруппировано
        ? [...new Set((текущие as SnapRow[]).map((r) => r.machineSerial))].map((serial) => ({ serial }))
        : текущие;
    const chain: Record<string, unknown> = {};
    chain.where = (условие: unknown) => {
      if (t === slotSnapshot) {
        const serial = строкиИз(условие)[0];
        if (serial !== undefined) {
          if (serial === м.brokenSerial) throw new Error("соединение оборвалось");
          текущие = (текущие as SnapRow[]).filter((r) => r.machineSerial === serial);
        }
      }
      if (t === machineSlot) {
        // Фильтр свежести планограммы: без него алерт «заканчивается» кричал
        // бы про автомат, переставший отдавать данные месяц назад.
        const с = датаИз(условие);
        if (с) текущие = (текущие as SlotRow[]).filter((r) => r.syncedAt.getTime() >= с.getTime());
      }
      if (t === event) {
        const с = датаИз(условие);
        const типы = строкиИз(условие);
        текущие = (текущие as FeedRow[]).filter(
          (r) => (!с || r.occurredAt.getTime() >= с.getTime()) && (типы.length === 0 || типы.includes(r.type)),
        );
      }
      return chain;
    };
    chain.groupBy = () => {
      сгруппировано = true;
      return chain;
    };
    chain.orderBy = () => chain;
    chain.limit = async () => ответ();
    chain.then = (res: (v: unknown) => unknown) => Promise.resolve(ответ()).then(res);
    return chain;
  };

  const insert = (t: unknown) => ({
    values: (v: Record<string, unknown> | Record<string, unknown>[]) => {
      if (t === event) {
        for (const r of Array.isArray(v) ? v : [v]) {
          // Время события в базе ставит default — стаб подставляет «сейчас»
          // теста, иначе окно дедупа проверять было бы нечем.
          const строка = r as unknown as Omit<FeedRow, "occurredAt"> & { occurredAt?: Date };
          лента.push({ ...строка, occurredAt: строка.occurredAt ?? СЕЙЧАС });
        }
      }
      return Promise.resolve();
    },
  });

  const db = {
    select: () => ({ from: (t: unknown) => цепочка(t, rowsOf(t)) }),
    insert,
    transaction: async <T>(cb: (t: { insert: typeof insert }) => Promise<T>): Promise<T> => cb({ insert }),
  } as never;

  return { db, лента };
}

const ЧАС = 3_600_000;
const СУТКИ = 86_400_000;

/**
 * «Сейчас» прибито гвоздями — полдень Ташкента. Прогон, пересекающий полночь,
 * иначе считал бы первую половину теста по одному периоду, а вторую по
 * другому (тот же класс флака, что артефакт фикстур детектора).
 */
const СЕЙЧАС = new Date("2026-08-25T07:00:00.000Z");

/** YYYY-MM-DD дня по Ташкенту со сдвигом в сутках от «сегодня». */
const день = (сдвиг: number): string => деньТашкента(new Date(СЕЙЧАС.getTime() + сдвиг * СУТКИ));

/** UTC-момент 00:00 Ташкента для даты. */
const начало = (д: string): Date => new Date(Date.parse(`${д}T00:00:00.000Z`) - 5 * ЧАС);

const снимок = (serial: string, capturedAt: Date, slots: [string, string | null, number, number][]): SnapRow[] =>
  slots.map(([coilId, productName, capacity, quantity]) => ({
    machineSerial: serial,
    coilId,
    productName,
    capacity,
    quantity,
    capturedAt,
  }));

const слот = (serial: string, coilId: string, productName: string, capacity: number, quantity: number, syncedAt = СЕЙЧАС): SlotRow => ({
  machineSerial: serial,
  coilId,
  productName,
  capacity,
  quantity,
  syncedAt,
});

const OLMA = "2508160376";
const РЕЕСТР: Ent[] = [{ id: "m-olma", name: "Olma", externalRef: "c2508160376", type: "machine" }];
const ПРАЙС: ProdRow[] = [{ id: "p1", name: "Snickers", purchasePrice: "11000", packSize: 1 }];

/**
 * Двое суток по Ташкенту с недостачей: 10 → 4 при продажах 4 (день −2, минус 2)
 * и 4 → 1 при продажах 2 (день −1, минус 1). Итого 3 шт × 11 000 = 33 000 сум.
 */
const СНИМКИ: SnapRow[] = [
  ...снимок(OLMA, начало(день(-2)), [["1", "Snickers", 10, 10]]),
  ...снимок(OLMA, начало(день(-1)), [["1", "Snickers", 10, 4]]),
  ...снимок(OLMA, начало(день(0)), [["1", "Snickers", 10, 1]]),
];

const ПРОДАЖИ: SaleRow[] = [
  { dt: день(-2), machineSerial: OLMA, product: "Snickers", qty: "4" },
  { dt: день(-1), machineSerial: OLMA, product: "Snickers", qty: "2" },
];

const базовыйМир = (): Мир => ({
  snapshots: СНИМКИ,
  sales: ПРОДАЖИ,
  products: ПРАЙС,
  entities: РЕЕСТР,
});

const сервис = (мир: Мир) => {
  const { db, лента } = shrinkDb(мир);
  return { svc: new ShrinkageService(db, new VendingService(db)), лента };
};

describe("Вендинг Core: усушка автомата по дням (П4)", () => {
  it("дни без заливки: недостача по позиции считается по закупочной цене и бьёт порог", async () => {
    const { svc } = сервис(базовыйМир());
    const отчёт = await svc.report(2, СЕЙЧАС);

    assert.equal(отчёт.from, день(-2));
    assert.equal(отчёт.to, день(-1));
    assert.equal(отчёт.threshold, 30_000, "дефолт SHRINK_ALERT_UZS");
    assert.equal(отчёт.machines.length, 1);
    const m = отчёт.machines[0]!;
    assert.equal(m.serial, OLMA);
    assert.equal(m.name, "Olma", "серийник в реестре с приставкой c — имя обязано сойтись");
    assert.equal(m.summary.daysCounted, 2);
    assert.equal(m.summary.daysSkipped, 0);
    assert.deepEqual(
      m.summary.items.map((i) => [i.product, i.lossUnits, i.lossValue, i.alert]),
      [["Snickers", 3, 33_000, true]],
    );
    assert.equal(отчёт.warnings.length, 0);
  });

  it("продажи в другом написании сшиваются со слотом, а не превращаются в недостачу", async () => {
    // Донор-риск: снимок присылает «Snickers», выгрузка продаж — «SNICKERS»,
    // алиаса на такую пару нет. При посимвольном сравнении продажи дня = 0, и
    // ВСЯ дневная выручка легла бы в недостачу — молча и с алертом.
    const мир = базовыйМир();
    мир.sales = [
      { dt: день(-2), machineSerial: OLMA, product: "SNICKERS", qty: "4" },
      { dt: день(-1), machineSerial: `c${OLMA}`, product: " snickers ", qty: "2" },
    ];
    const { svc } = сервис(мир);

    const m = (await svc.report(2, СЕЙЧАС)).machines[0]!;
    assert.deepEqual(
      m.summary.items.map((i) => [i.product, i.lossUnits]),
      [["Snickers", 3]],
      "имя показывается из прайса, а не служебным ключом",
    );
  });

  it("продажи по товару, которого нет в слотах, — отдельное предупреждение", async () => {
    const мир = базовыйМир();
    мир.sales = [...ПРОДАЖИ, { dt: день(-1), machineSerial: OLMA, product: "Загадка", qty: "3" }];
    const { svc } = сервис(мир);

    const w = (await svc.report(2, СЕЙЧАС)).warnings.filter((x) => x.code === "sales_unknown_product");
    assert.equal(w.length, 1);
    assert.ok(w[0]!.message.includes("Загадка"));
    assert.ok(w[0]!.message.includes("Olma"));
  });

  it("две формы серийника — один автомат, а не половина снимков в мусор", async () => {
    const мир = базовыйМир();
    мир.snapshots = [
      ...снимок(OLMA, начало(день(-2)), [["1", "Snickers", 10, 10]]),
      ...снимок(OLMA, начало(день(-1)), [["1", "Snickers", 10, 4]]),
      // Тот же автомат, но записанный с приставкой — раньше эта форма молча
      // выбрасывалась вместе со своим снимком, и день уезжал в snapshots_stale.
      ...снимок(`c${OLMA}`, начало(день(0)), [["1", "Snickers", 10, 1]]),
    ];
    const { svc } = сервис(мир);

    const отчёт = await svc.report(2, СЕЙЧАС);
    assert.equal(отчёт.machines.length, 1);
    assert.equal(отчёт.machines[0]!.summary.daysCounted, 2);
    assert.equal(отчёт.warnings.filter((w) => w.code === "snapshots_stale").length, 0);
  });

  it("сбой по одному автомату не уносит отчёт по остальным", async () => {
    const мир = базовыйМир();
    мир.snapshots = [...СНИМКИ, ...снимок("BROKEN", начало(день(-1)), [["1", "Snickers", 10, 5]])];
    мир.brokenSerial = "BROKEN";
    const { svc } = сервис(мир);

    const отчёт = await svc.report(2, СЕЙЧАС);
    assert.deepEqual(
      отчёт.machines.map((m) => m.serial),
      [OLMA],
      "живой автомат обязан остаться в отчёте",
    );
    const err = отчёт.warnings.filter((w) => w.code === "machine_error");
    assert.equal(err.length, 1);
    assert.ok(err[0]!.message.includes("BROKEN") || err[0]!.message.includes("соединение оборвалось"));
  });

  it("день с заливкой не считается, но виден строкой «приход по снимку / записано оператором»", async () => {
    const мир = базовыйМир();
    мир.refillEvents = [{ machineSerial: OLMA, windowTo: new Date(начало(день(-1)).getTime() + 10 * ЧАС), units: 12 }];
    мир.refills = [{ machineSerial: `c${OLMA}`, performedAt: new Date(начало(день(-1)).getTime() + 9 * ЧАС), qty: 5 }];
    const { svc } = сервис(мир);

    const m = (await svc.report(2, СЕЙЧАС)).machines[0]!;
    assert.equal(m.summary.daysCounted, 1);
    assert.equal(m.summary.daysSkipped, 1);
    assert.deepEqual(
      m.summary.items.map((i) => [i.product, i.lossUnits, i.lossValue, i.alert]),
      [["Snickers", 2, 22_000, false]],
      "день заливки выкинут целиком: приход и продажи гасятся внутри 3-часового окна",
    );
    assert.deepEqual(m.refillDays, [{ date: день(-1), detectedUnits: 12, recordedUnits: 5 }]);
  });

  it("нет снимка ближе 6 ч к границе суток — день пропущен, предупреждение одной строкой на автомат", async () => {
    const мир = базовыйМир();
    мир.snapshots = СНИМКИ.filter((r) => r.capturedAt.getTime() !== начало(день(-1)).getTime());
    const { svc } = сервис(мир);

    const отчёт = await svc.report(2, СЕЙЧАС);
    const stale = отчёт.warnings.filter((w) => w.code === "snapshots_stale");
    assert.equal(stale.length, 1, "одна строка на автомат, а не по строке на день");
    assert.ok(stale[0]!.message.includes("Olma"));
    assert.ok(stale[0]!.message.includes(день(-2)) && stale[0]!.message.includes(день(-1)));
    assert.equal(отчёт.machines[0]!.summary.daysCounted, 0);
  });

  it("нет продаж за день — день не считается (иначе несобранные продажи выглядят недостачей)", async () => {
    const мир = базовыйМир();
    мир.sales = ПРОДАЖИ.filter((r) => r.dt !== день(-1));
    const { svc } = сервис(мир);

    const отчёт = await svc.report(2, СЕЙЧАС);
    const w = отчёт.warnings.filter((x) => x.code === "no_sales_day");
    assert.equal(w.length, 1);
    assert.ok(w[0]!.message.includes(день(-1)));
    const m = отчёт.machines[0]!;
    assert.equal(m.summary.daysCounted, 1);
    assert.deepEqual(
      m.summary.items.map((i) => [i.product, i.lossUnits]),
      [["Snickers", 2]],
    );
  });

  it("мёртвый автомат (ёмкости вне диапазона) в отчёт не идёт — с причиной, а не молча", async () => {
    const мир = базовыйМир();
    const мёртвые: [string, string | null, number, number][] = Array.from({ length: 12 }, (_, i) => [
      String(i + 1),
      "SKLAD",
      199,
      199,
    ]);
    мир.snapshots = [
      ...СНИМКИ,
      ...снимок("SKLAD4S", начало(день(-2)), мёртвые),
      ...снимок("SKLAD4S", начало(день(-1)), мёртвые),
      ...снимок("SKLAD4S", начало(день(0)), мёртвые),
    ];
    мир.entities = [...РЕЕСТР, { id: "m-sklad", name: "SKLAD 4S", externalRef: "SKLAD4S", type: "machine" }];
    const { svc } = сервис(мир);

    const отчёт = await svc.report(2, СЕЙЧАС);
    assert.deepEqual(
      отчёт.machines.map((m) => m.serial),
      [OLMA],
    );
    const dead = отчёт.warnings.filter((w) => w.code === "machine_dead");
    assert.equal(dead.length, 1);
    assert.ok(dead[0]!.message.includes("SKLAD 4S"));
  });

  it("автомат не в строю в усушку не входит — его считают отдельно и не тревожат владельца", async () => {
    const мир = базовыйМир();
    мир.cards = [{ entityId: "m-olma", status: "repair" }];
    const { svc } = сервис(мир);

    assert.deepEqual((await svc.report(2, СЕЙЧАС)).machines, []);
  });

  it("порог берётся из настроек, а не из константы кода", async () => {
    const мир = базовыйМир();
    мир.refillEvents = [{ machineSerial: OLMA, windowTo: new Date(начало(день(-1)).getTime() + 10 * ЧАС), units: 12 }];
    мир.config = [{ key: "SHRINK_ALERT_UZS", value: "20000" }];
    const { svc } = сервис(мир);

    const отчёт = await svc.report(2, СЕЙЧАС);
    assert.equal(отчёт.threshold, 20_000);
    assert.equal(отчёт.machines[0]!.summary.items[0]!.alert, true, "22 000 ≥ 20 000");
  });
});

describe("Вендинг Core: суточные алерты усушки и низкого остатка (П4)", () => {
  it("позиция за порогом даёт событие; второй прогон за те же сутки дубля не даёт", async () => {
    const { svc, лента } = сервис(базовыйМир());

    const первый = await svc.alertDaily(СЕЙЧАС);
    assert.deepEqual(первый, { alerts: 1, lowStock: 0 });
    const ev = лента.find((e) => e.type === "vending.shrinkage_alert")!;
    assert.equal(ev.source, "system");
    assert.deepEqual(ev.payload, {
      serial: OLMA,
      name: "Olma",
      product: "Snickers",
      lossUnits: 3,
      lossValue: 33_000,
      days: 7,
    });

    const второй = await svc.alertDaily(СЕЙЧАС);
    assert.equal(второй.alerts, 0, "дедуп по (автомат, товар, сутки)");
    assert.equal(лента.filter((e) => e.type === "vending.shrinkage_alert").length, 1);
  });

  it("вчерашний алерт сегодняшний не гасит — дедуп ограничен сутками по Ташкенту", async () => {
    // Проверяет ИМЕННО границу окна: если бы дедуп смотрел «всю историю»,
    // владелец получил бы алерт один раз в жизни и больше никогда.
    const мир = базовыйМир();
    мир.events = [
      {
        source: "system",
        type: "vending.shrinkage_alert",
        payload: { serial: OLMA, product: "Snickers" },
        occurredAt: new Date(началоСутокТашкента(СЕЙЧАС).getTime() - 2 * ЧАС),
      },
    ];
    const { svc } = сервис(мир);

    assert.equal((await svc.alertDaily(СЕЙЧАС)).alerts, 1, "вчерашнее событие — вне окна дедупа");
  });

  it("низкий остаток: Σ штук ≤ 1 при Σ ёмкости ≥ 5 — событие для правила machine.low_stock", async () => {
    const мир: Мир = {
      entities: РЕЕСТР,
      slots: [
        слот(OLMA, "1", "Twix", 5, 1),
        слот(OLMA, "2", "Twix", 5, 0),
        слот(OLMA, "3", "Snickers", 10, 7),
      ],
    };
    const { svc, лента } = сервис(мир);

    assert.deepEqual(await svc.alertDaily(СЕЙЧАС), { alerts: 1, lowStock: 1 });
    const ev = лента.find((e) => e.type === "machine.low_stock")!;
    // `machine` читает правило уведомления, `serial` — ключ дедупа: два
    // аппарата с одинаковым именем не должны гасить алерты друг друга.
    assert.deepEqual(ev.payload, { machine: "Olma", serial: OLMA, product: "Twix", left: 1 });

    assert.equal((await svc.alertDaily(СЕЙЧАС)).alerts, 0, "дедуп по (автомат, товар, сутки)");
  });

  it("низкий остаток не срабатывает на мелкой пружине: Σ ёмкости < 5 — это не «заканчивается»", async () => {
    const мир: Мир = { entities: РЕЕСТР, slots: [слот(OLMA, "1", "Twix", 4, 0)] };
    const { svc, лента } = сервис(мир);

    assert.equal((await svc.alertDaily(СЕЙЧАС)).alerts, 0);
    assert.equal(лента.length, 0);
  });

  it("несвежая планограмма алертов не даёт: автомат перестал отдавать данные, а не опустел", async () => {
    const мир: Мир = {
      entities: РЕЕСТР,
      slots: [слот(OLMA, "1", "Twix", 20, 0, new Date(СЕЙЧАС.getTime() - 3 * СУТКИ))],
    };
    const { svc } = сервис(мир);

    assert.equal((await svc.alertDaily(СЕЙЧАС)).lowStock, 0);
  });

  it("мёртвая планограмма (ёмкости вне диапазона) алертов не даёт", async () => {
    const мир: Мир = {
      entities: РЕЕСТР,
      slots: Array.from({ length: 12 }, (_, i) => слот("SKLAD4S", String(i + 1), "SKLAD", 199, 0)),
    };
    const { svc } = сервис(мир);

    assert.equal((await svc.alertDaily(СЕЙЧАС)).lowStock, 0);
  });

  it("поток «заканчивается» обрезается потолком: пустая планограмма — сбой сбора, а не расход", async () => {
    const мир: Мир = {
      entities: РЕЕСТР,
      slots: Array.from({ length: 60 }, (_, i) => слот(OLMA, String(i + 1), `Товар ${i}`, 10, 0)),
    };
    const { svc } = сервис(мир);

    const итог = await svc.alertDaily(СЕЙЧАС);
    assert.equal(итог.lowStock, 50, "брифинг из полутора сотен строк не читает никто");
    assert.equal(итог.alerts, 50);
  });
});
