import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  entity,
  event,
  machineCard,
  slotSnapshot,
  systemConfig,
  vendingAlias,
  vendingProduct,
  vendingRefill,
  vendingRefillEvent,
} from "@mydon/db";
import { LIST_DAYS_MAX, RefillEventsService } from "./refill-events.service";
import { VendingService } from "./vending.service";

type SnapRow = {
  machineSerial: string;
  coilId: string;
  productName: string | null;
  capacity: number;
  quantity: number;
  capturedAt: Date;
};
type HumanRow = { id: string; machineSerial: string; performedAt: Date; qty: number };
type EventSlot = { coilId: string; product: string; before: number; after: number; delta: number };
type EventRow = {
  id: string;
  machineSerial: string;
  machineId: string | null;
  windowFrom: Date;
  windowTo: Date;
  units: number;
  slots: EventSlot[];
  matchedRefillId: string | null;
};
type Ent = { id: string; name: string; externalRef: string | null; type: string };
type Card = { entityId: string; status: string };
type AliasRow = { productId: string; alias: string };
type ProdRow = { id: string; name: string; purchasePrice: string | null; packSize: number };
type FeedRow = { source: string; type: string; payload: Record<string, unknown> };

interface Мир {
  snapshots?: SnapRow[];
  /** Записи оператора. Массив живой: тест дописывает их МЕЖДУ прогонами. */
  refills?: HumanRow[];
  /** Уже записанные события — «прошлые прогоны». */
  events?: EventRow[];
  aliases?: AliasRow[];
  products?: ProdRow[];
  entities?: Ent[];
  cards?: Card[];
  config?: { key: string; value: string }[];
}

/**
 * Границы окна из условия запроса — все даты, в порядке появления.
 *
 * Стаб обязан отвечать на выборку событий ТЕМ ЖЕ окном, что просит сервис:
 * ширина этого окна — предмет отдельного теста (запись, приклеенная к событию
 * чуть старше прогона, не должна подтверждать второе окно). Читаем значения
 * из `queryChunks` drizzle РЕКУРСИВНО: у `and(...)` они вложены, и плоский
 * обход возвращал бы «дат нет» на составном условии. Если структура изменится
 * — падаем громко, а не начинаем молча отдавать всё подряд.
 */
function границыОкна(условие: unknown): Date[] {
  const out: Date[] = [];
  const walk = (n: unknown): void => {
    if (n === null || typeof n !== "object") return;
    const chunks = (n as { queryChunks?: unknown[] }).queryChunks;
    if (Array.isArray(chunks)) {
      for (const c of chunks) walk(c);
      return;
    }
    const v = (n as { value?: unknown }).value;
    if (v instanceof Date) out.push(v);
  };
  walk(условие);
  if (out.length === 0) {
    throw new Error("стаб не смог прочитать границу окна из условия — изменилось внутреннее устройство drizzle");
  }
  return out;
}

/** Строковые параметры условия (серийник в разборе по автомату). */
function строкиИз(условие: unknown): string[] {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (n === null || typeof n !== "object") return;
    const chunks = (n as { queryChunks?: unknown[] }).queryChunks;
    if (Array.isArray(chunks)) {
      for (const c of chunks) walk(c);
      return;
    }
    const v = (n as { value?: unknown }).value;
    if (typeof v === "string") out.push(v);
  };
  walk(условие);
  return out;
}

/**
 * Стаб БД детектора: строки отдаются по ССЫЛКЕ на таблицу (как `planDb` в
 * vending.service.test.ts), но хранилище событий — живое. Идемпотентность
 * прогона проверяется настоящим уникальным ключом (serial, window_to), а не
 * заготовленным ответом: иначе второй прогон зеленел бы на любой реализации.
 */
function detectDb(м: Мир, опции: { онОкно?: (границы: Date[]) => void } = {}) {
  const события: EventRow[] = [...(м.events ?? [])];
  const лента: FeedRow[] = [];
  const обновления: Partial<EventRow>[] = [];
  let seq = 0;

  const rowsOf = (t: unknown): unknown[] =>
    t === slotSnapshot
      ? (м.snapshots ?? [])
      : // Лента живая: дедуп публикации читает УЖЕ НАПИСАННЫЕ события, и
        // заготовленный пустой ответ зеленел бы на любой реализации.
        t === event
        ? лента
        : t === vendingRefill
          ? (м.refills ?? [])
          : t === vendingAlias
            ? (м.aliases ?? [])
            : t === vendingProduct
              ? (м.products ?? [])
              : t === entity
                ? (м.entities ?? [])
                : t === machineCard
                  ? (м.cards ?? [])
                  : t === systemConfig
                    ? (м.config ?? [])
                    : [];

  const цепочка = (rows: unknown[], фильтр?: (условие: unknown) => unknown[]) => {
    const chain: Record<string, unknown> = {};
    let текущие = rows;
    let сгруппировано = false;
    // Детектор сначала спрашивает СПИСОК автоматов окна (groupBy), потом
    // читает снимки по одной ФОРМЕ серийника (иначе при окне в 30 суток весь
    // парк лёг бы в память разом). Стаб различает эти два запроса по условию,
    // а не по порядку вызовов: порядок зависит от того, сколько автоматов
    // сервис отсеял реестром, и счётчик вызовов молча разъезжался бы.
    const ответ = (): unknown[] =>
      сгруппировано ? [...new Set((текущие as SnapRow[]).map((r) => r.machineSerial))].map((serial) => ({ serial })) : текущие;
    const p = () => Promise.resolve(ответ());
    chain.where = (условие: unknown) => {
      if (фильтр) текущие = фильтр(условие);
      return chain;
    };
    chain.groupBy = () => {
      сгруппировано = true;
      return chain;
    };
    chain.orderBy = () => chain;
    chain.limit = async () => ответ();
    chain.then = (res: (v: unknown) => unknown) => p().then(res);
    return chain;
  };

  const insert = (t: unknown) => ({
    values: (v: Record<string, unknown> | Record<string, unknown>[]) => {
      if (t === event) {
        // Лента пишется ПАЧКОЙ (отдельный проход публикации), а не по строке
        // на вставку события журнала.
        for (const r of Array.isArray(v) ? v : [v]) лента.push(r as unknown as FeedRow);
        return Promise.resolve();
      }
      const строка = v as unknown as Omit<EventRow, "id">;
      return {
        onConflictDoNothing: () => ({
          returning: async () => {
            const дубль = события.some(
              (e) => e.machineSerial === строка.machineSerial && e.windowTo.getTime() === строка.windowTo.getTime(),
            );
            if (дубль) return [];
            const созданное: EventRow = { id: `ev${++seq}`, ...строка };
            события.push(созданное);
            return [созданное];
          },
        }),
      };
    },
  });

  const tx = {
    insert,
    update: () => ({
      set: (patch: Partial<EventRow>) => ({
        where: async () => {
          обновления.push(patch);
          // Применяем к первому несопоставленному: стаб не разбирает SQL-условие,
          // но хранилище должно оставаться правдой для следующего прогона.
          const цель = события.find((e) => e.matchedRefillId === null);
          if (цель && patch.matchedRefillId) цель.matchedRefillId = patch.matchedRefillId;
        },
      }),
    }),
  };

  const db = {
    select: () => ({
      from: (t: unknown) =>
        t === vendingRefillEvent
          ? цепочка(события, (условие) => {
              // Одна дата — выборка «уже записанного» окна прогона; две даты
              // (плюс `is null`) — кандидаты на публикацию в ленту: окно
              // закрылось дольше допуска назад, а записи оператора так и нет.
              const границы = границыОкна(условие);
              опции.онОкно?.(границы);
              return границы.length >= 2
                ? события.filter(
                    (e) =>
                      e.windowTo.getTime() >= границы[0]!.getTime() &&
                      e.windowTo.getTime() <= границы[1]!.getTime() &&
                      e.matchedRefillId === null,
                  )
                : события.filter((e) => e.windowTo.getTime() >= границы[0]!.getTime());
            })
          : t === slotSnapshot
            ? цепочка(м.snapshots ?? [], (условие) => {
                // Разбор идёт по ОДНОЙ форме серийника за запрос; список
                // автоматов окна условия по серийнику не несёт.
                const форма = строкиИз(условие)[0];
                return форма === undefined ? (м.snapshots ?? []) : (м.snapshots ?? []).filter((r) => r.machineSerial === форма);
              })
            : цепочка(rowsOf(t)),
    }),
    insert,
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
  } as never;

  return { db, события, лента, обновления };
}

const ЧАС = 3_600_000;
/**
 * Окно фикстуры — от ТЕКУЩЕГО момента: `detect(2)` смотрит на двое суток
 * назад, и снимки с прибитой датой оказались бы вне окна, как только его
 * начнут применять по-настоящему (стаб фильтрует события по дате).
 */
const T2 = new Date(Date.now() - ЧАС);
const T1 = new Date(T2.getTime() - 3 * ЧАС);

const снимок = (serial: string, capturedAt: Date, slots: [string, string | null, number, number][]): SnapRow[] =>
  slots.map(([coilId, productName, capacity, quantity]) => ({
    machineSerial: serial,
    coilId,
    productName,
    capacity,
    quantity,
    capturedAt,
  }));

/** Olma: два слота, между снимками +8 и +4 = 12 единиц (порог по умолчанию 10). */
const ЗАЛИВКА: SnapRow[] = [
  ...снимок("2508160376", T1, [
    ["1", "Snickers", 10, 2],
    ["2", "Twix", 10, 1],
  ]),
  ...снимок("2508160376", T2, [
    ["1", "Snickers", 10, 10],
    ["2", "Twix", 10, 5],
  ]),
];

const РЕЕСТР: Ent[] = [{ id: "m-olma", name: "Olma", externalRef: "c2508160376", type: "machine" }];

const сервис = (мир: Мир) => {
  const { db, события, лента, обновления } = detectDb(мир);
  return { svc: new RefillEventsService(db, new VendingService(db)), события, лента, обновления };
};

/**
 * Тонкая обёртка над тем же стендом: помимо сервиса отдаёт «окна» — все
 * границы, которые запрос `list()` подставил в условие (`границыОкна`, уже
 * читает их стенд выше). Тест «своего потолка чтения» (R-H-5) проверяет
 * ИМЕННО эту границу, а не форму ответа.
 */
const сервисЧтения = (мир: Мир) => {
  const окна: Date[] = [];
  const { db, события, лента, обновления } = detectDb(мир, { онОкно: (границы) => окна.push(...границы) });
  return { svc: new RefillEventsService(db, new VendingService(db)), окна, события, лента, обновления };
};

describe("Вендинг Core: детектор заливок по снимкам (П4)", () => {
  it("пара снимков с приходом ≥ порога даёт событие; второй прогон дубля не плодит", async () => {
    const { svc, события } = сервис({ snapshots: ЗАЛИВКА, entities: РЕЕСТР });

    const первый = await svc.detect(2);
    assert.equal(первый.machines, 1);
    assert.equal(первый.events, 1);
    assert.equal(первый.matched, 0);
    assert.deepEqual(первый.skipped, []);
    assert.equal(события.length, 1);
    assert.equal(события[0]!.units, 12);
    assert.equal(события[0]!.machineId, "m-olma", "серийник в реестре с приставкой c — привязка обязана сойтись");
    assert.deepEqual(
      события[0]!.slots.map((s) => [s.coilId, s.product, s.delta]),
      [
        ["1", "Snickers", 8],
        ["2", "Twix", 4],
      ],
    );

    // Крон бежит каждые 3 часа по перекрывающемуся окну — повтор обязан быть пустым.
    const второй = await svc.detect(2);
    assert.equal(второй.events, 0);
    assert.equal(события.length, 1);
  });

  it("приход ниже порога из настроек событием не становится", async () => {
    const { svc, события } = сервис({
      snapshots: ЗАЛИВКА,
      entities: РЕЕСТР,
      config: [{ key: "REFILL_DETECT_MIN_UNITS", value: "20" }],
    });
    const res = await svc.detect(2);
    assert.equal(res.events, 0);
    assert.equal(события.length, 0, "12 единиц при пороге 20 — это не заливка, а докладка пары пружин");
  });

  it("непрочитанный порог не роняет прогон: считаем по дефолту (в лог — предупреждение)", async () => {
    // Владелец вписал «десять» словом. Молча считать по дефолту нельзя — но и
    // отказывать в прогоне не за что: отчёт по дефолту лучше отсутствия отчёта.
    const { svc, события } = сервис({
      snapshots: ЗАЛИВКА,
      entities: РЕЕСТР,
      config: [{ key: "REFILL_DETECT_MIN_UNITS", value: "десять" }],
    });
    const res = await svc.detect(2);
    assert.equal(res.events, 1);
    assert.equal(события[0]!.units, 12);
  });

  it("заглушка источника уходит в skipped с причиной dead; полный живой автомат — нет", async () => {
    // SKLAD-заглушка отдаёт 199=199 по всем пружинам: ёмкость вне диапазона —
    // это «источник врёт», а не «автомат полон» (R-P4-4).
    const мёртвые: [string, string | null, number, number][] = Array.from({ length: 10 }, (_, i) => [
      String(i + 1),
      "Заглушка",
      199,
      199,
    ]);
    // А вот ЖИВОЙ автомат, только что заправленный под завязку: 12 слотов 5/5.
    // Он обязан остаться в осмотренных — прежнее правило выбрасывало его.
    const полный: [string, string | null, number, number][] = Array.from({ length: 12 }, (_, i) => [
      String(i + 1),
      "Snickers",
      5,
      5,
    ]);
    const { svc, события } = сервис({
      snapshots: [
        ...ЗАЛИВКА,
        ...снимок("SKLAD", T1, мёртвые),
        ...снимок("SKLAD", T2, мёртвые),
        ...снимок("FULL", T1, полный),
        ...снимок("FULL", T2, полный),
      ],
      entities: РЕЕСТР,
    });
    const res = await svc.detect(2);
    assert.deepEqual(res.skipped, [{ serial: "sklad", reason: "dead" }], "серийник в skipped — канон, как и в журнале");
    assert.equal(res.machines, 2, "заправленный под завязку автомат — осмотрен, а не мёртв");
    assert.equal(res.events, 1);
    assert.ok(!события.some((e) => e.machineSerial === "sklad"));
  });

  it("автомат без назначенных слотов молчит по своей причине", async () => {
    const пустые: [string, string | null, number, number][] = Array.from({ length: 3 }, (_, i) => [String(i + 1), null, 0, 0]);
    const { svc } = сервис({
      snapshots: [...ЗАЛИВКА, ...снимок("ПУСТОЙ", T1, пустые), ...снимок("ПУСТОЙ", T2, пустые)],
      entities: РЕЕСТР,
    });
    const res = await svc.detect(2);
    assert.deepEqual(res.skipped, [{ serial: "пустой", reason: "no_slots" }]);
  });

  it("причина берётся по самому свежему снимку, а не по смеси за двое суток", async () => {
    const пустые: [string, string | null, number, number][] = Array.from({ length: 3 }, (_, i) => [String(i + 1), null, 0, 0]);
    const мёртвые: [string, string | null, number, number][] = Array.from({ length: 10 }, (_, i) => [
      String(i + 1),
      "Заглушка",
      199,
      199,
    ]);
    const { svc } = сервис({
      // Вчера слоты были не назначены, сейчас источник отдаёт мусор — состояние
      // автомата сегодня «заглушка», а не «нет слотов».
      snapshots: [...ЗАЛИВКА, ...снимок("СМЕСЬ", T1, пустые), ...снимок("СМЕСЬ", T2, мёртвые)],
      entities: РЕЕСТР,
    });
    const res = await svc.detect(2);
    assert.deepEqual(res.skipped, [{ serial: "смесь", reason: "dead" }]);
  });

  it("запись оператора в окне ±3 ч сопоставляется с событием", async () => {
    const { svc, события, лента } = сервис({
      snapshots: ЗАЛИВКА,
      entities: РЕЕСТР,
      // Серийник записи — с приставкой «c» (так пишет бот), снимок — без неё.
      refills: [{ id: "r1", machineSerial: "c2508160376", performedAt: new Date(T2.getTime() - 30 * 60_000), qty: 12 }],
    });
    const res = await svc.detect(2);
    assert.equal(res.events, 1);
    assert.equal(res.matched, 1);
    assert.equal(события[0]!.matchedRefillId, "r1");
    assert.deepEqual(
      лента.filter((f) => f.type === "vending.refill_detected"),
      [],
      "оператор отчитался — будить владельца «заливкой без записи» не о чем",
    );
  });

  it("запись оператора мимо окна не сопоставляется, событие остаётся «без записи»", async () => {
    const { svc, события } = сервис({
      snapshots: ЗАЛИВКА,
      entities: РЕЕСТР,
      // На 4 часа раньше начала окна — это уже другой выезд (допуск 3 ч).
      refills: [{ id: "r1", machineSerial: "2508160376", performedAt: new Date(T1.getTime() - 4 * ЧАС), qty: 12 }],
    });
    const res = await svc.detect(2);
    assert.equal(res.matched, 0);
    assert.equal(события[0]!.matchedRefillId, null);
  });

  it("запись оператора, появившаяся ПОСЛЕ прогона, доклеивается на следующем", async () => {
    const refills: HumanRow[] = [];
    const { svc, события, обновления } = сервис({ snapshots: ЗАЛИВКА, entities: РЕЕСТР, refills });
    await svc.detect(2);
    assert.equal(события[0]!.matchedRefillId, null);

    // Оператор дошёл до бота через час — событие уже записано, дубля не будет,
    // и без доклейки запись осталась бы «заливкой без отчёта» навсегда.
    refills.push({ id: "r9", machineSerial: "2508160376", performedAt: new Date(T2.getTime() + ЧАС), qty: 12 });
    const второй = await svc.detect(2);
    assert.equal(второй.events, 0);
    assert.equal(второй.matched, 1);
    assert.deepEqual(обновления, [{ matchedRefillId: "r9" }]);
    assert.equal(события[0]!.matchedRefillId, "r9");
  });

  it("одна запись оператора не подтверждает два соседних окна", async () => {
    // Заливка на границе снимков попадает в допуск ±3 ч сразу двух окон.
    const T0 = new Date(T1.getTime() - 3 * ЧАС);
    const снимки = [
      ...снимок("2508160376", T0, [["1", "Snickers", 40, 0]]),
      ...снимок("2508160376", T1, [["1", "Snickers", 40, 12]]),
      ...снимок("2508160376", T2, [["1", "Snickers", 40, 24]]),
    ];
    const { svc, события } = сервис({
      snapshots: снимки,
      entities: РЕЕСТР,
      refills: [{ id: "r1", machineSerial: "2508160376", performedAt: new Date(T1.getTime() + 30 * 60_000), qty: 12 }],
    });
    const res = await svc.detect(2);
    assert.equal(res.events, 2);
    assert.equal(res.matched, 1, "выезд был один — подтверждать им оба окна значит удвоить отчёт");
    assert.equal(события.filter((e) => e.matchedRefillId === "r1").length, 1);
  });

  it("запись, приклеенная к событию ЧУТЬ старше окна прогона, второе окно не подтверждает", async () => {
    // Событие прошлого прогона на час старше границы окна (`от`), а запись
    // оператора ищется с `от − 3 ч`. Читая уже записанные события ровно по
    // `от`, детектор не увидел бы, что r1 уже занята, и приклеил бы её второй
    // раз — двойная отметка «подтверждено» по одному выезду.
    const now = Date.now();
    const старое: EventRow = {
      id: "ev-old",
      machineSerial: "2508160376",
      machineId: "m-olma",
      windowFrom: new Date(now - 52 * ЧАС),
      windowTo: new Date(now - 49 * ЧАС),
      units: 15,
      slots: [],
      matchedRefillId: "r1",
    };
    const снимки = [
      ...снимок("2508160376", new Date(now - 47 * ЧАС), [["1", "Snickers", 40, 0]]),
      ...снимок("2508160376", new Date(now - 46 * ЧАС), [["1", "Snickers", 40, 12]]),
    ];
    const { svc, события } = сервис({
      snapshots: снимки,
      entities: РЕЕСТР,
      events: [старое],
      refills: [{ id: "r1", machineSerial: "2508160376", performedAt: new Date(now - 49.5 * ЧАС), qty: 15 }],
    });
    const res = await svc.detect(2);
    assert.equal(res.events, 1);
    assert.equal(res.matched, 0, "запись уже подтвердила прошлое событие — второй раз она не считается");
    assert.equal(события.find((e) => e.id !== "ev-old")!.matchedRefillId, null);
  });

  it("имя товара в событии — канон через алиасы", async () => {
    const снимки = [
      ...снимок("2508160376", T1, [["1", "18+", 20, 0]]),
      ...снимок("2508160376", T2, [["1", "Montella", 20, 12]]),
    ];
    const { svc, события } = сервис({
      snapshots: снимки,
      entities: РЕЕСТР,
      aliases: [
        { productId: "p1", alias: "18+" },
        { productId: "p1", alias: "Montella" },
      ],
      products: [{ id: "p1", name: "Montella Вода минеральная 330ml", purchasePrice: "5000", packSize: 12 }],
    });
    const res = await svc.detect(2);
    assert.equal(res.events, 1, "два сырых имени одного товара — это НЕ смена товара в слоте");
    assert.equal(события[0]!.slots[0]!.product, "Montella Вода минеральная 330ml");
  });

  it("журнал событий отдаёт окно с именем автомата", async () => {
    const { svc } = сервис({ snapshots: ЗАЛИВКА, entities: РЕЕСТР });
    await svc.detect(2);
    const список = await svc.list(14);
    assert.equal(список.length, 1);
    assert.equal(список[0]!.serial, "2508160376");
    assert.equal(список[0]!.name, "Olma");
    assert.equal(список[0]!.units, 12);
    assert.equal(список[0]!.windowFrom, T1.toISOString());
    assert.equal(список[0]!.windowTo, T2.toISOString());
    assert.equal(список[0]!.matchedRefillId, null);
  });

  it("снимков нет — прогон пустой, а не падение", async () => {
    const { svc } = сервис({});
    assert.deepEqual(await svc.detect(2), { machines: 0, events: 0, matched: 0, skipped: [] });
  });

  it("автомат не в строю в детектор не идёт — в skipped с причиной not_in_service", async () => {
    // Склад-«автомат» приход по снимкам даёт постоянно: это разбор склада, а
    // не заливка маршрута, и каждые три часа он писал бы владельцу «причины».
    const { svc, события } = сервис({
      snapshots: ЗАЛИВКА,
      entities: РЕЕСТР,
      cards: [{ entityId: "m-olma", status: "warehouse" }],
    });
    const res = await svc.detect(2);
    assert.deepEqual(res.skipped, [{ serial: "2508160376", reason: "not_in_service" }]);
    assert.equal(res.machines, 0);
    assert.equal(события.length, 0);
  });

  it("две формы серийника — один автомат и ОДНО событие, а не два", async () => {
    // Уникальный индекс стоит на КОЛОНКЕ, а ключ идемпотентности считается по
    // канону: пиши мы сырую форму, «c2508160376» и «2508160376» дали бы две
    // строки на одно окно, и база бы их не поймала.
    const { svc, события } = сервис({
      snapshots: [
        ...снимок("2508160376", T1, [["1", "Snickers", 40, 2]]),
        ...снимок("c2508160376", T2, [["1", "Snickers", 40, 14]]),
      ],
      entities: РЕЕСТР,
    });
    const res = await svc.detect(2);
    assert.equal(res.machines, 1);
    assert.equal(res.events, 1);
    assert.equal(события.length, 1);
    assert.equal(события[0]!.machineSerial, "2508160376", "в журнале — канон");
    assert.equal(события[0]!.units, 12);
  });
});

describe("Вендинг Core: лента «заливка без записи» отдельным проходом (R-FW-9)", () => {
  /** Окно, закрывшееся `часов` назад: `MATCH_PAD_MS` = 3 ч. */
  const окноНазад = (часов: number): SnapRow[] => {
    const конец = new Date(Date.now() - часов * ЧАС);
    return [
      ...снимок("2508160376", new Date(конец.getTime() - 3 * ЧАС), [["1", "Snickers", 40, 2]]),
      ...снимок("2508160376", конец, [["1", "Snickers", 40, 14]]),
    ];
  };

  it("свежее окно события ленты не даёт: оператор ещё может дописать заливку", async () => {
    const { svc, события, лента } = сервис({ snapshots: окноНазад(1), entities: РЕЕСТР });
    const res = await svc.detect(2);
    assert.equal(res.events, 1, "в журнал заливка попала сразу");
    assert.equal(события.length, 1);
    assert.deepEqual(лента.filter((f) => f.type === "vending.refill_detected"), [], "будить владельца рано — допуск ещё не вышел");
  });

  it("окно старше допуска и без записи — событие ленты; повтор прогона второго не пишет", async () => {
    const { svc, лента } = сервис({ snapshots: окноНазад(4), entities: РЕЕСТР });
    await svc.detect(2);
    const строки = лента.filter((f) => f.type === "vending.refill_detected");
    assert.equal(строки.length, 1);
    assert.equal(строки[0]!.payload.recorded, false);
    assert.equal(строки[0]!.payload.serial, "2508160376");
    assert.equal(строки[0]!.payload.name, "Olma");
    assert.equal(строки[0]!.payload.units, 12);
    assert.ok(строки[0]!.payload.eventId, "eventId — ключ дедупа публикации");

    await svc.detect(2);
    assert.equal(лента.filter((f) => f.type === "vending.refill_detected").length, 1, "второй прогон дубля ленты не даёт");
  });

  it("окно старше допуска, но с записью оператора — ленте сказать нечего", async () => {
    const снимки = окноНазад(4);
    const конец = снимки[снимки.length - 1]!.capturedAt;
    const { svc, лента } = сервис({
      snapshots: снимки,
      entities: РЕЕСТР,
      refills: [{ id: "r1", machineSerial: "c2508160376", performedAt: new Date(конец.getTime() - 30 * 60_000), qty: 12 }],
    });
    const res = await svc.detect(2);
    assert.equal(res.matched, 1);
    assert.deepEqual(лента.filter((f) => f.type === "vending.refill_detected"), []);
  });
});

/**
 * `СЕЙЧАС` появляется здесь и остаётся: Task 6 переводит на него весь набор
 * (сейчас файл берёт «сейчас» неявно — `T2 = new Date(Date.now() - ЧАС)`,
 * `Date.now()` внутри стенда публикации, — но здесь `list()` уже принимает
 * его параметром, и тест обязан зафиксировать момент явно).
 */
const СЕЙЧАС = new Date();
/** Одна строка журнала — границы окна тесту не важны, важен сам факт запроса. */
const ЖУРНАЛ: EventRow[] = [
  {
    id: "ev-1",
    machineSerial: "2508160376",
    machineId: "m-olma",
    windowFrom: new Date(СЕЙЧАС.getTime() - 5 * ЧАС),
    windowTo: new Date(СЕЙЧАС.getTime() - 2 * ЧАС),
    units: 12,
    slots: [],
    matchedRefillId: null,
  },
];

describe("Окно ЧТЕНИЯ журнала — своё, а не потолок скана снимков (R-H-5)", () => {
  it("`?days=90` читается целиком: 90 — потолок журнала, 30 — потолок детектора", async () => {
    // Раньше `list()` зажимал окно чужим `DETECT_DAYS_MAX = 30`, и кнопка
    // «90 дн» в панели показала бы тридцать суток под подписью «90».
    const { svc, окна } = сервисЧтения({ events: ЖУРНАЛ });
    await svc.list(90, СЕЙЧАС);
    const от = окна.at(-1)!;
    assert.equal(Math.round((СЕЙЧАС.getTime() - от.getTime()) / 86_400_000), 90);
    assert.equal(LIST_DAYS_MAX, 90);
  });

  it("`?days=91` зажимается до 90, а не до 30", async () => {
    const { svc, окна } = сервисЧтения({ events: ЖУРНАЛ });
    await svc.list(91, СЕЙЧАС);
    assert.equal(Math.round((СЕЙЧАС.getTime() - окна.at(-1)!.getTime()) / 86_400_000), 90);
  });
});
